import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { accessGroups, accessGroupMembers, assets, companies, companyMemberships, createDb, issueAttachments, issues, projects, resourceAccessScopes } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assetRoutes } from "../routes/assets.js";
import type { StorageService } from "../storage/types.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("asset-resource-scopes-"); db = createDb(database.connectionString); }, 30_000);
afterAll(async () => { await database?.cleanup(); });

it("checks live attachment ancestry before GET, HEAD and range metadata; revocation cannot reuse cached content", async () => {
  const [company] = await db.insert(companies).values({ name: "Asset scope QA", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
  const userId = randomUUID(), outsiderId = randomUUID();
  const [member] = await db.insert(companyMemberships).values([userId, outsiderId].map(principalId => ({ companyId: company.id, principalType: "user", principalId, status: "active", membershipRole: "member" }))).returning();
  const [group] = await db.insert(accessGroups).values({ companyId: company.id, name: "Research" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: company.id, groupId: group.id, membershipId: member.id, role: "viewer" });
  const [project] = await db.insert(projects).values({ companyId: company.id, name: "Restricted" }).returning();
  await db.insert(resourceAccessScopes).values({ companyId: company.id, groupId: group.id, projectId: project.id });
  const [parent] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Private parent" }).returning();
  const [issue] = await db.insert(issues).values({ companyId: company.id, parentId: parent.id, title: "Child without project" }).returning();
  const [asset, orphan] = await db.insert(assets).values(["private", "orphan"].map(objectKey => ({ companyId: company.id, provider: "local_disk", objectKey, contentType: "text/plain", byteSize: 6, sha256: "a".repeat(64) }))).returning();
  await db.insert(issueAttachments).values({ companyId: company.id, issueId: issue.id, assetId: asset.id });
  const getObject = vi.fn(async () => ({ stream: Readable.from("secret"), contentType: "text/plain", contentLength: 6 }));
  const storage = { getObject } as unknown as StorageService;
  const app = express();
  app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: req.header("x-test-user") ?? outsiderId, companyIds: [company.id] }; next(); });
  app.use("/api", assetRoutes(db, storage));
  const path = `/api/assets/${asset.id}/content`;
  for (const method of ["get", "head"] as const) {
    for (const range of ["bytes=0-2", "bytes=999-1000", "invalid"]) {
      const response = await request(app)[method](path).set("Range", range);
      expect(response.status).toBe(404);
      expect(response.headers.etag).not.toBe(`"${asset.sha256}"`);
      expect(response.headers["content-range"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }
  }
  expect(getObject).not.toHaveBeenCalled();
  const allowed = await request(app).get(path).set("x-test-user", userId);
  expect(allowed.status).toBe(200);
  expect(allowed.text).toBe("secret");
  expect(allowed.headers["cache-control"]).toBe("private, no-store");
  expect((await request(app).get(`/api/assets/${orphan.id}/content`).set("x-test-user", userId)).status).toBe(404);
  await db.delete(accessGroupMembers).where(eq(accessGroupMembers.membershipId, member.id));
  expect((await request(app).get(path).set("x-test-user", userId).set("If-None-Match", allowed.headers.etag)).status).toBe(404);
  expect(getObject).toHaveBeenCalledTimes(1);
});
