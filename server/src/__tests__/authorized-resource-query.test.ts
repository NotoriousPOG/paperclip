import { agentService } from "../services/agents.js";
import { projectService } from "../services/projects.js";
import { randomUUID } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { accessGroups, accessGroupMembers, agents, companies, companyMemberships, companySecrets, createDb, issues, projects, resourceAccessScopes } from "@paperclipai/db";
import { authorizedResourcePredicate, type AuthorizedResourceQuery } from "../services/authorized-resource-query.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("authorized-query-"); db = createDb(database.connectionString); }, 30_000);
afterAll(async () => { await database?.cleanup(); });
async function fixture() {
  const [company] = await db.insert(companies).values({ name: "Query scope QA", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
  const user = { type: "user" as const, id: randomUUID() }, outsider = { type: "user" as const, id: randomUUID() };
  const [member] = await db.insert(companyMemberships).values([user, outsider].map(principal => ({ companyId: company.id, principalType: principal.type, principalId: principal.id, membershipRole: "owner", status: "active" }))).returning();
  const [group] = await db.insert(accessGroups).values({ companyId: company.id, name: "Restricted" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: company.id, groupId: group.id, membershipId: member.id, role: "viewer" });
  const [baseline, restricted] = await db.insert(projects).values(["B baseline", "A hidden"].map(name => ({ companyId: company.id, name }))).returning();
  await db.insert(resourceAccessScopes).values({ companyId: company.id, groupId: group.id, projectId: restricted.id });
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Research agent", role: "engineer", adapterType: "process" }).returning();
  const predicate = (principal = user, operation: "read" | "write" = "read") => authorizedResourcePredicate({ companyId: company.id, principal, operation, resource: { type: "project", id: projects.id, companyId: projects.companyId } });
  const issuePredicate = (principal: AuthorizedResourceQuery["principal"] = user, responsibleUserId?: string) => authorizedResourcePredicate({ companyId: company.id, principal, responsibleUserId, resource: { type: "issue", id: issues.id, companyId: issues.companyId } });
  return { company, user, outsider, member, group, baseline, restricted, agent, predicate, issuePredicate };
}
it("filters before count/order/pagination with no owner bypass and observes membership revocation", async () => {
  const f = await fixture();
  expect(await db.select({ name: projects.name }).from(projects).where(f.predicate(f.outsider)).orderBy(projects.name).limit(1)).toEqual([{ name: "B baseline" }]);
  expect(await db.select({ count: count() }).from(projects).where(f.predicate(f.outsider))).toEqual([{ count: 1 }]);
  expect((await db.select().from(projects).where(f.predicate())).length).toBe(2);
  expect((await db.select().from(projects).where(f.predicate(f.user, "write"))).length).toBe(1);
  await db.update(accessGroupMembers).set({ role: "contributor" }).where(eq(accessGroupMembers.membershipId, f.member.id));
  expect((await db.select().from(projects).where(f.predicate(f.user, "write"))).length).toBe(2);
  await db.delete(accessGroupMembers).where(eq(accessGroupMembers.membershipId, f.member.id));
  expect((await db.select().from(projects).where(f.predicate())).length).toBe(1);
  await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, f.member.id));
  expect(await db.select().from(projects).where(f.predicate())).toEqual([]);
});
it("constrains agent and secret rows, with unscoped secrets passing only the query ceiling", async () => {
  const f = await fixture();
  const [secret, baseline] = await db.insert(companySecrets).values(["restricted", "baseline"].map(name => ({ companyId: f.company.id, name, key: name }))).returning();
  await db.insert(resourceAccessScopes).values([{ companyId: f.company.id, groupId: f.group.id, secretId: secret.id }, { companyId: f.company.id, groupId: f.group.id, agentId: f.agent.id }]);
  const secretPredicate = authorizedResourcePredicate({ companyId: f.company.id, principal: f.outsider, resource: { type: "secret", id: companySecrets.id, companyId: companySecrets.companyId } });
  expect(await db.select({ id: companySecrets.id }).from(companySecrets).where(secretPredicate)).toEqual([{ id: baseline.id }]);
  const agentPredicate = authorizedResourcePredicate({ companyId: f.company.id, principal: f.outsider, resource: { type: "agent", id: agents.id, companyId: agents.companyId } });
  expect(await db.select().from(agents).where(agentPredicate)).toEqual([]);
});
it("intersects agent and responsible user permissions across persisted issue ancestry and linked agents", async () => {
  const f = await fixture();
  const [parent] = await db.insert(issues).values({ companyId: f.company.id, projectId: f.restricted.id, title: "Private parent" }).returning();
  const [child] = await db.insert(issues).values({ companyId: f.company.id, parentId: parent.id, title: "Private child" }).returning();
  await db.insert(issues).values({ companyId: f.company.id, title: "Baseline" });
  const agent = { type: "agent" as const, id: f.agent.id };
  expect((await db.select().from(issues).where(f.issuePredicate(agent, f.user.id))).length).toBe(1);
  const [membership] = await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "agent", principalId: f.agent.id, status: "active" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.group.id, membershipId: membership.id, role: "viewer" });
  expect((await db.select().from(issues).where(f.issuePredicate(agent, f.user.id))).length).toBe(3);
  expect((await db.select().from(issues).where(f.issuePredicate(agent, f.outsider.id))).length).toBe(1);
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, agentId: f.agent.id });
  await db.insert(issues).values([{ companyId: f.company.id, assigneeAgentId: f.agent.id, title: "Private assignee" }, { companyId: f.company.id, conversationAgentId: f.agent.id, assigneeAgentId: f.agent.id, conversationUserId: f.user.id, conversationState: "active", title: "Private chat" }]);
  expect(await db.select({ title: issues.title }).from(issues).where(f.issuePredicate(f.outsider))).toEqual([{ title: "Baseline" }]);
  await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.agent.id));
  expect(await db.select().from(issues).where(f.issuePredicate(agent, f.user.id))).toEqual([]);
  expect(child.id).toBeTruthy();
});
it("rejects cycles, foreign company references and ancestry exceeding 64 nodes", async () => {
  const f = await fixture(), other = await fixture();
  const [cycle] = await db.insert(issues).values({ companyId: f.company.id, title: "Cycle" }).returning();
  await db.update(issues).set({ parentId: cycle.id }).where(eq(issues.id, cycle.id));
  const [foreignParent] = await db.insert(issues).values({ companyId: other.company.id, title: "Other company" }).returning();
  await db.insert(issues).values([
    { companyId: f.company.id, parentId: foreignParent.id, title: "Foreign parent" },
    { companyId: f.company.id, projectId: other.baseline.id, title: "Foreign project" },
    { companyId: f.company.id, assigneeAgentId: other.agent.id, title: "Foreign assignee" },
    { companyId: f.company.id, conversationAgentId: other.agent.id, assigneeAgentId: other.agent.id, conversationUserId: f.user.id, conversationState: "active", title: "Foreign conversation" },
  ]);
  let parentId: string | null = null;
  for (let depth = 1; depth <= 65; depth++) {
    const [row]: Array<{ id: string }> = await db.insert(issues).values({ companyId: f.company.id, parentId, title: `Depth ${depth}` }).returning({ id: issues.id });
    parentId = row.id;
  }
  const rows = await db.select({ title: issues.title }).from(issues).where(f.issuePredicate());
  expect(rows).toHaveLength(64);
  expect(rows.some(row => row.title === "Depth 64")).toBe(true);
  expect(rows.some(row => row.title === "Depth 65" || row.title.startsWith("Foreign") || row.title === "Cycle")).toBe(false);
  // Missing IDs cannot be turned into a query grant through a caller-supplied expression.
  const absent = authorizedResourcePredicate({ companyId: f.company.id, principal: f.user, resource: { type: "issue", id: sql`${randomUUID()}::uuid`, companyId: issues.companyId } });
  expect(await db.select().from(issues).where(absent)).toEqual([]);
});

it("applies list service ceilings and excludes inaccessible issues from project task counts", async () => {
  const f = await fixture();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, agentId: f.agent.id });
  await db.insert(issues).values([
    { companyId: f.company.id, projectId: f.baseline.id, title: "Public task" },
    { companyId: f.company.id, projectId: f.baseline.id, assigneeAgentId: f.agent.id, title: "Private task" },
  ]);
  const authorization = { principal: f.outsider };
  const projectRows = await projectService(db).list(f.company.id, { authorization });
  expect(projectRows.map(row => ({ id: row.id, taskCount: row.taskCount }))).toEqual([{ id: f.baseline.id, taskCount: 1 }]);
  expect(await agentService(db).list(f.company.id, { authorization })).toEqual([]);
  const memberRows = await projectService(db).list(f.company.id, { authorization: { principal: f.user } });
  expect(memberRows.find(row => row.id === f.baseline.id)?.taskCount).toBe(2);
  expect((await agentService(db).list(f.company.id, { authorization: { principal: f.user } })).map(row => row.id)).toEqual([f.agent.id]);
});
