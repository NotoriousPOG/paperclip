import { useMemo, useState } from "react";
import type { CompanySkillInspection } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const RECOMMENDATION_LABEL: Record<NonNullable<CompanySkillInspection["recommendation"]>, string> = {
  SAFE: "Safe",
  CAUTION: "Use caution",
  DO_NOT_INSTALL: "Do not install",
};

export function SkillInspectionDialog({
  open,
  inspections,
  deciding,
  installPending,
  onInstall,
  onOpenChange,
}: {
  open: boolean;
  inspections: CompanySkillInspection[];
  /** True when the install is held and waiting for the board to accept or decline it. */
  deciding: boolean;
  installPending: boolean;
  onInstall: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const skillIds = useMemo(() => inspections.map((item) => item.skillId), [inspections]);
  const [skillId, setSkillId] = useState("");
  const activeSkillId = skillIds.includes(skillId) ? skillId : skillIds[0] ?? "";
  const inspection = inspections.find((item) => item.skillId === activeSkillId) ?? inspections[0];
  const findings = inspection?.findings ?? [];
  const recommendation = inspection?.recommendation ? RECOMMENDATION_LABEL[inspection.recommendation] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-(--sz-85vh) flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Skill inspection</DialogTitle>
          <DialogDescription>
            {deciding
              ? "NVIDIA SkillSpector held this install. The skill is not in the library yet."
              : "NVIDIA SkillSpector reported findings. The skill was added. Read them before assigning it to an agent."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto">
          {inspections.length > 1 ? (
            <Select value={activeSkillId} onValueChange={setSkillId}>
              <SelectTrigger className="w-full" aria-label="Skill">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {inspections.map((item) => (
                  <SelectItem key={item.skillId} value={item.skillId}>
                    {item.skillName}
                    {item.blocking ? " (held)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm font-medium">{inspection?.skillName ?? "Skill"}</p>
          )}
          {inspection?.score !== null && inspection?.score !== undefined ? (
            <p className="text-xs text-muted-foreground">
              Risk score {inspection.score}
              {inspection.severity ? ` · ${inspection.severity}` : ""}
              {recommendation ? ` · ${recommendation}` : ""}
            </p>
          ) : null}
          {inspection?.message ? <p className="text-sm">{inspection.message}</p> : null}
          {findings.length > 0 ? (
            <ul className="space-y-2">
              {findings.map((finding, index) => (
                <li key={`${finding.ruleId}-${finding.path ?? "skill"}-${index}`} className="rounded-md border border-border p-3">
                  <p className="text-sm font-medium">{finding.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {finding.severity} · {finding.ruleId}
                    {finding.path ? ` · ${finding.path}${finding.line ? `:${finding.line}` : ""}` : ""}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">{finding.detail}</p>
                </li>
              ))}
            </ul>
          ) : inspection?.message ? null : (
            <p className="text-sm text-muted-foreground">No findings were listed.</p>
          )}
        </div>
        <DialogFooter showCloseButton={!deciding}>
          {deciding ? (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={installPending}>
                Don't install
              </Button>
              <Button type="button" variant="destructive" onClick={onInstall} disabled={installPending}>
                {installPending ? "Installing..." : "Install anyway"}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
