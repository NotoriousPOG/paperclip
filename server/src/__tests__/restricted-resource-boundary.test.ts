import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { resourceAccessScopes, type Db } from "@paperclipai/db";
import { restrictedResourceBoundary } from "../middleware/restricted-resource-boundary.js";
import type { AuthorizationActor } from "../services/authorization.js";

const company = "11111111-1111-4111-8111-111111111111";
const unrelated = "22222222-2222-4222-8222-222222222222";
const object = "33333333-3333-4333-8333-333333333333";
const owner: AuthorizationActor = { type: "board", source: "session", userId: "owner", companyIds: [company], memberships: [{ companyId: company, membershipRole: "owner", status: "active" }] };
const deniedBody = { error: "This operation is not available with restricted resources", code: "RESTRICTED_RESOURCE_ROUTE_DENIED" };

function fixture(actor: AuthorizationActor | null = owner) {
  const state = { scopes: [{ companyId: company }] as Array<{ companyId: string }>, hits: 0 };
  const db = { select: () => ({ from: (table: unknown) => table === resourceAccessScopes
    ? Promise.resolve(state.scopes) : (() => { throw new Error("Unexpected table"); })() }) } as unknown as Db;
  const app = express();
  app.use((req, _res, next) => { if (actor) req.actor = actor; next(); });
  const boundary = restrictedResourceBoundary(db);
  app.use("/api", boundary);
  app.use("/mcp", boundary);
  app.use("/llms", boundary);
  app.use((_req, res) => { state.hits++; res.json({ sentinel: true }); });
  return { app, state };
}

describe("restricted-resource route admission", () => {
  it("blocks company-mode owners, local operators and instance admins from unreviewed handlers", async () => {
    const denied = [
      `/environments/${object}`,
      `/environments/${object}/secret-refs`,
      "/new-unknown-route",
      `/companies/${company}/exports/${object}`,
      `/companies/${company}/export`,
      `/companies/${company}/exports`,
      `/companies/${company}/export/fidelity`,
      `/companies/${company}/stats`,
      `/agents/${object}/configuration`,
    ];
    for (const actor of [owner, { ...owner, source: "local_implicit" as const, companyIds: [] }, { ...owner, isInstanceAdmin: true, companyIds: [] }]) {
      const { app, state } = fixture(actor);
      for (const path of denied) {
        const response = await request(app).get(`/api${path}`);
        expect(response.status, path).toBe(403);
        expect(response.body).toEqual(deniedBody);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(state.hits).toBe(0);
    }
  });

  it("admits only exact reviewed method/path pairs to their own resource checks", async () => {
    const { app, state } = fixture();
    const reads = [
      "/auth/get-session", "/auth/profile", "/health", "/team-access", "/cli-auth/me", "/companies",
      `/companies/${company}`, "/invites/token_123",
      `/companies/${company}/issues`, `/companies/${company}/projects`, `/companies/${company}/agents`,
      `/companies/${company}/goals`, `/companies/${company}/search`, `/companies/${company}/attention`,
      `/companies/${company}/issues/count`, `/companies/${company}/timeline`, `/companies/${company}/sidebar-badges`,
      `/companies/${company}/search/extract`,
      `/companies/${company}/secrets`, `/companies/${company}/secrets/catalog`,
      `/companies/${company}/dashboard`, `/companies/${company}/recovery-observability`,
      `/companies/${company}/access-groups`, `/companies/${company}/access-groups/${object}/invites`,
      `/companies/${company}/team-workspace`, `/companies/${company}/resource-scopes`,
      `/companies/${company}/activity`,
      `/issues/${object}`, `/issues/${object}/comments`, `/issues/${object}/documents`,
      `/issues/${object}/documents/Plan`, `/issues/${object}/attachments`,
      `/issues/${object}/activity`, `/issues/${object}/runs`,
      `/projects/${object}`, `/agents/${object}`,
      `/secrets/${object}/usage`, `/secrets/${object}/access-events`, `/assets/${object}/content`,
    ];
    for (const path of reads) {
      for (const method of ["get", "head"] as const) expect((await request(app)[method](`/api${path}`)).status, `${method} ${path}`).toBe(200);
    }
    const posts = [
      "/auth/sign-out", "/invites/token_123/accept", `/secrets/${object}/rotate`,
      `/companies/${company}/access-groups`, `/companies/${company}/resource-scopes`,
      "/instance/resource-scope-maintenance",
      `/companies/${company}/access-groups/${object}/invites`,
      `/companies/${company}/access-groups/${object}/notes`,
      `/companies/${company}/team-workspace/${object}/notes`,
    ];
    for (const path of posts) expect((await request(app).post(`/api${path}`)).status, path).toBe(200);
    for (const method of ["patch", "delete"] as const) expect((await request(app)[method](`/api/secrets/${object}`)).status).toBe(200);
    expect((await request(app).patch(`/api/companies/${company}/access-groups/${object}`)).status).toBe(200);
    expect((await request(app).put(`/api/companies/${company}/access-groups/${object}/members`)).status).toBe(200);
    expect((await request(app).delete(`/api/companies/${company}/access-groups/${object}/members/${object}`)).status).toBe(200);
    expect((await request(app).delete(`/api/companies/${company}/access-groups/${object}/invites/${object}`)).status).toBe(200);
    expect(state.hits).toBe(reads.length * 2 + posts.length + 6);
    expect((await request(app).post(`/api/companies/${company}/secrets`)).status).toBe(403);
    expect((await request(app).post(`/api/companies/${company}/export`)).status).toBe(403);
    expect((await request(app).post(`/api/companies/${company}/exports`)).status).toBe(403);
    expect((await request(app).get(`/api/companies/${company}/export/fidelity`)).status).toBe(403);
  });

  it("checks scope changes on a still-denied route and admits filtered company lists", async () => {
    const { app, state } = fixture();
    expect((await request(app).get(`/api/companies/${unrelated}/agents`)).status).toBe(200);
    expect((await request(app).get(`/api/companies/${company}/agents`)).status).toBe(200);
    expect((await request(app).get(`/api/companies/${company}/environments`)).status).toBe(403);
    state.scopes = [];
    expect((await request(app).get(`/api/companies/${company}/environments`)).status).toBe(200);
    state.scopes = [{ companyId: company }];
    expect((await request(app).get(`/api/companies/${company}/environments`)).status).toBe(403);
  });

  it("contains unrelated actors on unreviewed routes and still admits exact object reads", async () => {
    for (const actor of [null, { type: "none" as const }, { type: "board" as const, source: "session" as const },
      { ...owner, companyIds: [unrelated], memberships: [{ companyId: unrelated, status: "active" }] },
      { ...owner, memberships: [{ companyId: company, status: "suspended" }] },
      { type: "agent" as const, agentId: object, companyId: unrelated }]) {
      const { app, state } = fixture(actor);
      for (const path of [`/companies/${unrelated}/adapters/process/test-environment`, `/agents/${object}/test-environment`, `/agents/${object}/testenvironment`, `/companies/${unrelated}/agents`, `/companies/${unrelated}/new-runtime-route`]) {
        expect((await request(app).post(`/api${path}`)).status).toBe(403);
      }
      for (const path of ["/unknown-direct-route", `/companies/${unrelated}/unknown`, `/companies/${unrelated}/adapters/process/test-environment`]) {
        expect((await request(app).get(`/api${path}`)).status).toBe(403);
      }
      expect((await request(app).get(`/api/agents/${object}`)).status).toBe(200);
      expect(state.hits).toBe(1);
      state.hits = 0;
      for (const list of ["agents", "projects", "issues"]) for (const method of ["get", "head"] as const) {
        expect((await request(app)[method](`/api/companies/${unrelated}/${list}`)).status).toBe(200);
      }
    }
  });

  it("denies transport surfaces and generated path/method mutations before a sentinel handler", async () => {
    const { app, state } = fixture();
    for (const prefix of ["/mcp", "/llms"]) for (const suffix of ["", "/health", "/auth/profile", `/companies/${unrelated}/agents`]) expect((await request(app).get(prefix + suffix)).status).toBe(403);
    let seed = 7919;
    const methods = ["get", "post", "put", "patch", "delete", "options", "head"] as const;
    const paths = [
      `/companies/${company}/stats`, `/companies/${company}/agents/${object}/configuration`,
      `/companies/${company}/environments`, `/agents/${object}/watchdog`,
      `/companies/${company}/secrets/`, `/companies/${company}//secrets`, `/companies/${company}/secrets%2fcatalog`,
      `/companies/${company}/%73ecrets`, `/Companies/${company}/secrets`, `/secrets/${object}/usage/extra`,
      `/assets/${object}/content/`, `/unknown/${object}`, `/companies/${company}/secrets%00`,
      `/companies/${company}/export`, `/companies/${company}/exports/preview`,
    ];
    for (let i = 0; i < 128; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const method = methods[seed % methods.length]!;
      const path = paths[(seed >>> 8) % paths.length]!;
      expect((await request(app)[method](`/api${path}`)).status, `${method} ${path}`).toBe(403);
    }
    expect(state.hits).toBe(0);
  });
});
