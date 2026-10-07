import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { accessGroups, accessGroupMembers, agents, companies, companyMemberships, companySecrets, createDb, issues, projects, resourceAccessScopes } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { restrictedSecretAccessService } from "../services/restricted-secret-access.js";
import { resourceScopeAuthorizationService } from "../services/resource-scope-authorization.js";
import { authorizationService } from "../services/authorization.js";
import { resourceVisibilityService } from "../services/resource-visibility.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("resource-visibility-"); db = createDb(database.connectionString); }, 30_000);
afterAll(async () => { await database?.cleanup(); });
async function fixture() {
  const [company] = await db.insert(companies).values({ name: "Visibility QA", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
  const user = { type: "user" as const, id: randomUUID() };
  const outsider = { type: "user" as const, id: randomUUID() };
  const [member, otherMember] = await db.insert(companyMemberships).values([user, outsider].map(p => ({ companyId: company.id, principalType: p.type, principalId: p.id, status: "active", membershipRole: "member" }))).returning();
  const [group] = await db.insert(accessGroups).values({ companyId: company.id, name: "Research Operations" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: company.id, groupId: group.id, membershipId: member.id, role: "viewer" });
  const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project" }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Agent", role: "engineer", adapterType: "process" }).returning();
  return { company, group, user, outsider, member, otherMember, project, agent, service: resourceVisibilityService(db) };
}
it("defaults ordinary resources to company scope and removes baseline visibility when restricted", async () => {
  const f = await fixture(), target = { type: "project" as const, id: f.project.id };
  expect(await f.service.decide(f.company.id, target, f.outsider)).toEqual({ allowed: true, reason: "company_baseline" });
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: f.project.id });
  expect(await f.service.decide(f.company.id, target, f.user)).toEqual({ allowed: true, reason: "group_member" });
  expect(await f.service.decide(f.company.id, target, f.outsider)).toEqual({ allowed: false, reason: "not_group_member" });
  await db.delete(accessGroupMembers).where(eq(accessGroupMembers.membershipId, f.member.id));
  expect((await f.service.decide(f.company.id, target, f.user)).allowed).toBe(false);
});
it("does not infer company-wide secret visibility and requires both agent and delegator membership", async () => {
  const f = await fixture();
  const [secret] = await db.insert(companySecrets).values({ companyId: f.company.id, name: "Restricted credential", key: "restricted_credential" }).returning();
  const target = { type: "secret" as const, id: secret.id };
  expect(await f.service.decide(f.company.id, target, f.user)).toEqual({ allowed: false, reason: "secret_policy_required" });
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, secretId: secret.id });
  expect((await f.service.decide(f.company.id, target, f.outsider)).allowed).toBe(false);
  const [agentMember] = await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "agent", principalId: f.agent.id, status: "active" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.group.id, membershipId: agentMember.id, role: "viewer" });
  const agent = { type: "agent" as const, id: f.agent.id };
  expect((await f.service.decide(f.company.id, target, agent, f.user.id)).allowed).toBe(true);
  expect(await f.service.decide(f.company.id, target, agent, f.outsider.id)).toEqual({ allowed: false, reason: "delegator_denied" });
  await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, agentMember.id));
  expect((await f.service.decide(f.company.id, target, agent, f.user.id)).allowed).toBe(false);
});
it("prevents cross-company bindings, multiple owning scopes, and deletion that would publish data", async () => {
  const f = await fixture(), other = await fixture();
  await expect(db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: other.group.id, projectId: f.project.id })).rejects.toThrow();
  await expect(db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, agentId: other.agent.id })).rejects.toThrow();
  await expect(db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id })).rejects.toThrow();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: f.project.id });
  await expect(db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: f.project.id })).rejects.toThrow();
  await expect(db.delete(accessGroups).where(eq(accessGroups.id, f.group.id))).rejects.toThrow();
  expect((await f.service.decide(f.company.id, { type: "project", id: f.project.id }, f.outsider)).allowed).toBe(false);
});
it("rejects foreign, absent, suspended, and terminated identities for company baseline reads", async () => {
  const f = await fixture(), other = await fixture();
  const target = { type: "agent" as const, id: f.agent.id };
  expect((await f.service.decide(f.company.id, target, other.user)).allowed).toBe(false);
  expect((await f.service.decide(other.company.id, target, other.user)).allowed).toBe(false);
  await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, f.member.id));
  expect((await f.service.decide(f.company.id, target, f.user)).allowed).toBe(false);
  await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.agent.id));
  expect((await f.service.decide(f.company.id, target, { type: "agent", id: f.agent.id })).allowed).toBe(false);
});

it("requires every secret actor, agent consumer, and delegator to belong to its group", async () => {
  const f = await fixture();
  const [secret] = await db.insert(companySecrets).values({ companyId: f.company.id, name: "Group token", key: "group_token" }).returning();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, secretId: secret.id });
  const guard = restrictedSecretAccessService(db);
  const userContext = { actorType: "user", actorId: f.user.id };
  expect(await guard.allowed(f.company.id, secret.id, userContext)).toBe(true);
  expect(await guard.allowed(f.company.id, secret.id, userContext, "write")).toBe(false);
  expect(await guard.allowed(f.company.id, secret.id, { ...userContext, consumerType: "agent", consumerId: f.agent.id })).toBe(false);
  const [member] = await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "agent", principalId: f.agent.id, status: "active" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.group.id, membershipId: member.id, role: "viewer" });
  const context = { ...userContext, consumerType: "agent", consumerId: f.agent.id };
  expect(await guard.allowed(f.company.id, secret.id, context)).toBe(true);
  expect(await guard.allowed(f.company.id, secret.id, { ...context, responsibleUserId: f.outsider.id })).toBe(false);
  for (const actorType of [undefined, "system", "plugin", "board", "admin"]) {
    expect(await guard.allowed(f.company.id, secret.id, { actorType, actorId: f.user.id })).toBe(false);
  }
  await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, member.id));
  expect(await guard.allowed(f.company.id, secret.id, context)).toBe(false);
});

it("enforces stored scopes in the central evaluator despite owner and instance-admin privileges", async () => {
  const f = await fixture();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: f.project.id });
  await db.update(companyMemberships).set({ membershipRole: "owner" }).where(eq(companyMemberships.id, f.otherMember.id));
  const service = authorizationService(db);
  const actor = { type: "board" as const, source: "session" as const, userId: f.outsider.id, isInstanceAdmin: true, companyIds: [f.company.id] };
  expect((await service.decide({ actor, action: "project:read", resource: { type: "project", companyId: f.company.id, projectId: f.project.id } })).allowed).toBe(false);
  expect((await service.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId: f.company.id } })).allowed).toBe(false);
  const [parent] = await db.insert(issues).values({ companyId: f.company.id, projectId: f.project.id, title: "Restricted parent" }).returning();
  const [child] = await db.insert(issues).values({ companyId: f.company.id, parentId: parent.id, title: "Child without project" }).returning();
  expect((await service.decide({ actor, action: "issue:read", resource: { type: "issue", companyId: f.company.id, issueId: child.id, projectId: null, parentIssueId: null } })).allowed).toBe(false);
  const memberActor = { ...actor, userId: f.user.id, isInstanceAdmin: false };
  expect((await service.decide({ actor: memberActor, action: "issue:read", resource: { type: "issue", companyId: f.company.id, issueId: child.id } })).allowed).toBe(true);
  expect((await service.decide({ actor: memberActor, action: "issue:mutate", resource: { type: "issue", companyId: f.company.id, issueId: child.id } })).allowed).toBe(false);
  // Cyclic ancestry fails closed, even for a group member.
  await db.update(issues).set({ parentId: child.id }).where(eq(issues.id, parent.id));
  expect((await service.decide({ actor: memberActor, action: "issue:read", resource: { type: "issue", companyId: f.company.id, issueId: child.id } })).allowed).toBe(false);
});

it("denies missing targets and foreign-company issue references instead of treating them as public", async () => {
  const f = await fixture(), other = await fixture();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: f.project.id });
  const service = resourceScopeAuthorizationService(db);
  const actor = { type: "board" as const, userId: f.user.id, source: "session" as const };
  expect((await service.decide({ actor, action: "project:read", resource: { type: "project", companyId: f.company.id } })).allowed).toBe(false);
  expect((await service.decide({ actor, action: "agent:read", resource: { type: "agent", companyId: f.company.id } })).allowed).toBe(false);
  const [issue] = await db.insert(issues).values({ companyId: f.company.id, projectId: other.project.id, title: "Legacy foreign reference" }).returning();
  expect((await service.decide({ actor, action: "issue:read", resource: { type: "issue", companyId: f.company.id, issueId: issue.id } })).allowed).toBe(false);
});
