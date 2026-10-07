import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  accessGroupMembers, accessGroups, activityLog, agents, approvals, authUsers, companies, companyMemberships, companySecrets,
  createDb, heartbeatRuns, issueApprovals, issues, projects, resourceAccessScopes, resourceScopeMaintenance,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertProposedIssuePlacement } from "../services/issue-placement-scope.js";
import { protectedRuntimeQualification } from "../services/private-team-access.js";
import { resourceScopeManagementService } from "../services/resource-scope-management.js";
import { assertResourceScopeMaintenanceLease, openResourceScopeMaintenanceLease } from "../services/resource-scope-maintenance.js";
import { projectRoutes } from "../routes/projects.js";
import { secretRoutes } from "../routes/secrets.js";
import { issueRoutes } from "../routes/issues.js";
import { activityRoutes } from "../routes/activity.js";
import { companyRoutes } from "../routes/companies.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { resourceScopeRoutes } from "../routes/resource-scopes.js";
import { secretService } from "../services/secrets.js";
import { createCompanySearchRateLimiter } from "../services/company-search-rate-limit.js";
import type { CompanySearchExtractQuery, CompanySearchExtractResponse, CompanySearchQuery, CompanySearchResponse } from "@paperclipai/shared";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
const secretsTmpDir = path.join(os.tmpdir(), `paperclip-scope-build-${randomUUID()}`);
beforeAll(async () => {
  mkdirSync(secretsTmpDir, { recursive: true });
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
  database = await startEmbeddedPostgresTestDatabase("scope-build-");
  db = createDb(database.connectionString);
}, 30_000);
afterAll(async () => {
  await database?.cleanup();
  if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
  rmSync(secretsTmpDir, { recursive: true, force: true });
});

function appFor(companyId: string, userId: string, extra: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, membershipRole: extra.membershipRole ?? "owner", status: "active" }], ...extra } as never;
    next();
  });
  return app;
}
function errors(app: express.Express) {
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
}
async function companyFixture(name = "Scope build") {
  const [company] = await db.insert(companies).values({ name, issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
  const userId = randomUUID();
  await db.insert(authUsers).values({ id: userId, name: "Member", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  const [membership] = await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "viewer", status: "active" }).returning();
  const [group] = await db.insert(accessGroups).values({ companyId: company.id, name: "HR" }).returning();
  return { company, userId, membership, group };
}

it("keeps protected execution unqualified", () => {
  expect(protectedRuntimeQualification()).toEqual({
    qualified: false,
    reasons: [
      "Host filesystem and network isolation are not qualified for every co-resident adapter.",
      "The application pool is not pinned to a non-bypass database role.",
    ],
  });
});

it("rejects restricted placement and allows an unchanged or unscoped placement", async () => {
  const f = await companyFixture();
  const [publicProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Public plan" }).returning();
  const [secretProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Layoff plan" }).returning();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: secretProject.id });
  const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Restricted child", projectId: secretProject.id, identifier: `REL-${randomUUID().slice(0, 8)}` }).returning();
  const contributorId = randomUUID();
  await db.insert(authUsers).values({ id: contributorId, name: "Contributor", email: `${contributorId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  const [contributor] = await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: contributorId, membershipRole: "viewer", status: "active" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.group.id, membershipId: contributor.id, role: "contributor" });
  const base = { companyId: f.company.id, current: issue, proposed: { parentId: issue.parentId, projectId: issue.projectId, assigneeAgentId: issue.assigneeAgentId } };
  await expect(assertProposedIssuePlacement(db, { ...base, actor: { type: "board", source: "local_implicit" } })).resolves.toBeUndefined();
  await expect(assertProposedIssuePlacement(db, { companyId: f.company.id, actor: { type: "board", source: "local_implicit" }, proposed: { projectId: publicProject.id } })).resolves.toBeUndefined();
  await expect(assertProposedIssuePlacement(db, { companyId: f.company.id, actor: { type: "board", source: "local_implicit" }, proposed: { projectId: secretProject.id } })).rejects.toMatchObject({ status: 404, message: "Project not found" });
  await expect(assertProposedIssuePlacement(db, { companyId: f.company.id, proposed: { parentId: randomUUID() } })).rejects.toMatchObject({ status: 404, message: "Issue not found" });
  await expect(assertProposedIssuePlacement(db, { ...base, proposed: { parentId: null, projectId: null, assigneeAgentId: null } })).rejects.toMatchObject({ status: 400 });
  await expect(assertProposedIssuePlacement(db, { ...base, publish: true, actor: { type: "board", source: "session", userId: f.userId }, proposed: { parentId: null, projectId: null, assigneeAgentId: null } })).rejects.toMatchObject({ status: 403 });
  await expect(assertProposedIssuePlacement(db, { ...base, publish: true, actor: { type: "board", source: "session", userId: contributorId }, proposed: { parentId: null, projectId: null, assigneeAgentId: null } })).resolves.toBeUndefined();
  const empty = await companyFixture("No scopes");
  await expect(assertProposedIssuePlacement(db, { companyId: empty.company.id, proposed: { parentId: randomUUID() } })).resolves.toBeUndefined();
});

it("hides unscoped secret metadata from viewers and requires both gates to rotate", async () => {
  const f = await companyFixture();
  const ownerId = randomUUID();
  await db.insert(authUsers).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  const [owner] = await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: ownerId, membershipRole: "owner", status: "active" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.group.id, membershipId: f.membership.id, role: "viewer" });
  await db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.group.id, membershipId: owner.id, role: "contributor" });
  await db.insert(companySecrets).values({ companyId: f.company.id, name: "UNSCOPED_META", key: "unscoped_meta" });
  const scoped = await secretService(db).create(f.company.id, { name: "SCOPED_META", provider: "local_encrypted", value: "rotate-me" });
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, secretId: scoped.id });
  const viewerApp = appFor(f.company.id, f.userId, { membershipRole: "viewer" });
  viewerApp.use("/api", secretRoutes(db));
  errors(viewerApp);
  const viewerList = await request(viewerApp).get(`/api/companies/${f.company.id}/secrets`);
  expect(viewerList.status).toBe(200);
  expect(JSON.stringify(viewerList.body)).toContain("SCOPED_META");
  expect(JSON.stringify(viewerList.body)).not.toContain("UNSCOPED_META");
  expect(JSON.stringify(viewerList.body)).not.toContain("rotate-me");
  const outsider = await companyFixture("Outsider secret");
  await db.insert(resourceAccessScopes).values({ companyId: outsider.company.id, groupId: outsider.group.id, projectId: (await db.insert(projects).values({ companyId: outsider.company.id, name: "Other" }).returning())[0].id });
  await db.insert(companySecrets).values({ companyId: outsider.company.id, name: "HIDDEN_META", key: "hidden_meta" });
  const outsiderApp = appFor(outsider.company.id, outsider.userId, { membershipRole: "viewer" });
  outsiderApp.use("/api", secretRoutes(db));
  errors(outsiderApp);
  const hidden = await request(outsiderApp).get(`/api/companies/${outsider.company.id}/secrets`);
  expect(JSON.stringify(hidden.body)).not.toContain("HIDDEN_META");
  const rotateDenied = await request(viewerApp).post(`/api/secrets/${scoped.id}/rotate`).send({ value: "next-value" });
  expect(rotateDenied.status).toBe(404);
  expect(JSON.stringify(rotateDenied.body)).not.toContain("SCOPED_META");
  const ownerApp = appFor(f.company.id, ownerId, { membershipRole: "owner" });
  ownerApp.use("/api", secretRoutes(db));
  errors(ownerApp);
  const ownerList = await request(ownerApp).get(`/api/companies/${f.company.id}/secrets`);
  expect(JSON.stringify(ownerList.body)).toContain("UNSCOPED_META");
  expect(JSON.stringify(ownerList.body)).toContain("SCOPED_META");
  const rotated = await request(ownerApp).post(`/api/secrets/${scoped.id}/rotate`).send({ value: "next-value" });
  expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
  expect(JSON.stringify(rotated.body)).not.toContain("next-value");
});

it("searches inside a scope and keeps direct policy denials indistinguishable from missing projects", async () => {
  const f = await companyFixture();
  const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Layoff plan" }).returning();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: project.id });
  const search = vi.fn(async (_companyId: string, query: CompanySearchQuery): Promise<CompanySearchResponse> => ({
    query: query.q, normalizedQuery: query.q.trim().toLowerCase(), scope: query.scope, limit: query.limit, offset: query.offset,
    results: [], sort: query.sort, countsByType: { issue: 0, comment: 0, document: 0, artifact: 0, agent: 0, project: 0 },
    filterOptionCounts: { status: {}, priority: {}, assigneeAgentId: {}, assigneeUserId: {}, projectId: {}, labelId: {}, updatedWithin: {} },
    zeroResults: null, hasMore: false,
  }));
  const extract = vi.fn(async (_companyId: string, query: CompanySearchExtractQuery): Promise<CompanySearchExtractResponse> => ({
    contains: query.contains, kind: query.kind, scope: query.scope, limit: query.limit, offset: query.offset,
    matchesPerIssue: query.matchesPerIssue, results: [], hasMore: false, truncated: false,
  }));
  const searchApp = appFor(f.company.id, f.userId, { membershipRole: "viewer" });
  searchApp.use("/api", issueRoutes(db, {} as never, { searchService: { search, extract }, searchRateLimiter: createCompanySearchRateLimiter({ maxRequests: 20, windowMs: 60_000, now: () => 1_000 }) }));
  errors(searchApp);
  const found = await request(searchApp).get(`/api/companies/${f.company.id}/search?q=quartzprivate`);
  expect(found.status, JSON.stringify(found.body)).toBe(200);
  expect(search).toHaveBeenCalledTimes(1);
  expect(search.mock.calls[0]?.[2]).toMatchObject({ principal: { type: "user", id: f.userId } });
  expect(JSON.stringify(found.body)).not.toContain("Layoff plan");
  const extracted = await request(searchApp).get(`/api/companies/${f.company.id}/search/extract?contains=quartzprivate`);
  expect(extracted.status, JSON.stringify(extracted.body)).toBe(200);
  expect(extracted.headers["cache-control"]).toBe("no-store");
  expect(extract).toHaveBeenCalledTimes(1);
  expect(extract.mock.calls[0]?.[2]).toMatchObject({ principal: { type: "user", id: f.userId } });
  expect(JSON.stringify(extracted.body)).not.toContain("Layoff plan");
  expect(search).toHaveBeenCalledTimes(1);
  const projectApp = appFor(f.company.id, f.userId, { membershipRole: "viewer" });
  projectApp.use("/api", projectRoutes(db));
  errors(projectApp);
  const missing = await request(projectApp).get(`/api/projects/${project.id}`);
  expect(missing.status).toBe(404);
  expect(missing.body).toEqual({ error: "Project not found" });
  expect(JSON.stringify(missing.body)).not.toContain("Layoff plan");
  const open = await companyFixture("Grant boundary");
  const [openProject] = await db.insert(projects).values({ companyId: open.company.id, name: "Visible plan" }).returning();
  const stranger = randomUUID();
  const grantApp = appFor(open.company.id, stranger, { membershipRole: "viewer" });
  grantApp.use("/api", projectRoutes(db));
  errors(grantApp);
  const denied = await request(grantApp).get(`/api/projects/${openProject.id}`);
  expect(denied.status).toBe(403);
  expect(denied.body.error).toContain("outside this actor's authorization boundary");
});

it("hides scoped rows from the non-bypass role and keeps unscoped secrets visible there", async () => {
  const f = await companyFixture();
  const [visibleProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Visible" }).returning();
  const [hiddenProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Hidden" }).returning();
  const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Hidden agent", role: "engineer", adapterType: "process" }).returning();
  const [visibleSecret] = await db.insert(companySecrets).values({ companyId: f.company.id, name: "Visible secret", key: "visible_secret" }).returning();
  const [hiddenSecret] = await db.insert(companySecrets).values({ companyId: f.company.id, name: "Hidden secret", key: "hidden_secret" }).returning();
  await db.insert(resourceAccessScopes).values([
    { companyId: f.company.id, groupId: f.group.id, projectId: hiddenProject.id },
    { companyId: f.company.id, groupId: f.group.id, agentId: agent.id },
    { companyId: f.company.id, groupId: f.group.id, secretId: hiddenSecret.id },
  ]);
  await db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.group.id, membershipId: f.membership.id, role: "viewer" });
  async function asRole(settings: Record<string, string>) {
    return db.transaction(async tx => {
      await tx.execute(sql`select set_config('paperclip.auth_enforced', ${settings.auth ?? "on"}, true)`);
      for (const [key, value] of Object.entries(settings)) {
        if (key === "auth") continue;
        await tx.execute(sql`select set_config(${`paperclip.${key}`}, ${value}, true)`);
      }
      await tx.execute(sql`set local role paperclip_app`);
      const [projectRows, agentRows, secretRows] = await Promise.all([
        tx.select({ id: projects.id }).from(projects).where(eq(projects.companyId, f.company.id)),
        tx.select({ id: agents.id }).from(agents).where(eq(agents.companyId, f.company.id)),
        tx.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.companyId, f.company.id)),
      ]);
      return { projects: projectRows.map(row => row.id).sort(), agents: agentRows.map(row => row.id).sort(), secrets: secretRows.map(row => row.id).sort() };
    });
  }
  expect(await asRole({ auth: "off" })).toMatchObject({ projects: [hiddenProject.id, visibleProject.id].sort(), secrets: [hiddenSecret.id, visibleSecret.id].sort() });
  const hidden = await asRole({});
  expect(hidden.projects).toEqual([visibleProject.id]);
  expect(hidden.agents).toEqual([]);
  expect(hidden.secrets).toEqual([visibleSecret.id]);
  const reader = await asRole({ principal_type: "user", principal_id: f.userId, operation: "read" });
  expect(reader.projects).toEqual([hiddenProject.id, visibleProject.id].sort());
  expect(reader.secrets).toEqual([hiddenSecret.id, visibleSecret.id].sort());
  const writer = await asRole({ principal_type: "user", principal_id: f.userId, operation: "write" });
  expect(writer.projects).toEqual([visibleProject.id]);
  expect(writer.secrets).toEqual([visibleSecret.id]);
});

it("requires a real maintenance lease before an owner can restrict a resource", async () => {
  const f = await companyFixture();
  const ownerId = randomUUID();
  await db.insert(authUsers).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: ownerId, membershipRole: "owner", status: "active" });
  const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Move me" }).returning();
  const routes = appFor(f.company.id, ownerId, { isInstanceAdmin: false });
  routes.use("/api", resourceScopeRoutes(db));
  errors(routes);
  expect((await request(routes).post("/api/instance/resource-scope-maintenance").send({ untilMinutes: 15 })).status).toBe(403);
  const admin = appFor(f.company.id, ownerId, { isInstanceAdmin: true });
  admin.use("/api", resourceScopeRoutes(db));
  errors(admin);
  expect((await request(admin).post("/api/instance/resource-scope-maintenance").send({ untilMinutes: 0 })).status).toBe(400);
  const service = resourceScopeManagementService(db, { assertRuntimeQuiesced: () => assertResourceScopeMaintenanceLease(db) });
  const input = { companyId: f.company.id, actor: { type: "board" as const, source: "session" as const, userId: ownerId }, resource: { type: "project" as const, id: project.id }, change: { groupId: f.group.id, expectedGroupId: null, expectedRevision: null } };
  await expect(service.move(input)).rejects.toMatchObject({ status: 403 });
  const opened = await request(admin).post("/api/instance/resource-scope-maintenance").send({ untilMinutes: 15 });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  expect(typeof opened.body.until).toBe("string");
  await expect(service.move(input)).resolves.toMatchObject({ changed: true, revision: 1 });
  const listed = await request(admin).get(`/api/companies/${f.company.id}/resource-scopes`);
  expect(listed.body).toEqual([{ resourceType: "project", resourceId: project.id, groupId: f.group.id, revision: 1 }]);
  expect(JSON.stringify(listed.body)).not.toContain("Move me");
  await db.update(resourceScopeMaintenance).set({ until: new Date(Date.now() - 60_000) }).where(eq(resourceScopeMaintenance.singletonKey, "default"));
  await expect(service.move({ ...input, change: { groupId: null, expectedGroupId: f.group.id, expectedRevision: 1, publish: true } })).resolves.toMatchObject({ changed: true });
  const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Busy", role: "engineer", adapterType: "process" }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, status: "running" }).returning();
  await openResourceScopeMaintenanceLease(db, 15);
  try {
    await expect(service.move(input)).rejects.toMatchObject({ status: 409 });
  } finally {
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  }
});

it("filters activity to readable entities and keeps unstructured events hidden", async () => {
  const f = await companyFixture();
  const [publicProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Public plan" }).returning();
  const [secretProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Layoff plan" }).returning();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: secretProject.id });
  const [publicIssue] = await db.insert(issues).values({ companyId: f.company.id, title: "Public task", projectId: publicProject.id }).returning();
  const [secretIssue] = await db.insert(issues).values({ companyId: f.company.id, title: "Layoff task", projectId: secretProject.id }).returning();
  const contributorId = randomUUID();
  await db.insert(authUsers).values({ id: contributorId, name: "Contributor", email: `${contributorId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  const [contributor] = await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: contributorId, membershipRole: "viewer", status: "active" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.group.id, membershipId: contributor.id, role: "viewer" });
  await db.insert(activityLog).values([
    { companyId: f.company.id, actorType: "user", actorId: f.userId, action: "issue.updated", entityType: "issue", entityId: publicIssue.id, details: { title: "Public plan" } },
    { companyId: f.company.id, actorType: "user", actorId: f.userId, action: "issue.updated", entityType: "issue", entityId: secretIssue.id, details: { title: "Layoff plan" } },
    { companyId: f.company.id, actorType: "user", actorId: f.userId, action: "company.noted", entityType: "company", entityId: f.company.id, details: { note: "Layoff plan" } },
  ]);
  const viewer = appFor(f.company.id, f.userId, { membershipRole: "viewer" });
  viewer.use("/api", activityRoutes(db));
  errors(viewer);
  const hidden = await request(viewer).get(`/api/companies/${f.company.id}/activity`);
  expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
  expect(JSON.stringify(hidden.body)).toContain("Public plan");
  expect(JSON.stringify(hidden.body)).not.toContain("Layoff");
  expect(hidden.headers["cache-control"]).toBe("no-store");
  const missing = await request(viewer).get(`/api/issues/${secretIssue.id}/activity`);
  expect(missing.status).toBe(404);
  expect(missing.body).toEqual({ error: "Issue not found" });
  expect(JSON.stringify(missing.body)).not.toContain("Layoff");
  const member = appFor(f.company.id, contributorId, { membershipRole: "viewer" });
  member.use("/api", activityRoutes(db));
  errors(member);
  const visible = await request(member).get(`/api/companies/${f.company.id}/activity`);
  expect(visible.status, JSON.stringify(visible.body)).toBe(200);
  expect(JSON.stringify(visible.body)).toContain(secretIssue.id);
  expect(JSON.stringify(visible.body)).not.toContain("company.noted");
});

it("filters blocked counts, timeline titles, and sidebar badges", async () => {
  const f = await companyFixture();
  const [publicProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Public plan" }).returning();
  const [secretProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Layoff plan" }).returning();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: secretProject.id });
  const [publicIssue] = await db.insert(issues).values({ companyId: f.company.id, title: "Public task", status: "in_progress", projectId: publicProject.id }).returning();
  const [secretIssue] = await db.insert(issues).values({ companyId: f.company.id, title: "Layoff task", status: "in_progress", projectId: secretProject.id }).returning();
  const contributorId = randomUUID();
  await db.insert(authUsers).values({ id: contributorId, name: "Contributor", email: `${contributorId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  const [contributor] = await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: contributorId, membershipRole: "viewer", status: "active" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.group.id, membershipId: contributor.id, role: "viewer" });
  const [publicApproval] = await db.insert(approvals).values({ companyId: f.company.id, type: "board", status: "pending", payload: { note: "public-ok" } }).returning();
  const [secretApproval] = await db.insert(approvals).values({ companyId: f.company.id, type: "board", status: "pending", payload: { note: "Layoff plan" } }).returning();
  await db.insert(approvals).values({ companyId: f.company.id, type: "board", status: "pending", payload: { note: "Layoff plan unlinked" } });
  await db.insert(issueApprovals).values([
    { companyId: f.company.id, issueId: publicIssue.id, approvalId: publicApproval.id },
    { companyId: f.company.id, issueId: secretIssue.id, approvalId: secretApproval.id },
  ]);
  const [publicAgent, secretContextAgent, secretAgent, memberAgent] = await db.insert(agents).values([
    { companyId: f.company.id, name: "Public agent", role: "engineer", adapterType: "process" },
    { companyId: f.company.id, name: "Context agent", role: "engineer", adapterType: "process" },
    { companyId: f.company.id, name: "Layoff agent", role: "engineer", adapterType: "process" },
    { companyId: f.company.id, name: "Member agent", role: "engineer", adapterType: "process" },
  ]).returning();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, agentId: secretAgent.id });
  await db.insert(heartbeatRuns).values([
    { companyId: f.company.id, agentId: publicAgent.id, status: "failed", responsibleUserId: f.userId, contextSnapshot: { issueId: publicIssue.id }, invocationSource: "manual" },
    { companyId: f.company.id, agentId: secretContextAgent.id, status: "failed", responsibleUserId: f.userId, contextSnapshot: { issueId: secretIssue.id, title: "Layoff task" }, invocationSource: "manual" },
    { companyId: f.company.id, agentId: secretAgent.id, status: "failed", responsibleUserId: f.userId, contextSnapshot: { issueId: secretIssue.id }, error: "Layoff plan", invocationSource: "manual" },
    { companyId: f.company.id, agentId: memberAgent.id, status: "failed", responsibleUserId: contributorId, contextSnapshot: { issueId: secretIssue.id, title: "Layoff task" }, invocationSource: "manual" },
  ]);
  function mount(userId: string) {
    const app = appFor(f.company.id, userId, { membershipRole: "viewer" });
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api/companies", companyRoutes(db));
    app.use("/api", sidebarBadgeRoutes(db));
    errors(app);
    return app;
  }

  const viewer = mount(f.userId);
  const viewerCount = await request(viewer).get(`/api/companies/${f.company.id}/issues/count?attention=blocked`);
  expect(viewerCount.status, JSON.stringify(viewerCount.body)).toBe(200);
  expect(viewerCount.body).toEqual({ count: 1 });
  expect(viewerCount.headers["cache-control"]).toBe("no-store");
  const viewerTimeline = await request(viewer).get(`/api/companies/${f.company.id}/timeline`);
  expect(viewerTimeline.status, JSON.stringify(viewerTimeline.body)).toBe(200);
  expect(JSON.stringify(viewerTimeline.body)).toContain("Public task");
  expect(JSON.stringify(viewerTimeline.body)).not.toContain("Layoff");
  expect(JSON.stringify(viewerTimeline.body)).not.toContain(secretIssue.id);
  expect(viewerTimeline.headers["cache-control"]).toBe("no-store");
  const viewerBadges = await request(viewer).get(`/api/companies/${f.company.id}/sidebar-badges`);
  expect(viewerBadges.status, JSON.stringify(viewerBadges.body)).toBe(200);
  expect(viewerBadges.body.approvals).toBe(1);
  expect(viewerBadges.body.failedRuns).toBe(1);
  expect(JSON.stringify(viewerBadges.body)).not.toContain("Layoff");
  expect(viewerBadges.headers["cache-control"]).toBe("no-store");

  const member = mount(contributorId);
  const memberCount = await request(member).get(`/api/companies/${f.company.id}/issues/count?attention=blocked`);
  expect(memberCount.status, JSON.stringify(memberCount.body)).toBe(200);
  expect(memberCount.body).toEqual({ count: 2 });
  const memberTimeline = await request(member).get(`/api/companies/${f.company.id}/timeline`);
  expect(memberTimeline.status, JSON.stringify(memberTimeline.body)).toBe(200);
  expect(JSON.stringify(memberTimeline.body)).toContain(secretIssue.id);
  expect(JSON.stringify(memberTimeline.body)).toContain("Layoff task");
  const memberBadges = await request(member).get(`/api/companies/${f.company.id}/sidebar-badges`);
  expect(memberBadges.status, JSON.stringify(memberBadges.body)).toBe(200);
  expect(memberBadges.body.approvals).toBe(2);
  expect(memberBadges.body.failedRuns).toBe(1);
  expect(JSON.stringify(memberBadges.body)).not.toContain("Layoff plan unlinked");
});
