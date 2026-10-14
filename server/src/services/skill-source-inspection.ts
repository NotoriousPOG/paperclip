import type { CompanySkillInspection } from "@paperclipai/shared";
import type { ScannedSkillSource } from "./github-skill-source.js";
import { failedInspection, mapInspections, scanSkillFiles, skillInspectionEnabled } from "./skill-inspector.js";

/** Inspect the complete immutable content that publication will make available. */
export async function inspectSkillSource(
  scan: ScannedSkillSource,
  selectedPaths: string[],
): Promise<CompanySkillInspection[]> {
  if (!skillInspectionEnabled()) return [];
  const selected = new Set(selectedPaths);
  const candidates = scan.skills.filter(skill => selected.has(skill.path) && !skill.error);
  return mapInspections(candidates, async skill => {
    try {
      const files = scan.packageMode === "repository" ? scan.repositoryFiles : skill.files;
      if (!files?.length) return failedInspection(skill.path, skill.name, "SkillSpector could not read the complete package. This change was held.");
      // A repository can keep its entrypoint below the root. Supply that entrypoint
      // to the scanner while retaining every file in the published repository.
      const entrypoint = skill.files.find(file => file.path === "SKILL.md");
      const scanFiles = files.some(file => file.path === "SKILL.md") || !entrypoint
        ? files
        : [{ ...entrypoint, path: "SKILL.md" }, ...files];
      return await scanSkillFiles(skill.path, skill.name, scanFiles);
    } catch {
      return failedInspection(skill.path, skill.name, "SkillSpector could not finish the package scan. This change was held.");
    }
  });
}

export function blockingInspectionSummary(inspections: CompanySkillInspection[]) {
  return inspections.filter(inspection => inspection.blocking).map(inspection => ({
    skill: inspection.skillName,
    status: inspection.status,
    recommendation: inspection.recommendation,
    score: inspection.score,
    ruleIds: [...new Set(inspection.findings.map(finding => finding.ruleId))],
  }));
}
