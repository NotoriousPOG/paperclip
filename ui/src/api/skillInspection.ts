import type { CompanySkillInspection } from "@paperclipai/shared";
import { ApiError } from "./client";

/** A source hold is an HTTP conflict; other errors keep their ordinary error flow. */
export function inspectionHoldFromError(error: unknown): { held: true; inspections: CompanySkillInspection[] } | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body;
  if (!body || typeof body !== "object" || !("details" in body)) return null;
  const details = body.details;
  if (!details || typeof details !== "object" || !("code" in details)
    || details.code !== "skill_inspection_held" || !("inspections" in details)
    || !Array.isArray(details.inspections) || !details.inspections.every(isInspection)) return null;
  return { held: true, inspections: details.inspections };
}

function isInspection(value: unknown): value is CompanySkillInspection {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>; // Narrow a JSON object's fields before using them.
  return typeof record.skillId === "string" && typeof record.skillName === "string"
    && ["clean", "findings", "error", "unavailable"].includes(String(record.status))
    && typeof record.blocking === "boolean"
    && (record.score === null || (typeof record.score === "number" && Number.isFinite(record.score)))
    && (record.recommendation === null || ["SAFE", "CAUTION", "DO_NOT_INSTALL"].includes(String(record.recommendation)))
    && (record.message === null || typeof record.message === "string")
    && (record.severity === null || typeof record.severity === "string")
    && Array.isArray(record.findings) && record.findings.every(finding =>
      finding && typeof finding === "object" && typeof finding.ruleId === "string"
      && typeof finding.severity === "string" && typeof finding.title === "string"
      && typeof finding.detail === "string" && (finding.path === null || typeof finding.path === "string")
      && (finding.line === null || typeof finding.line === "number"));
}

/** Inspections worth showing: anything with findings or a failed scan. A missing scanner is not news. */
export function notableInspections(inspections: CompanySkillInspection[] | undefined): CompanySkillInspection[] {
  return (inspections ?? []).filter((inspection) => inspection.status === "findings" || inspection.status === "error");
}
