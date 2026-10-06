import type { CompanySkillInspection } from "@paperclipai/shared";

/** Inspections worth showing: anything with findings or a failed scan. A missing scanner is not news. */
export function notableInspections(inspections: CompanySkillInspection[] | undefined): CompanySkillInspection[] {
  return (inspections ?? []).filter((inspection) => inspection.status === "findings" || inspection.status === "error");
}
