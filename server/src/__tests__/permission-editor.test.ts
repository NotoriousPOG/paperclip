import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { permissionEditorRoutes } from "../routes/permission-editor.js";
import { authorizationService } from "../services/authorization.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("permission-editor-"); db = createDb(database.connectionString); }, 30_000);
afterAll(async () => { await database?.cleanup(); });
async function fixture() {
  const [company] = await db.insert(companies).values({ name: "Permission test", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
  const [owner, user] = await db.insert(companyMemberships).values([
    { companyId: company.id, principalType: "user", principalId: randomUUID(), membershipRole: "owner", status: "active" },
    { companyId: company.id, principalType: "user", principalId: randomUUID(), membershipRole: "viewer", status: "active" },
  ]).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Test agent", role: "engineer", adapterType: "process", status: "idle" }).returning();
  const [agentMember] = await db.insert(companyMemberships).values({ companyId: company.id, principalType: "agent", principalId: agent.id, membershipRole: "member", status: "active" }).returning();
  const [project] = await db.insert(projects).values({ companyId: company.id, name: "Scoped project" }).returning();
  const app = (actor = { type: "board", userId: owner.principalId, source: "session", companyIds: [company.id] } as any) => {
    const a = express(); a.use(express.json()); a.use((req, _res, next) => { req.actor = actor; next(); }); a.use("/api", permissionEditorRoutes(db));
    a.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status ?? 500).json({ error: err.message }); }); return a;
  };
  return { company, owner, user, agent, agentMember, project, app, path: `/api/companies/${company.id}/permission-editor` };
}
const change = { permissionKey: "tasks:assign", expectedGrantId: null, enabled: true, scope: null };
describe("built-in permission editor real HTTP and PostgreSQL", () => {
  it("persists user and agent grants, enforces removal, audits, and rejects stale saves", async () => {
    const f = await fixture();
    for (const member of [f.user, f.agentMember]) {
      const url = `${f.path}/${member.id}`;
      expect((await request(f.app()).patch(url).send(change)).status).toBe(200);
      const listed = await request(f.app()).get(f.path);
      const grant = listed.body.principals.find((p: any) => p.id === member.id).grants[0];
      const decide = () => authorizationService(db).decidePrincipalGrant({ companyId: f.company.id, principalType: member.principalType as "user" | "agent", principalId: member.principalId, action: "tasks:assign", permissionKey: "tasks:assign" });
      expect((await decide()).allowed).toBe(true);
      expect((await request(f.app()).patch(url).send(change)).status).toBe(409);
      expect((await request(f.app()).patch(url).send({ ...change, expectedGrantId: grant.id, enabled: false })).status).toBe(200);
      expect((await decide()).allowed).toBe(false);
    }
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toHaveLength(4);
  });
  it("rejects viewers, agents, cross-company IDs, and owner self-edits", async () => {
    const f = await fixture(); const other = await fixture();
    for (const actor of [
      { type: "board", userId: f.user.principalId, source: "session", companyIds: [f.company.id] },
      { type: "agent", agentId: f.agent.id, companyId: f.company.id, source: "agent_key" },
      { type: "board", userId: other.owner.principalId, source: "session", companyIds: [other.company.id] },
    ]) {
      expect((await request(f.app(actor)).get(f.path)).status).toBe(403);
      expect((await request(f.app(actor)).patch(`${f.path}/${f.user.id}`).send(change)).status).toBe(403);
    }
    expect((await request(f.app()).patch(`${f.path}/${f.owner.id}`).send(change)).status).toBe(403);
    expect((await request(f.app()).patch(`${f.path}/${other.user.id}`).send(change)).status).toBe(404);
  });
  it("enforces selected scope and rejects foreign resources", async () => {
    const f = await fixture(); const other = await fixture();
    const scoped = { ...change, permissionKey: "tasks:assign_scope", scope: { projectIds: [f.project.id], agentIds: [f.agent.id] } };
    expect((await request(f.app()).patch(`${f.path}/${f.user.id}`).send(scoped)).status).toBe(200);
    for (const [projectId, assigneeAgentId, allowed] of [[f.project.id, f.agent.id, true], [other.project.id, f.agent.id, false], [f.project.id, other.agent.id, false]] as const) {
      expect((await authorizationService(db).decidePrincipalGrant({ companyId: f.company.id, principalType: "user", principalId: f.user.principalId, action: "tasks:assign", permissionKey: "tasks:assign_scope", scope: { projectId, assigneeAgentId } })).allowed).toBe(allowed);
    }
    expect((await request(f.app()).patch(`${f.path}/${f.agentMember.id}`).send({ ...scoped, scope: { projectIds: [other.project.id] } })).status).toBe(400);
  });
  it("allows only one concurrent save and immediately rejects a suspended owner", async () => {
    const f = await fixture();
    const responses = await Promise.all([
      request(f.app()).patch(`${f.path}/${f.user.id}`).send(change),
      request(f.app()).patch(`${f.path}/${f.user.id}`).send(change),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, f.owner.id));
    expect((await request(f.app()).get(f.path)).status).toBe(403);
    expect((await request(f.app()).patch(`${f.path}/${f.agentMember.id}`).send(change)).status).toBe(403);
  });
  it("fuzzes request bodies and path IDs without writes or server errors (seed 0x51c0)", async () => {
    const f = await fixture(); let seed = 0x51c0;
    for (let i = 0; i < 128; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const mutations = [ { ...change, [`unknown_${seed}`]: true }, { ...change, permissionKey: `unknown:${seed}` }, { ...change, enabled: seed }, { ...change, scope: { projectIds: [String(seed)] } }, { ...change, expectedGrantId: String(seed) }, { ...change, scope: { allow: ["*"] } } ];
      const response = await request(f.app()).patch(`${f.path}/${f.user.id}`).send(mutations[seed % mutations.length]);
      expect(response.status, `seed=${seed}`).toBe(400);
    }
    for (const id of ["undefined", "null", "' OR 1=1", "a".repeat(100), "00000000--------------------------------", randomUUID()]) {
      expect((await request(f.app()).patch(`${f.path}/${encodeURIComponent(id)}`).send(change)).status).toBe(404);
    }
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toHaveLength(0);
  });
});
