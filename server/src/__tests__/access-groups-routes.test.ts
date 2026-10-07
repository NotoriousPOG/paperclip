import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent } from "../services/live-events.js";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessGroups, accessGroupMembers, accessGroupResources, activityLog, agentApiKeys, agents, authUsers, companies, companyMemberships, createDb, invites, resourceAccessScopes, projects } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accessGroupRoutes } from "../routes/access-groups.js";
import { accessGroupService } from "../services/access-groups.js";
import { privateTeamBoundary } from "../middleware/private-team-boundary.js";
import { canonicalResourcePath, reviewedResourceRoute } from "../middleware/reviewed-resource-routes.js";
import { authorizationService } from "../services/authorization.js";
function reviewedStub(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (canonicalResourcePath(req.path) && reviewedResourceRoute(req.method, req.path)) {
    res.json({ admitted: true });
    return;
  }
  next();
}

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("private-teams-"); db = createDb(database.connectionString); }, 30_000);
afterAll(async () => { await database?.cleanup(); });
async function fixture() {
  const [company] = await db.insert(companies).values({ name: "Private teams QA", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
  const user = async (name: string) => (await db.insert(authUsers).values({ id: randomUUID(), name, email: `${randomUUID()}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() }).returning())[0];
  const ownerUser = await user("Owner"), hr = await user("HR"), finance = await user("Finance");
  const [owner] = await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: ownerUser.id, membershipRole: "owner", status: "active" }).returning();
  const [hrGroup, financeGroup] = await db.insert(accessGroups).values([{ companyId: company.id, name: "HR" }, { companyId: company.id, name: "Finance" }]).returning();
  const [hrProject, financeProject] = await db.insert(projects).values([{ companyId: company.id, name: "HR confidential", description: "HR-only project description" }, { companyId: company.id, name: "Finance confidential", description: "Finance-only project description" }]).returning();
  const [hrAgent, financeAgent] = await db.insert(agents).values([{ companyId: company.id, name: "HR agent", role: "engineer", adapterType: "process", adapterConfig: { secret: "NEVER_RETURN_AGENT_CONFIG" } }, { companyId: company.id, name: "Finance agent", role: "engineer", adapterType: "process" }]).returning();
  await db.insert(accessGroupResources).values([{ companyId: company.id, groupId: hrGroup.id, projectId: hrProject.id }, { companyId: company.id, groupId: hrGroup.id, agentId: hrAgent.id }, { companyId: company.id, groupId: financeGroup.id, projectId: financeProject.id }, { companyId: company.id, groupId: financeGroup.id, agentId: financeAgent.id }]);
  const app = (userId = ownerUser.id, type = "board", extra = {}) => {
    const a = express(); a.use(express.json()); a.use((req, _res, next) => { req.actor = { type, userId, source: "session", companyIds: [company.id], companyId: company.id, agentId: type === "agent" ? userId : undefined, memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }], ...extra } as any; next(); });
    a.use("/api", privateTeamBoundary(db)); a.use("/api", accessGroupRoutes(db));
    a.use("/api", reviewedStub);
    // A sentinel stands in for every unreviewed route. No private request may reach it.
    a.use("/api", (_req, res) => res.json({ leaked: "LEGACY_COMPANY_SECRET" }));
    a.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status ?? 500).json({ error: err.message }); }); return a;
  };
  const root = `/api/companies/${company.id}`;
  const invite = async (who = hr, group = hrGroup, role = "viewer") => {
    const response = await request(app()).post(`${root}/access-groups/${group.id}/invites`).send({ email: who.email, role });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const token = response.body.invitePath.split("/").at(-1);
    const [stored] = await db.select().from(invites).where(eq(invites.tokenHash, createHash("sha256").update(token).digest("hex")));
    return stored;
  };
  return { company, owner, ownerUser, hr, finance, hrGroup, financeGroup, hrProject, financeProject, hrAgent, app, root, invite };
}

describe("private teams: invitation, inheritance, and fail-closed routes", () => {
  it("invites HR and Finance with roles, then isolates their resources and documents", async () => {
    const f = await fixture(); const service = accessGroupService(db);
    const hrInvite = await f.invite(f.hr, f.hrGroup, "contributor");
    await service.acceptInvite(hrInvite.id, f.hr.id);
    await service.acceptInvite((await f.invite(f.finance, f.financeGroup)).id, f.finance.id);
    const hr = await request(f.app(f.hr.id)).get(`${f.root}/team-workspace`);
    expect(hr.status).toBe(200); expect(hr.body.projects.map((p: any) => p.id)).toEqual([f.hrProject.id]);
    expect(hr.body.agents.map((a: any) => a.id)).toEqual([f.hrAgent.id]);
    expect(JSON.stringify(hr.body)).not.toContain("Finance"); expect(JSON.stringify(hr.body)).not.toContain("NEVER_RETURN_AGENT_CONFIG");
    expect((await request(f.app(f.hr.id)).post(`${f.root}/team-workspace/${f.hrGroup.id}/notes`).send({ title: "Private HR note", body: "HR_SECRET" })).status).toBe(201);
    expect((await request(f.app(f.finance.id)).post(`${f.root}/team-workspace/${f.hrGroup.id}/notes`).send({ title: "forbidden", body: "x" })).status).toBe(403);
    expect((await request(f.app(f.finance.id)).post(`${f.root}/team-workspace/${f.financeGroup.id}/notes`).send({ title: "viewer cannot write", body: "x" })).status).toBe(403);
    const finance = await request(f.app(f.finance.id)).get(`${f.root}/team-workspace`);
    expect(JSON.stringify(finance.body)).not.toContain("HR_SECRET");
    expect(finance.body.projects.map((p: any) => p.id)).toEqual([f.financeProject.id]);
  });
  it("removal of the last group preserves the private boundary and invite replay cannot restore access", async () => {
    const f = await fixture(); const service = accessGroupService(db); const invite = await f.invite();
    await service.acceptInvite(invite.id, f.hr.id);
    const [member] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, f.hr.id)));
    expect((await request(f.app()).delete(`${f.root}/access-groups/${f.hrGroup.id}/members/${member.id}`)).status).toBe(200);
    await service.acceptInvite(invite.id, f.hr.id);
    expect((await request(f.app(f.hr.id)).get(`${f.root}/team-workspace`)).body.groups).toEqual([]);
    const projects = await request(f.app(f.hr.id)).get(`${f.root}/projects`);
    expect(projects.body).toEqual({ admitted: true });
    expect(JSON.stringify(projects.body)).not.toContain("LEGACY_COMPANY_SECRET");
    expect((await request(f.app(f.hr.id)).get("/api/team-access")).body.private).toBe(true);
  });
  it("rejects wrong email, revoked/expired invitations, foreign groups, and owner escalation", async () => {
    const f = await fixture(); const service = accessGroupService(db); const invite = await f.invite();
    await expect(service.acceptInvite(invite.id, f.finance.id)).rejects.toMatchObject({ status: 403 });
    await db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, invite.id));
    await expect(service.acceptInvite(invite.id, f.hr.id)).rejects.toMatchObject({ status: 404 });
    const expired = await f.invite(); await db.update(invites).set({ expiresAt: new Date(0) }).where(eq(invites.id, expired.id));
    await expect(service.acceptInvite(expired.id, f.hr.id)).rejects.toMatchObject({ status: 404 });
    const other = await fixture();
    expect((await request(f.app()).patch(`${f.root}/access-groups/${f.hrGroup.id}`).send({ revision: 1, name: "HR", agentIds: [], projectIds: [other.hrProject.id] })).status).toBe(400);
    expect((await request(f.app()).put(`${f.root}/access-groups/${f.hrGroup.id}/members`).send({ membershipId: f.owner.id, role: "contributor" })).status).toBe(403);
    expect((await request(f.app()).put(`${f.root}/access-groups/${f.hrGroup.id}/members`).send({ membershipId: other.owner.id, role: "viewer" })).status).toBe(404);
    expect((await request(f.app()).post(`${f.root}/access-groups/${f.hrGroup.id}/invites`).send({ email: f.hr.email, role: "owner" })).status).toBe(400);
  });
  it("serializes different invitations for a new identity and revokes contributor writes immediately", async () => {
    const f = await fixture(); const service = accessGroupService(db);
    const first = await f.invite(f.hr, f.hrGroup, "contributor"), second = await f.invite(f.hr, f.financeGroup);
    await Promise.all([service.acceptInvite(first.id, f.hr.id), service.acceptInvite(second.id, f.hr.id)]);
    expect((await service.workspace(f.company.id, "user", f.hr.id)).groups).toHaveLength(2);
    const [member] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, f.hr.id)));
    expect((await request(f.app()).put(`${f.root}/access-groups/${f.hrGroup.id}/members`).send({ membershipId: member.id, role: "viewer" })).status).toBe(200);
    expect((await request(f.app(f.hr.id)).post(`${f.root}/team-workspace/${f.hrGroup.id}/notes`).send({ title: "Denied after demotion", body: "x" })).status).toBe(403);
  });
  it("lists and revokes invitations without exposing tokens and reports duplicate names", async () => {
    const f = await fixture(); const invite = await f.invite();
    const list = await request(f.app()).get(`${f.root}/access-groups/${f.hrGroup.id}/invites`);
    expect(list.status).toBe(200); expect(list.body[0].email).toBe(f.hr.email);
    expect(JSON.stringify(list.body)).not.toContain(invite.tokenHash);
    expect((await request(f.app()).delete(`${f.root}/access-groups/${f.financeGroup.id}/invites/${invite.id}`)).status).toBe(404);
    expect((await request(f.app()).delete(`${f.root}/access-groups/${f.hrGroup.id}/invites/${invite.id}`)).status).toBe(200);
    await expect(accessGroupService(db).acceptInvite(invite.id, f.hr.id)).rejects.toMatchObject({ status: 404 });
    expect((await request(f.app()).post(`${f.root}/access-groups`).send({ name: "HR" })).status).toBe(409);
  });
  it("requires paused agents and enforces the company boundary in database constraints", async () => {
    const f = await fixture(), other = await fixture();
    const [member] = await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "agent", principalId: f.hrAgent.id, status: "active", membershipRole: "member" }).returning();
    const assign = () => request(f.app()).put(`${f.root}/access-groups/${f.hrGroup.id}/members`).send({ membershipId: member.id, role: "viewer" });
    expect((await assign()).status).toBe(409);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.hrAgent.id));
    expect((await assign()).status).toBe(200);
    const agentList = await request(f.app(f.hrAgent.id, "agent")).get(`${f.root}/agents`);
    expect(agentList.body).toEqual({ admitted: true });
    expect(JSON.stringify(agentList.body)).not.toContain("NEVER_RETURN_AGENT_CONFIG");
    expect((await request(f.app(f.hrAgent.id, "agent")).get(`${f.root}/team-workspace`)).status).toBe(200);
    await expect(db.insert(accessGroupResources).values({ companyId: f.company.id, groupId: f.hrGroup.id, projectId: other.hrProject.id })).rejects.toThrow();
    await expect(db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.hrGroup.id, membershipId: other.owner.id, role: "viewer" })).rejects.toThrow();
  });
  it("rejects private agent WebSocket upgrades even in local trusted mode", async () => {
    const f = await fixture(), token = randomUUID();
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "agent", principalId: f.hrAgent.id, status: "active", accessMode: "groups" });
    await db.insert(agentApiKeys).values({ companyId: f.company.id, agentId: f.hrAgent.id, name: "QA private token", keyHash: createHash("sha256").update(token).digest("hex") });
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, db, { deploymentMode: "local_trusted" });
    const WebSocket = createRequire(import.meta.url)("ws");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${f.company.id}/events/ws`, { headers: { Authorization: `Bearer ${token}` } });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        socket.on("open", () => reject(new Error("Private stream unexpectedly opened")));
        socket.on("error", () => {});
        socket.on("unexpected-response", (_request: unknown, response: { statusCode: number; resume: () => void }) => { response.resume(); resolve(response.statusCode); });
      });
      expect(status).toBe(403);
    } finally { socket.terminate(); (wss as unknown as { close: () => void }).close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("closes an existing stream before sending an event after conversion to private access", async () => {
    const f = await fixture();
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated", resolveSessionFromHeaders: async () => ({ user: { id: f.ownerUser.id } }) as any });
    const WebSocket = createRequire(import.meta.url)("ws");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${f.company.id}/events/ws`);
    const messages: unknown[] = []; socket.on("message", (message: unknown) => messages.push(message));
    try {
      await new Promise<void>((resolve, reject) => { socket.on("open", resolve); socket.on("error", reject); });
      await db.update(companyMemberships).set({ accessMode: "groups" }).where(eq(companyMemberships.id, f.owner.id));
      const closed = new Promise<number>(resolve => socket.on("close", resolve));
      publishLiveEvent({ companyId: f.company.id, type: "activity.logged", payload: { secret: "NEVER_SEND" } });
      expect(await closed).toBe(1008); expect(messages).toEqual([]);
    } finally { socket.terminate(); (wss as unknown as { close: () => void }).close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("closes company-mode owner streams when a resource becomes restricted", async () => {
    const f = await fixture();
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated", resolveSessionFromHeaders: async () => ({ user: { id: f.ownerUser.id } }) as any });
    const WebSocket = createRequire(import.meta.url)("ws");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${f.company.id}/events/ws`);
    const messages: unknown[] = []; socket.on("message", (message: unknown) => messages.push(message));
    try {
      await new Promise<void>((resolve, reject) => { socket.on("open", resolve); socket.on("error", reject); });
      await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.hrGroup.id, projectId: f.hrProject.id });
      const closed = new Promise<number>(resolve => socket.on("close", resolve));
      publishLiveEvent({ companyId: f.company.id, type: "activity.logged", payload: { secret: "NEVER_SEND" } });
      expect(await closed).toBe(1008); expect(messages).toEqual([]);
    } finally { socket.terminate(); (wss as unknown as { close: () => void }).close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("unions explicit company-wide resources with private teams without enabling legacy APIs", async () => {
    const f = await fixture(), service = accessGroupService(db);
    await service.acceptInvite((await f.invite()).id, f.hr.id);
    const response = await request(f.app()).post(`${f.root}/access-groups`).send({ name: "Company handbook", audience: "company_users" });
    expect(response.status).toBe(201); const common = response.body;
    expect((await request(f.app()).patch(`${f.root}/access-groups/${common.id}`).send({ name: common.name, revision: 1, agentIds: [], projectIds: [f.financeProject.id] })).status).toBe(200);
    expect((await request(f.app()).post(`${f.root}/access-groups/${common.id}/notes`).send({ title: "General handbook", body: "COMPANY_PUBLIC" })).status).toBe(201);
    const workspace = await service.workspace(f.company.id, "user", f.hr.id);
    expect(new Set(workspace.projects.map(p => p.id))).toEqual(new Set([f.hrProject.id, f.financeProject.id]));
    expect(workspace.notes.map(n => n.body)).toEqual(["COMPANY_PUBLIC"]);
    const commonGroup = workspace.groups.find(g => g.id === common.id)!;
    expect(commonGroup.role).toBe("viewer");
    expect((await request(f.app(f.hr.id)).post(`${f.root}/team-workspace/${common.id}/notes`).send({ title: "Cannot publish", body: "x" })).status).toBe(403);
    const [member] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, f.hr.id)));
    await request(f.app()).delete(`${f.root}/access-groups/${f.hrGroup.id}/members/${member.id}`);
    expect((await service.workspace(f.company.id, "user", f.hr.id)).projects.map(p => p.id)).toEqual([f.financeProject.id]);
    expect((await request(f.app(f.hr.id)).get(`${f.root}/projects`)).body).toEqual({ admitted: true });
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, member.id));
    await expect(service.workspace(f.company.id, "user", f.hr.id)).rejects.toMatchObject({ status: 403 });
  });
  it("keeps company people and agent audiences separate and intersects delegated discovery", async () => {
    const f = await fixture(), service = accessGroupService(db);
    await service.acceptInvite((await f.invite()).id, f.hr.id);
    const [people, bots] = await db.insert(accessGroups).values([{ companyId: f.company.id, name: "Everyone", audience: "company_users" }, { companyId: f.company.id, name: "Company agents", audience: "company_agents" }]).returning();
    await db.insert(accessGroupResources).values([{ companyId: f.company.id, groupId: people.id, projectId: f.hrProject.id }, { companyId: f.company.id, groupId: bots.id, projectId: f.hrProject.id }, { companyId: f.company.id, groupId: bots.id, projectId: f.financeProject.id }]);
    const human = await service.workspace(f.company.id, "user", f.hr.id);
    expect(human.groups.map(g => g.id)).not.toContain(bots.id);
    const agent = await service.workspace(f.company.id, "agent", f.hrAgent.id);
    expect(agent.groups.map(g => g.id)).toEqual([bots.id]); expect(agent.projects).toHaveLength(2);
    const delegated = await service.workspace(f.company.id, "agent", f.hrAgent.id, f.hr.id);
    expect(delegated.projects.map(p => p.id)).toEqual([f.hrProject.id]);
    expect(delegated.groups).toEqual([]);
    const other = await fixture();
    await expect(service.workspace(f.company.id, "agent", other.hrAgent.id)).rejects.toMatchObject({ status: 403 });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.hrAgent.id));
    await expect(service.workspace(f.company.id, "agent", f.hrAgent.id)).rejects.toMatchObject({ status: 403 });
  });
  it("does not turn audience membership into a private membership or accept audience changes", async () => {
    const f = await fixture();
    const common = (await request(f.app()).post(`${f.root}/access-groups`).send({ name: "Common", audience: "company_users" })).body;
    expect((await request(f.app()).post(`${f.root}/access-groups/${common.id}/invites`).send({ email: f.hr.email, role: "viewer" })).status).toBe(400);
    expect((await request(f.app()).put(`${f.root}/access-groups/${common.id}/members`).send({ membershipId: f.owner.id, role: "viewer" })).status).toBe(400);
    expect((await request(f.app()).patch(`${f.root}/access-groups/${f.hrGroup.id}`).send({ revision: 1, name: "HR", agentIds: [], projectIds: [], audience: "company_users" })).status).toBe(400);
    const [owner] = await db.select().from(companyMemberships).where(eq(companyMemberships.id, f.owner.id));
    expect(owner.accessMode).toBe("company");
    expect((await request(f.app()).post(`${f.root}/access-groups`).send({ name: "Unsafe", audience: "all_tenants" })).status).toBe(400);
  });
  it("checks inviter authority at acceptance and serializes same-invite acceptance", async () => {
    const f = await fixture(); const service = accessGroupService(db); const invite = await f.invite();
    const receipts = await Promise.all([service.acceptInvite(invite.id, f.hr.id), service.acceptInvite(invite.id, f.hr.id)]);
    expect(receipts[0].id).toBe(receipts[1].id);
    const next = await f.invite(f.finance, f.financeGroup);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, f.owner.id));
    await expect(service.acceptInvite(next.id, f.finance.id)).rejects.toMatchObject({ status: 403 });
  });
  it("blocks old permission paths and delegated agents regardless of shadow or cached owner state", async () => {
    const f = await fixture(); await accessGroupService(db).acceptInvite((await f.invite()).id, f.hr.id);
    await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.financeGroup.id, projectId: f.financeProject.id });
    const decision = await authorizationService(db).decide({ actor: { type: "board", source: "session", userId: f.hr.id, companyIds: [f.company.id], isInstanceAdmin: true }, action: "company_scope:read", resource: { type: "company", companyId: f.company.id } });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("deny_resource_policy");
    const delegated = await request(f.app(f.hrAgent.id, "agent", { onBehalfOfUserId: f.hr.id })).get(`${f.root}/projects`);
    expect(delegated.body).toEqual({ admitted: true });
    expect(JSON.stringify(delegated.body)).not.toContain("LEGACY_COMPANY_SECRET");
    expect((await request(f.app(f.hr.id)).post(`${f.root}/access-groups`).send({ name: "Escalation" })).status).toBe(403);
  });
  it("accepts a private invitation through real sign-up cookies and the production auth middleware", async () => {
    const { createBetterAuthHandler, createBetterAuthInstance, resolveBetterAuthSession } = await import("../auth/better-auth.js");
    const { actorMiddleware } = await import("../middleware/auth.js");
    const { accessRoutes } = await import("../routes/access.js");
    const { boardMutationGuard } = await import("../middleware/board-mutation-guard.js");
    const previousSecret = process.env.BETTER_AUTH_SECRET;
    const previousLimit = process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    process.env.BETTER_AUTH_SECRET = "private-team-integration-test-only-secret";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    try {
      const origin = "http://127.0.0.1:41998";
      const auth = createBetterAuthInstance(db, { deploymentMode: "authenticated", deploymentExposure: "private", authBaseUrlMode: "explicit", authPublicBaseUrl: origin, authDisableSignUp: false, allowedHostnames: ["127.0.0.1"], port: 41998 } as any, [origin]);
      const app = express();
      app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
      app.use(express.json());
      app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: req => resolveBetterAuthSession(auth, req) }));
      app.use("/api", privateTeamBoundary(db));
      app.use("/api", boardMutationGuard());
      app.use("/api", accessGroupRoutes(db));
      app.use("/api", accessRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [] }));
      app.use("/api", reviewedStub);
      app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status ?? 500).json({ error: err.message }); });
      const f = await fixture();
      const owner = request.agent(app), member = request.agent(app);
      const ownerEmail = `${randomUUID()}@example.test`, memberEmail = `${randomUUID()}@example.test`;
      const signOwner = await owner.post("/api/auth/sign-up/email").set("Origin", origin).set("Host", "127.0.0.1:41998").send({ email: ownerEmail, password: "private-team-test-password", name: "Real owner" });
      expect(signOwner.status).toBe(200);
      await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: signOwner.body.user.id, membershipRole: "owner", status: "active" });
      const signMember = await member.post("/api/auth/sign-up/email").set("Origin", origin).set("Host", "127.0.0.1:41998").send({ email: memberEmail, password: "private-team-test-password", name: "Real HR member" });
      expect(signMember.status).toBe(200);
      const invited = await owner.post(`${f.root}/access-groups/${f.hrGroup.id}/invites`).set("Origin", origin).set("Host", "127.0.0.1:41998").send({ email: memberEmail, role: "contributor" });
      expect(invited.status, JSON.stringify(invited.body)).toBe(201);
      const token = invited.body.invitePath.split("/").at(-1);
      expect((await member.get(`/api/invites/${token}`)).body.teamRole).toBe("contributor");
      const [storedInvite] = await db.select().from(invites).where(eq(invites.tokenHash, createHash("sha256").update(token).digest("hex")));
      const groupId = (storedInvite.defaultsPayload as { team: { groupId: string } }).team.groupId;
      await db.update(accessGroups).set({ name: "People Operations" }).where(eq(accessGroups.id, groupId));
      expect((await member.get(`/api/invites/${token}`)).body.teamName).toBe("People Operations");
      const accepted = await member.post(`/api/invites/${token}/accept`).set("Origin", origin).set("Host", "127.0.0.1:41998").send({ requestType: "human" });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
      expect(accepted.body.status).toBe("approved");
      expect((await member.get("/api/team-access")).body.private).toBe(true);
      const resources = await member.get(`${f.root}/team-workspace`);
      expect(resources.status).toBe(200);
      expect(resources.body.projects.map((p: any) => p.id)).toEqual([f.hrProject.id]);
      const agents = await member.get(`${f.root}/agents`);
      expect(agents.body).toEqual({ admitted: true });
      expect(JSON.stringify(agents.body)).not.toContain("HR confidential");
    } finally {
      if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previousSecret;
      if (previousLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED; else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = previousLimit;
    }
  }, 30_000);
  it("fuzzes unqualified API routes/methods and malformed owner bodies (seed 0x7419)", async () => {
    const f = await fixture(); await accessGroupService(db).acceptInvite((await f.invite()).id, f.hr.id);
    const paths = [`${f.root}/stats`, `${f.root}/export`, `${f.root}/exports`, `/api/agents/${f.hrAgent.id}/configuration`, `/api/environments/${f.financeProject.id}`, "/api/assets/secret/download", "/api/tools/execute", "/api/admin/users", "/api/mcp/tools", `${f.root}/events/ws`, "/api/unknown", "/api/%74eam-workspace", "/api//companies", "/api/auth/../admin/users"];
    let seed = 0x7419;
    for (let i = 0; i < 128; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const path = paths[seed % paths.length]; const method = (["get", "post", "patch", "delete"] as const)[seed % 4];
      const result = await request(f.app(f.hr.id))[method](path).send({ companyId: f.company.id, role: "owner", isInstanceAdmin: true });
      expect(result.status, `seed=${seed} ${method} ${path}`).toBe(403);
      expect(JSON.stringify(result.body)).not.toContain("LEGACY_COMPANY_SECRET");
      expect((await request(f.app()).post(`${f.root}/access-groups`).send({ name: "bad", [`unknown${seed}`]: true })).status).toBe(400);
    }
  });
});
