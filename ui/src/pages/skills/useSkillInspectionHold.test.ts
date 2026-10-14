// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { CompanySkillInspection } from "@paperclipai/shared";
import { useSkillInspectionHold } from "./useSkillInspectionHold";
import { ApiError } from "../../api/client";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups = new Set<() => void>();
afterEach(() => {
  for (const unmount of cleanups) unmount();
});

function renderHold() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const result = {} as { current: ReturnType<typeof useSkillInspectionHold> };
  function Harness() {
    result.current = useSkillInspectionHold();
    return null;
  }
  act(() => root.render(createElement(Harness)));
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
    cleanups.delete(unmount);
  };
  cleanups.add(unmount);
  return result;
}

const inspection = (overrides: Partial<CompanySkillInspection>): CompanySkillInspection => ({
  skillId: "risky",
  skillName: "Risky",
  status: "findings",
  recommendation: "DO_NOT_INSTALL",
  blocking: true,
  score: 51,
  severity: "HIGH",
  findings: [],
  message: null,
  ...overrides,
});

it("opens a decision for held installs and retries with acceptance", () => {
  const hold = renderHold();
  const retry = vi.fn();
  let held = false;
  act(() => {
    held = hold.current.review({ held: true, inspections: [inspection({})] }, retry, false);
  });
  expect(held).toBe(true);
  const props = hold.current.dialogProps(false);
  expect(props).toMatchObject({ open: true, deciding: true });
  props.onInstall();
  expect(retry).toHaveBeenCalledOnce();
});

it("shows non-blocking findings for information only and hides a missing scanner", () => {
  const hold = renderHold();
  act(() => {
    hold.current.review({
      held: false,
      inspections: [
        inspection({ recommendation: "CAUTION", blocking: false }),
        inspection({ skillId: "other", status: "unavailable", blocking: false }),
      ],
    }, vi.fn(), false);
  });
  const props = hold.current.dialogProps(false);
  expect(props).toMatchObject({ open: true, deciding: false });
  expect(props.inspections.map((item) => item.skillId)).toEqual(["risky"]);
});

it("closes after an accepted override instead of showing the same findings again", () => {
  const hold = renderHold();
  act(() => {
    hold.current.review({ held: true, inspections: [inspection({})] }, vi.fn(), false);
  });
  act(() => {
    hold.current.review({ held: false, inspections: [inspection({})] }, vi.fn(), true);
  });
  expect(hold.current.dialogProps(false).open).toBe(false);
});

it("reviews a source conflict and keeps ordinary API errors in the error flow", () => {
  const hold = renderHold();
  const retry = vi.fn();
  const error = new ApiError("Held", 409, { details: { code: "skill_inspection_held", inspections: [inspection({})] } });
  act(() => { expect(hold.current.reviewError(error, retry)).toBe(true); });
  expect(hold.current.dialogProps(false)).toMatchObject({ open: true, deciding: true });
  hold.current.dialogProps(false).onInstall();
  expect(retry).toHaveBeenCalledOnce();
  expect(hold.current.reviewError(new ApiError("Stale revision", 409, {}), retry)).toBe(false);
  expect(hold.current.reviewError(new ApiError("Broken", 409, { details: { code: "skill_inspection_held", inspections: [{}] } }), retry)).toBe(false);
});
