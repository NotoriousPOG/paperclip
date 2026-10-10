import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import type {
  CompanySkillInspection,
  CompanySkillInspectionFinding,
  CompanySkillInspectionRecommendation,
  CompanySkillInspectionStatus,
} from "@paperclipai/shared";
import { assertSkillSnapshotPath, skillFileBytes } from "./skill-snapshot.js";

// Optional integration with NVIDIA SkillSpector (https://github.com/NVIDIA/skillspector).
// Static scan only: the skill is not executed and its contents are not sent to a model
// (`--no-llm`). The supply-chain rule may send dependency names to OSV.

const FINDING_LIMIT = 12;
const DEFAULT_TIMEOUT_MS = 60_000;
const SCAN_CONCURRENCY = 3;
const CACHE_LIMIT = 256;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const PASSTHROUGH_ENV = [
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
];
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const RECOMMENDATIONS = new Set<CompanySkillInspectionRecommendation>(["SAFE", "CAUTION", "DO_NOT_INSTALL"]);
const UNAVAILABLE_MESSAGE = "SkillSpector is not installed on this Paperclip server, so this skill was not inspected.";

export type SkillInspectionFile = { path: string; content: string; encoding?: string };

type ScanRun = { spawnCode: string | null; timedOut: boolean };
type ParsedReport = Pick<CompanySkillInspection, "score" | "severity" | "recommendation" | "findings"> & {
  totalFindings: number;
};

const cache = new Map<string, CompanySkillInspection>();

function isExecutable(file: string) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `SKILLSPECTOR_BIN` wins; otherwise the first `skillspector` on PATH. Null disables inspection. */
export function resolveSkillSpectorBin(): string | null {
  const fromEnv = process.env.SKILLSPECTOR_BIN?.trim();
  if (fromEnv) return isExecutable(fromEnv) ? fromEnv : null;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "skillspector");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Hold an install unless SkillSpector calls it SAFE. In static mode SkillSpector rates most
 * real attacks (curl | sh, credential exfiltration, reverse shells) CAUTION, not DO_NOT_INSTALL,
 * so CAUTION must hold too. A HIGH or CRITICAL finding holds even under a SAFE aggregate,
 * and a scan that did not finish holds (fail closed).
 */
export function inspectionBlocks(
  inspection: Pick<CompanySkillInspection, "status" | "recommendation" | "score" | "findings">,
) {
  if (inspection.status === "error") return true;
  if (inspection.status !== "findings" && inspection.status !== "clean") return false;
  if (inspection.findings.some((finding) => (SEVERITY_RANK[finding.severity] ?? 0) >= SEVERITY_RANK.HIGH!)) return true;
  if (inspection.recommendation) return inspection.recommendation !== "SAFE";
  return inspection.score !== null && inspection.score > 20;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3)}...`;
}

export function parseSkillSpectorReport(raw: unknown): ParsedReport | null {
  const report = asRecord(raw);
  if (!report || report.execution_successful === false) return null;
  const risk = asRecord(report.risk_assessment);
  const score = typeof risk?.score === "number" && Number.isFinite(risk.score) ? risk.score : null;
  const severity = typeof risk?.severity === "string" ? risk.severity : null;
  const recommendation = typeof risk?.recommendation === "string"
    && RECOMMENDATIONS.has(risk.recommendation as CompanySkillInspectionRecommendation)
    ? risk.recommendation as CompanySkillInspectionRecommendation
    : null;
  const issues = Array.isArray(report.issues) ? report.issues : null;
  if (score === null && issues === null) return null;
  const findings: CompanySkillInspectionFinding[] = [];
  for (const issue of issues ?? []) {
    const record = asRecord(issue);
    if (!record) continue;
    const location = asRecord(record.location);
    findings.push({
      ruleId: clip(record.id, 40) || clip(record.category, 40) || "finding",
      severity: clip(record.severity, 40).toUpperCase() || "UNKNOWN",
      title: clip(record.pattern, 120) || clip(record.category, 120) || "Finding",
      detail: clip(record.explanation, 400) || clip(record.finding, 400) || "SkillSpector reported this finding.",
      path: clip(location?.file, 200) || null,
      line: typeof location?.start_line === "number" ? location.start_line : null,
    });
  }
  findings.sort((left, right) => (SEVERITY_RANK[right.severity] ?? 0) - (SEVERITY_RANK[left.severity] ?? 0));
  return { score, severity, recommendation, findings: findings.slice(0, FINDING_LIMIT), totalFindings: findings.length };
}

function scanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function scanTimeoutMs() {
  const configured = Number(process.env.SKILLSPECTOR_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

function runScan(bin: string, args: string[], timeoutMs: number): Promise<ScanRun> {
  return new Promise((resolvePromise) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: scanEnv() }, (error) => {
      // SkillSpector exits non-zero when it reports high-risk findings, so the report file decides the result.
      const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolvePromise({
        spawnCode: err && typeof err.code === "string" ? err.code : null,
        timedOut: Boolean(err?.killed),
      });
    });
  });
}

function inspection(
  skillId: string,
  skillName: string,
  status: CompanySkillInspectionStatus,
  message: string | null,
  report?: ParsedReport,
): CompanySkillInspection {
  const result: CompanySkillInspection = {
    skillId,
    skillName,
    status,
    recommendation: report?.recommendation ?? null,
    blocking: false,
    score: report?.score ?? null,
    severity: report?.severity ?? null,
    findings: report?.findings ?? [],
    message,
  };
  result.blocking = inspectionBlocks(result);
  return result;
}

export function unavailableInspection(skillId: string, skillName: string): CompanySkillInspection {
  return inspection(skillId, skillName, "unavailable", UNAVAILABLE_MESSAGE);
}

export function failedInspection(skillId: string, skillName: string, message: string): CompanySkillInspection {
  return inspection(skillId, skillName, "error", message);
}

async function directoryHash(bin: string, skillDir: string): Promise<string | null> {
  const hash = createHash("sha256").update(bin).update("\0");
  const entries = await readdir(skillDir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  let total = 0;
  for (const file of files) {
    const bytes = await readFile(file);
    total += bytes.length;
    if (total > CACHE_MAX_BYTES) return null;
    hash.update(relative(skillDir, file)).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

function remember(key: string, result: CompanySkillInspection) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
}

/** Add Paperclip built-in audit findings to a SkillSpector result. These always hold the install. */
export function withPaperclipAuditFindings(
  inspection: CompanySkillInspection,
  findings: Array<{ code: string; message: string; path: string | null }>,
): CompanySkillInspection {
  if (findings.length === 0 || inspection.status === "unavailable") return inspection;
  const merged: CompanySkillInspection = {
    ...inspection,
    status: inspection.status === "error" ? "error" : "findings",
    findings: [
      ...findings.map((finding) => ({
        ruleId: `paperclip:${finding.code}`,
        severity: "HIGH",
        title: "Paperclip skill audit",
        detail: finding.message,
        path: finding.path,
        line: null,
      })),
      ...inspection.findings,
    ].slice(0, FINDING_LIMIT),
  };
  merged.blocking = inspectionBlocks(merged);
  return merged;
}

/** Scan a skill directory. Results are cached by content so "install anyway" does not rescan. */
export async function scanSkillDirectory(
  skillId: string,
  skillName: string,
  skillDir: string,
): Promise<CompanySkillInspection> {
  const bin = resolveSkillSpectorBin();
  if (!bin) return unavailableInspection(skillId, skillName);
  const cacheKey = await directoryHash(bin, skillDir).catch(() => null);
  const cached = cacheKey ? cache.get(cacheKey) : undefined;
  if (cached) return { ...cached, skillId, skillName };

  const directory = await mkdtemp(join(tmpdir(), "skillspector-"));
  const output = join(directory, "report.json");
  try {
    const timeoutMs = scanTimeoutMs();
    const run = await runScan(bin, ["scan", skillDir, "--no-llm", "--format", "json", "--output", output], timeoutMs);
    if (run.spawnCode === "ENOENT") return unavailableInspection(skillId, skillName);
    const raw: unknown = await readFile(output, "utf8").then(JSON.parse).catch(() => null);
    const parsed = raw === null ? null : parseSkillSpectorReport(raw);
    if (!parsed) {
      return failedInspection(
        skillId,
        skillName,
        run.timedOut
          ? `SkillSpector did not finish within ${Math.ceil(timeoutMs / 1000)} seconds.`
          : "SkillSpector could not finish the scan.",
      );
    }
    const hidden = parsed.totalFindings - parsed.findings.length;
    const result = inspection(
      skillId,
      skillName,
      parsed.totalFindings > 0 ? "findings" : "clean",
      hidden > 0 ? `${hidden} lower-severity findings are not shown.` : null,
      parsed,
    );
    if (cacheKey) remember(cacheKey, result);
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Scan skill files that are not on disk yet (downloaded packages) from a private temp directory. */
export async function scanSkillFiles(
  skillId: string,
  skillName: string,
  files: SkillInspectionFile[],
): Promise<CompanySkillInspection> {
  if (!resolveSkillSpectorBin()) return unavailableInspection(skillId, skillName);
  const root = await mkdtemp(join(tmpdir(), "skillspector-skill-"));
  try {
    for (const file of files) {
      const target = join(root, assertSkillSnapshotPath(file.path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, skillFileBytes(file), { mode: 0o600 });
    }
    return await scanSkillDirectory(skillId, skillName, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Run scans with a small concurrency limit so a large import does not fork dozens of scanners. */
export async function mapInspections<T>(
  items: T[],
  scan: (item: T) => Promise<CompanySkillInspection | null>,
): Promise<CompanySkillInspection[]> {
  const results: Array<CompanySkillInspection | null> = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await scan(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, worker));
  return results.filter((result): result is CompanySkillInspection => result !== null);
}

export function resetSkillInspectionCacheForTests() {
  cache.clear();
}
