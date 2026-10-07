import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { accessGroups, accessGroupMembers, agents, companies, companyMemberships, companySecrets, createDb, environments, projects, resourceAccessScopes } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { secretService } from "../services/secrets.js";
import { HttpError } from "../errors.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("secondary-resource-scopes-");
  db = createDb(database.connectionString);
}, 30_000);
afterAll(async () => { await database?.cleanup(); });

async function fixture() {
  const [company] = await db.insert(companies).values({ name: "Private summary QA", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
  const userId = randomUUID(), ownerId = randomUUID();
  const [member, owner] = await db.insert(companyMemberships).values([
    { companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "member" },
    { companyId: company.id, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
  ]).returning();
  const [group] = await db.insert(accessGroups).values({ companyId: company.id, name: "Restricted research" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: company.id, groupId: group.id, membershipId: member.id, role: "viewer" });
  const [project] = await db.insert(projects).values({ companyId: company.id, name: "Hidden project canary" }).returning();
  return { company, group, project, member, owner, userId, ownerId };
}

function dashboardApp(f: Awaited<ReturnType<typeof fixture>>) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId: req.header("x-test-user") ?? f.ownerId,
      isInstanceAdmin: true, companyIds: [f.company.id] };
    next();
  });
  app.use("/api", dashboardRoutes(db));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err instanceof HttpError ? err.status : 500).json({ error: err instanceof Error ? err.message : "Error" });
  });
  return app;
}

it.each(["dashboard", "recovery-observability"])("protects the real %s handler before returning aggregate data and rechecks revocation", async endpoint => {
  const f = await fixture(), app = dashboardApp(f);
  const path = `/api/companies/${f.company.id}/${endpoint}`;
  // Existing company-level behavior is unchanged until an exclusive scope exists.
  expect((await request(app).get(path)).status).toBe(200);
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: f.project.id });
  const denied = await request(app).get(path);
  expect(denied.status).toBe(403);
  expect(denied.body).toEqual({ error: "Company summary is outside the current access scope" });
  expect(JSON.stringify(denied.body)).not.toContain(f.project.name);
  expect((await request(app).get(path).set("x-test-user", f.userId)).status).toBe(200);
  await db.delete(accessGroupMembers).where(eq(accessGroupMembers.membershipId, f.member.id));
  expect((await request(app).get(path).set("x-test-user", f.userId)).status).toBe(403);
});

it("does not bypass live aggregate scopes through HEAD, repeated parameters or malformed query values", async () => {
  const f = await fixture(), app = dashboardApp(f);
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, projectId: f.project.id });
  let state = 0x1743ab;
  const values = ["", "0", "-1", "Infinity", "NaN", "1e99", "[]", "{}", f.group.id, f.userId];
  for (let i = 0; i < 32; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const value = encodeURIComponent(values[state % values.length]!);
    const endpoint = i % 2 ? "dashboard" : "recovery-observability";
    const path = `/api/companies/${f.company.id}/${endpoint}?weeks=${value}&weeks=1&threshold=${value}&userId=${f.userId}&groupId=${f.group.id}`;
    const response = i % 3 ? await request(app).get(path) : await request(app).head(path);
    expect(response.status, path).toBe(403);
    expect(response.text ?? "").not.toContain(f.project.name);
  }
});

it("keeps restricted secret names out of instance metadata for owners, missing actors and revoked members", async () => {
  const f = await fixture();
  const [restricted, baseline] = await db.insert(companySecrets).values([
    { companyId: f.company.id, name: "Private credential canary", key: "private_canary" },
    { companyId: f.company.id, name: "Existing company credential", key: "baseline" },
  ]).returning();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, secretId: restricted.id });
  const refs = [restricted, baseline].map(secret => ({ secretId: secret.id, configPath: `env.${secret.key}` }));
  const svc = secretService(db);
  const context = (id: string) => ({ actorType: "user" as const, actorId: id, consumerType: "system" as const, consumerId: "environment-metadata" });
  const ids = (rows: Awaited<ReturnType<typeof svc.describeSecretRefs>>) => rows.map(row => row.secretId);
  expect(ids(await svc.describeSecretRefs(refs))).toEqual([baseline.id]);
  expect(ids(await svc.describeSecretRefs(refs, context(f.ownerId)))).toEqual([baseline.id]);
  expect(ids(await svc.describeSecretRefs(refs, context(f.userId)))).toEqual([restricted.id, baseline.id]);
  await db.delete(accessGroupMembers).where(eq(accessGroupMembers.membershipId, f.member.id));
  const revoked = await svc.describeSecretRefs(refs, context(f.userId));
  expect(ids(revoked)).toEqual([baseline.id]);
  expect(JSON.stringify(revoked)).not.toContain(restricted.name);
});

it("intersects agent and responsible-user access when describing secret references", async () => {
  const f = await fixture();
  const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Metadata agent", role: "engineer", adapterType: "process" }).returning();
  const [agentMember] = await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "agent", principalId: agent.id, status: "active" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: f.company.id, groupId: f.group.id, membershipId: agentMember.id, role: "viewer" });
  const [secret] = await db.insert(companySecrets).values({ companyId: f.company.id, name: "Agent-only private canary", key: "agent_private" }).returning();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, secretId: secret.id });
  const refs = [{ secretId: secret.id, configPath: "env.PRIVATE" }];
  const svc = secretService(db);
  const context = { actorType: "agent" as const, actorId: agent.id, consumerType: "system" as const, consumerId: "environment-metadata", responsibleUserId: f.userId };
  expect(await svc.describeSecretRefs(refs, context)).toHaveLength(1);
  expect(await svc.describeSecretRefs(refs, { ...context, responsibleUserId: f.ownerId })).toEqual([]);
  await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, agentMember.id));
  expect(await svc.describeSecretRefs(refs, context)).toEqual([]);
});


it("filters restricted names through the real instance environment secret-ref endpoint", async () => {
  const { environmentRoutes } = await import("../routes/environments.js");
  const f = await fixture();
  const [secret] = await db.insert(companySecrets).values({ companyId: f.company.id, name: "Private SSH credential canary", key: "private_ssh" }).returning();
  await db.insert(resourceAccessScopes).values({ companyId: f.company.id, groupId: f.group.id, secretId: secret.id });
  const [environment] = await db.insert(environments).values({
    name: `Scope fixture ${randomUUID()}`, driver: "ssh", config: {
      host: "example.invalid", username: "fixture", remoteWorkspacePath: "/tmp/test",
      privateKeySecretRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
    },
  }).returning();
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId: req.header("x-test-user") ?? f.ownerId,
      isInstanceAdmin: true, companyIds: [f.company.id] };
    next();
  });
  app.use("/api", environmentRoutes(db));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err instanceof HttpError ? err.status : 500).json({ error: err instanceof Error ? err.message : "Error" });
  });
  const path = `/api/environments/${environment.id}/secret-refs`;
  const denied = await request(app).get(path);
  expect(denied.status).toBe(200);
  expect(denied.body).toEqual({ refs: [] });
  const allowed = await request(app).get(path).set("x-test-user", f.userId);
  expect(allowed.status).toBe(200);
  expect(allowed.body.refs).toHaveLength(1);
  expect(allowed.body.refs[0].name).toBe(secret.name);
  await db.delete(accessGroupMembers).where(eq(accessGroupMembers.membershipId, f.member.id));
  expect((await request(app).get(path).set("x-test-user", f.userId)).body).toEqual({ refs: [] });
});
