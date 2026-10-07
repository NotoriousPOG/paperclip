// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanyPermissions } from "./CompanyPermissions";
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), breadcrumbs: vi.fn() }));
vi.mock("@/api/permissionEditor", () => ({ permissionEditorApi: mocks }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: any) => <a href={to} {...props}>{children}</a> }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let data: any;
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 30)); }); };
beforeEach(() => {
  data = { localTrusted: true, projects: [{ id: "project", name: "HR" }], agents: [], principals: [{ id: "member", principalId: "user", principalType: "user", name: "Alice", role: "viewer", status: "active", editable: true, grants: [] }] };
  mocks.get.mockReset().mockImplementation(async () => data); mocks.save.mockReset().mockResolvedValue({ saved: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><CompanyPermissions /></QueryClientProvider>)); await flush(); }
it("saves the selected user grant and shows persisted success", async () => {
  mocks.save.mockImplementation(async () => {
    data = { ...data, principals: [{ ...data.principals[0], grants: [{ id: "new-grant", permissionKey: "tasks:assign", scope: null }] }] };
    return { saved: true };
  });
  await render();
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
  expect(mocks.save).toHaveBeenCalledWith("company", "member", { permissionKey: "tasks:assign", expectedGrantId: null, enabled: true, scope: null });
  expect(container.textContent).toContain("Permission saved.");
});
it("renders protected identities read-only", async () => { data.principals[0].editable = false; await render(); expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true); });
it("preserves unsupported existing scope instead of broadening it", async () => { data.principals[0].grants = [{ id: "grant", permissionKey: "tasks:assign", scope: { custom: "restricted" } }]; await render(); expect(container.textContent).toContain("read-only here"); expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true); });
it("surfaces API authorization failures", async () => { mocks.get.mockRejectedValue(new Error("Company owner access required")); await render(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Company owner access required"); });
it("surfaces stale-save errors without showing success", async () => {
  mocks.save.mockRejectedValue(new Error("Permissions changed. Reload before saving.")); await render();
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Reload before saving"); expect(container.textContent).not.toContain("Permission saved.");
});
