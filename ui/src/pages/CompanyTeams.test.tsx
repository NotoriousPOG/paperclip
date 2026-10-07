// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanyTeams } from "./CompanyTeams";
vi.mock("@/lib/router", () => ({ Link: ({ to, children }: any) => <a href={to}>{children}</a> }));
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), invite: vi.fn(), invitations: vi.fn(), revokeInvitation: vi.fn(), addMember: vi.fn(), get: vi.fn(), breadcrumbs: vi.fn(), listScopes: vi.fn(), moveScope: vi.fn(), openScopeMaintenance: vi.fn() }));
vi.mock("@/api/accessGroups", () => ({ accessGroupsApi: mocks }));
vi.mock("@/api/permissionEditor", () => ({ permissionEditorApi: mocks }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 40)); }); };
beforeEach(() => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue([{ id: "hr", name: "HR", revision: 1, members: [], agentIds: [], projectIds: [] }]); mocks.listScopes.mockResolvedValue([]);
  mocks.get.mockResolvedValue({ principals: [], agents: [{ id: "agent", name: "HR agent" }], projects: [] });
  mocks.invitations.mockResolvedValue([{ id: "invite", email: "hr@example.test", role: "viewer", expiresAt: "2099-01-01", acceptedAt: null, revokedAt: null }]); mocks.update.mockResolvedValue({ saved: true }); mocks.revokeInvitation.mockResolvedValue({ revoked: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function render() { await act(async () => root.render(<QueryClientProvider client={client}><CompanyTeams /></QueryClientProvider>)); await flush(); await flush(); }
it("saves explicit agent sharing with the current team revision", async () => {
  await render(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => container.querySelectorAll("form")[1].dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); await flush();
  expect(mocks.update).toHaveBeenCalledWith("company", { id: "hr", revision: 1, name: "HR", agentIds: ["agent"], projectIds: [] });
});
it("revokes a selected invitation", async () => {
  await render(); const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Revoke invitation")!; await act(async () => button.click()); await flush(); expect(mocks.revokeInvitation).toHaveBeenCalledWith("company", "hr", "invite");
});
it("displays owner-access errors", async () => {
  mocks.list.mockRejectedValue(new Error("Company owner access required")); await render(); expect(container.textContent).toContain("Company owner access required");
});

it("shows automatic company audience sharing without invitation or member controls", async () => {
  mocks.list.mockResolvedValue([{ id: "common", name: "Company", revision: 1, audience: "company_users", members: [], agentIds: [], projectIds: [] }]);
  await render(); await clickButton("Company baseline"); expect(container.textContent).toContain("all active people"); expect(container.textContent).toContain("Publish a company document"); expect(container.textContent).not.toContain("Invite a person"); expect(container.textContent).not.toContain("Existing user or agent"); expect(mocks.invitations).not.toHaveBeenCalled();
});

it("uses the configured group name throughout its management controls", async () => {
  mocks.list.mockResolvedValue([{ id: "custom", name: "Research Operations", revision: 1, audience: "team", members: [], agentIds: [], projectIds: [] }]);
  await render(); expect(container.textContent).toContain("Invite to Research Operations"); expect(container.textContent).toContain("Research Operations invitations"); expect(container.textContent).toContain("Research Operations members"); expect(container.textContent).toContain("Create invitation for Research Operations");
});

async function clickButton(name: string) {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === name);
  expect(button, `Missing button ${name}`).toBeTruthy();
  await act(async () => button!.click()); await flush();
}
it("creates groups without an audience selector and keeps baseline settings separate", async () => {
  await render();
  const createForm = container.querySelector("form")!;
  expect(createForm.textContent).toContain("Create group");
  expect(createForm.querySelector("select")).toBeNull();
  expect(container.textContent).not.toContain("Set up baseline for people");
  await clickButton("Company baseline");
  expect(container.textContent).toContain("Set up baseline for people");
  expect(container.textContent).toContain("Set up baseline for agents");
  expect(container.textContent).not.toContain("Create group");
  expect(container.textContent).not.toContain("Invite to HR");
});
it("assigns people and agents to the same group without reusing the invitation role", async () => {
  mocks.get.mockResolvedValue({ principals: [
    { id: "person-member", name: "Alice", principalType: "user", editable: true, status: "active" },
    { id: "agent-member", name: "Assistant", principalType: "agent", editable: true, status: "active" },
  ], agents: [], projects: [] });
  mocks.addMember.mockResolvedValue({ saved: true });
  await render();
  const invitationRole = [...container.querySelectorAll("label")].find(l => l.textContent?.startsWith("Invitation role"))!.querySelector("select")!;
  await act(async () => { invitationRole.value = "contributor"; invitationRole.dispatchEvent(new Event("change", { bubbles: true })); });
  const memberSelect = [...container.querySelectorAll("label")].find(l => l.textContent?.startsWith("Person or agent"))!.querySelector("select")!;
  expect([...memberSelect.querySelectorAll("optgroup")].map(g => g.label)).toEqual(["People", "Agents"]);
  expect([...memberSelect.options].map(o => o.value)).toEqual(["", "person-member", "agent-member"]);
  expect([...container.querySelectorAll("button")].some(b => b.textContent === "People" || b.textContent === "Agents")).toBe(false);
  await act(async () => { memberSelect.value = "agent-member"; memberSelect.dispatchEvent(new Event("change", { bubbles: true })); });
  await clickButton("Add to HR as viewer");
  expect(mocks.addMember).toHaveBeenCalledWith("company", "hr", "agent-member", "viewer");
});
