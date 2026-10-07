// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrivateTeamGate } from "./PrivateTeamGate";
import { queryKeys } from "@/lib/queryKeys";
const mocks = vi.hoisted(() => ({ access: vi.fn(), workspace: vi.fn(), note: vi.fn(), getSession: vi.fn(), signOut: vi.fn(), pathname: "/PER/dashboard" }));
vi.mock("@/api/accessGroups", () => ({ accessGroupsApi: mocks }));
vi.mock("@/api/auth", () => ({ authApi: mocks }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname: mocks.pathname }) }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 40)); }); };
beforeEach(() => {
  vi.clearAllMocks(); mocks.pathname = "/PER/dashboard";
  mocks.getSession.mockResolvedValue({ user: { id: "alice" } });
  mocks.access.mockResolvedValue({ private: true, userId: "alice", companies: [{ id: "company", name: "QA" }] });
  mocks.workspace.mockResolvedValue({ groups: [{ id: "hr", name: "HR", role: "viewer" }], agents: [{ id: "agent", name: "HR agent", role: "engineer", status: "paused" }], projects: [], notes: [{ id: "note", groupId: "hr", title: "Private note", body: "HR_SECRET" }] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function render() { await act(async () => root.render(<QueryClientProvider client={client}><PrivateTeamGate><div>COMPANY_WIDE_CONTENT</div></PrivateTeamGate></QueryClientProvider>)); await flush(); await flush(); await flush(); }
it("renders filtered company content for restricted users without loading the private workspace", async () => {
  await render(); expect(container.textContent).toContain("COMPANY_WIDE_CONTENT"); expect(container.textContent).not.toContain("HR_SECRET"); expect(container.textContent).not.toContain("Restricted group access"); expect(mocks.workspace).not.toHaveBeenCalled();
});
it("fails closed when access lookup fails", async () => {
  mocks.access.mockRejectedValue(new Error("offline")); await render(); expect(container.textContent).toContain("Unable to check"); expect(container.textContent).not.toContain("COMPANY_WIDE_CONTENT"); expect(mocks.workspace).not.toHaveBeenCalled();
});
it("does not reuse the previous user's workspace when the session identity changes", async () => {
  await render(); mocks.getSession.mockResolvedValue({ user: { id: "bob" } });
  mocks.access.mockResolvedValue({ private: true, userId: "bob", companies: [] });
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.auth.session }); }); await flush(); await flush();
  expect(container.textContent).toContain("COMPANY_WIDE_CONTENT"); expect(container.textContent).not.toContain("HR_SECRET"); expect(container.textContent).not.toContain("Restricted group access");
});
it("allows invitation and authentication pages before access is resolved", async () => {
  mocks.pathname = "/invite/token"; mocks.access.mockRejectedValue(new Error("not signed in")); await render(); expect(container.textContent).toContain("COMPANY_WIDE_CONTENT");
});
it("preserves company-wide navigation for non-private members", async () => {
  mocks.access.mockResolvedValue({ private: false, userId: "alice", companies: [] }); await render(); expect(container.textContent).toContain("COMPANY_WIDE_CONTENT");
});
