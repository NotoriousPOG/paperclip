import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { accessGroupMembers, accessGroups, activityLog, agents, authUsers, companies, companyMemberships, companySecrets, createDb, heartbeatRuns, projects, resourceAccessScopes } from "@paperclipai/db";
import { changeResourceScopeSchema } from "@paperclipai/shared/resource-scope-management";
import { resourceScopeManagementService } from "../services/resource-scope-management.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("scope-management-"); db = createDb(database.connectionString); }, 30_000);
afterAll(async () => { await database?.cleanup(); });
async function fixture() {
  const [company] = await db.insert(companies).values({ name: "Scope management QA", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
  const userId = randomUUID(), outsiderId = randomUUID();
  await db.insert(authUsers).values([userId, outsiderId].map(id => ({ id, name: "Owner", email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
  await db.insert(companyMemberships).values([
    { companyId: company.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
    { companyId: company.id, principalType: "user", principalId: outsiderId, membershipRole: "viewer", status: "active" },
  ]);
  const [member] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalId, userId)));
  const groups = await db.insert(accessGroups).values(["Research", "Other"].map(name => ({ companyId: company.id, name }))).returning();
  await db.insert(accessGroupMembers).values(groups.map(group => ({ companyId: company.id, groupId: group.id, membershipId: member.id, role: "contributor" })));
  const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project" }).returning();
  const actor = { type: "board" as const, source: "session" as const, userId, companyIds: [company.id] };
  const service = resourceScopeManagementService(db, { assertRuntimeQuiesced: async () => {} });
  const input = { companyId: company.id, actor, resource: { type: "project" as const, id: project.id }, change: { groupId: groups[0].id, expectedGroupId: null, expectedRevision: null } };
  return { company, userId, outsiderId, member, groups, project, actor, service, input };
}
it("serializes competing initial restrictions and requires CAS plus explicit publication", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.service.move(f.input), f.service.move({ ...f.input, change: { ...f.input.change, groupId: f.groups[1].id } })]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  const [scope] = await db.select().from(resourceAccessScopes).where(eq(resourceAccessScopes.projectId, f.project.id));
  expect(scope.revision).toBe(1);
  await expect(f.service.move({ ...f.input, change: { groupId: null, expectedGroupId: scope.groupId, expectedRevision: 1 } })).rejects.toMatchObject({ status: 400 });
  await expect(f.service.move({ ...f.input, change: { groupId: f.groups[0].id, expectedGroupId: scope.groupId, expectedRevision: 99 } })).rejects.toMatchObject({ status: 409 });
  await expect(db.delete(accessGroups).where(eq(accessGroups.id, scope.groupId))).rejects.toThrow();
  const published = await f.service.move({ ...f.input, change: { groupId: null, expectedGroupId: scope.groupId, expectedRevision: 1, publish: true } });
  expect(published).toMatchObject({ groupId: null, revision: null, changed: true });
  expect(await db.select().from(resourceAccessScopes).where(eq(resourceAccessScopes.projectId, f.project.id))).toEqual([]);
  expect((await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.project.id), eq(activityLog.action, "resource.scope_changed")))).length).toBe(2);
});
it("lets an owner assign scope without group membership and hides resource titles", async () => {
  const f = await fixture();
  await expect(f.service.move({ ...f.input, actor: { ...f.actor, source: "local_implicit" } })).rejects.toMatchObject({ status: 403 });
  await expect(f.service.move({ ...f.input, actor: { ...f.actor, userId: f.outsiderId, isInstanceAdmin: true } })).rejects.toMatchObject({ status: 403 });
  await f.service.move(f.input);
  const listed = await f.service.list(f.company.id, f.actor);
  expect(listed).toEqual([{ resourceType: "project", resourceId: f.project.id, groupId: f.groups[0].id, revision: 1 }]);
  expect(JSON.stringify(listed)).not.toContain("Project");
  await expect(f.service.list(f.company.id, { ...f.actor, userId: f.outsiderId })).rejects.toMatchObject({ status: 403 });
  await expect(f.service.move({ ...f.input, actor: { ...f.actor, userId: f.outsiderId }, change: { groupId: null, expectedGroupId: f.groups[0].id, expectedRevision: 1, publish: true } })).rejects.toMatchObject({ status: 403 });
  await db.update(accessGroupMembers).set({ role: "viewer" }).where(and(eq(accessGroupMembers.groupId, f.groups[1].id), eq(accessGroupMembers.membershipId, f.member.id)));
  await expect(f.service.move({ ...f.input, change: { groupId: f.groups[1].id, expectedGroupId: f.groups[0].id, expectedRevision: 1 } })).resolves.toMatchObject({ groupId: f.groups[1].id, revision: 2 });
  await db.delete(accessGroupMembers).where(eq(accessGroupMembers.membershipId, f.member.id));
  await expect(f.service.move({ ...f.input, change: { groupId: f.groups[0].id, expectedGroupId: f.groups[1].id, expectedRevision: 2 } })).resolves.toMatchObject({ changed: true, revision: 3 });
  await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, f.member.id));
  await expect(f.service.move(f.input)).rejects.toMatchObject({ status: 403 });
});
it("rejects foreign resources, foreign/baseline groups and unverified runtime activation", async () => {
  const f = await fixture(), other = await fixture();
  await expect(f.service.move({ ...f.input, resource: { type: "project", id: other.project.id } })).rejects.toMatchObject({ status: 404 });
  await expect(f.service.move({ ...f.input, change: { ...f.input.change, groupId: other.groups[0].id } })).rejects.toMatchObject({ status: 404 });
  await db.update(accessGroups).set({ audience: "company_users" }).where(eq(accessGroups.id, f.groups[1].id));
  await expect(f.service.move({ ...f.input, change: { ...f.input.change, groupId: f.groups[1].id } })).rejects.toMatchObject({ status: 404 });
  await expect(resourceScopeManagementService(db).move(f.input)).rejects.toMatchObject({ status: 403 });
  const [agent] = await db.insert(agents).values({ companyId: other.company.id, name: "Running elsewhere", role: "engineer", adapterType: "process" }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: other.company.id, agentId: agent.id, status: "queued" }).returning();
  try { await expect(f.service.move(f.input)).rejects.toMatchObject({ status: 409 }); }
  finally { await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)); }
});
it("moves agents/secrets and atomically rolls back scope if audit insertion fails", async () => {
  const f = await fixture();
  const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Agent", role: "engineer", adapterType: "process" }).returning();
  const [secret] = await db.insert(companySecrets).values({ companyId: f.company.id, name: "Credential", key: "credential" }).returning();
  for (const resource of [{ type: "agent" as const, id: agent.id }, { type: "secret" as const, id: secret.id }]) {
    await f.service.move({ ...f.input, resource });
    expect(await f.service.move({ ...f.input, resource, change: { groupId: f.groups[1].id, expectedGroupId: f.groups[0].id, expectedRevision: 1 } })).toMatchObject({ groupId: f.groups[1].id, revision: 2 });
  }
  await db.execute(sql`create function test_reject_scope_audit() returns trigger language plpgsql as $$ begin if NEW.action = 'resource.scope_changed' then raise exception 'test audit failure'; end if; return NEW; end $$`);
  await db.execute(sql`create trigger test_reject_scope_audit before insert on activity_log for each row execute function test_reject_scope_audit()`);
  try {
    await expect(f.service.move(f.input)).rejects.toThrow();
    expect(await db.select().from(resourceAccessScopes).where(eq(resourceAccessScopes.projectId, f.project.id))).toEqual([]);
  } finally {
    await db.execute(sql`drop trigger test_reject_scope_audit on activity_log`);
    await db.execute(sql`drop function test_reject_scope_audit()`);
  }
  const logs = await db.select({ details: activityLog.details }).from(activityLog).where(eq(activityLog.companyId, f.company.id));
  expect(logs).toHaveLength(4);
  for (const log of logs) expect(Object.keys(log.details!).sort()).toEqual(["groupId", "previousGroupId", "previousRevision", "published", "revision"]);
});
it("validates compare-and-set pairs and rejects unknown publication payload fields", () => {
  expect(changeResourceScopeSchema.safeParse({ groupId: randomUUID(), expectedGroupId: null, expectedRevision: 1 }).success).toBe(false);
  expect(changeResourceScopeSchema.safeParse({ groupId: randomUUID(), expectedGroupId: null, expectedRevision: null, publish: true }).success).toBe(false);
  expect(changeResourceScopeSchema.safeParse({ groupId: null, expectedGroupId: null, expectedRevision: null, secretValue: "fixture" }).success).toBe(false);
});
