import { useState } from "react";
import type { CompanySkillInspection } from "@paperclipai/shared";
import { notableInspections } from "../../api/skillInspection";

type Inspected = { held?: boolean; inspections?: CompanySkillInspection[] };

/**
 * Shared state for SkillSpector results on skill install flows. A held result opens the
 * dialog in decision mode; "Install anyway" reruns the same request with acceptInspection.
 */
export function useSkillInspectionHold() {
  const [inspections, setInspections] = useState<CompanySkillInspection[]>([]);
  const [retry, setRetry] = useState<(() => void) | null>(null);

  function close() {
    setInspections([]);
    setRetry(null);
  }

  /** Returns true when the install was held, so the caller should skip its success path. */
  function review<T extends Inspected>(
    result: T,
    retryWithAccept: () => void,
    accepted: boolean,
  ): result is T & { held: true } {
    if (result.held === true) {
      setInspections(notableInspections(result.inspections));
      setRetry(() => retryWithAccept);
      return true;
    }
    // After an accepted override the board already read these findings.
    if (accepted) close();
    else {
      setRetry(null);
      setInspections(notableInspections(result.inspections));
    }
    return false;
  }

  return {
    review,
    dialogProps: (installPending: boolean) => ({
      open: inspections.length > 0,
      inspections,
      deciding: retry !== null,
      installPending,
      onInstall: () => retry?.(),
      onOpenChange: (next: boolean) => {
        if (!next) close();
      },
    }),
  };
}
