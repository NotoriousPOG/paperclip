import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { accessGroups, accessGroupMembers, agents, assets, companies, companyMemberships, createDb, documents, issueAttachments, issueComments, issueDocuments, issues, projects, resourceAccessScopes } from "@paperclipai/db";
import { companySearchQuerySchema, companySearchExtractQuerySchema } from "@paperclipai/shared";
import { companySearchService } from "../services/company-search.js";
import { companyArtifactsService } from "../services/company-artifacts.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("search-scope-"); db = createDb(database.connectionString); }, 30_000);
afterAll(async () => { await database?.cleanup(); });
async function fixture() {
  const [company] = await db.insert(companies).values({ name: "Search QA", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
  const userId = randomUUID(), ownerId = randomUUID();
  const [member] = await db.insert(companyMemberships).values([userId, ownerId].map(principalId => ({ companyId: company.id, principalType: "user", principalId, status: "active", membershipRole: "owner" }))).returning();
  const [group] = await db.insert(accessGroups).values({ companyId: company.id, name: "Research" }).returning();
  await db.insert(accessGroupMembers).values({ companyId: company.id, groupId: group.id, membershipId: member.id, role: "viewer" });
  const [project] = await db.insert(projects).values({ companyId: company.id, name: "quartz private project" }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "quartz private agent", role: "engineer", adapterType: "process" }).returning();
  await db.insert(resourceAccessScopes).values([{ companyId: company.id, groupId: group.id, projectId: project.id }, { companyId: company.id, groupId: group.id, agentId: agent.id }]);
  const [parent] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "quartz private parent", description: "quartz secret prose", priority: "critical" }).returning();
  const [child, publicIssue] = await db.insert(issues).values([{ companyId: company.id, parentId: parent.id, title: "quartz private child", priority: "critical" }, { companyId: company.id, title: "quartz public", priority: "low" }]).returning();
  await db.insert(issueComments).values({ companyId: company.id, issueId: child.id, body: "quartz private comment canary" });
  const [document] = await db.insert(documents).values({ companyId: company.id, title: "quartz private document", latestBody: "quartz secret body", createdByAgentId: agent.id }).returning();
  await db.insert(issueDocuments).values({ companyId: company.id, issueId: child.id, documentId: document.id, key: "report" });
  const authorization = (id: string) => ({ principal: { type: "user" as const, id } });
  return { company, group, project, agent, parent, child, publicIssue, document, member, userId, ownerId, authorization };
}
it("filters titles, snippets, facets and counts before pagination for owners outside a group", async () => {
  const f = await fixture(), svc = companySearchService(db);
  const query = companySearchQuerySchema.parse({ q: "quartz", scope: "all", limit: 1 });
  const outsider = await svc.search(f.company.id, query, f.authorization(f.ownerId));
  expect(outsider.results.map(r => r.id)).toEqual([f.publicIssue.id]);
  expect(outsider.countsByType).toEqual({ issue: 1, comment: 0, document: 0, artifact: 0, agent: 0, project: 0 });
  expect(outsider.filterOptionCounts.priority.critical).toBeUndefined();
  expect(outsider.hasMore).toBe(false);
  expect(JSON.stringify(outsider)).not.toContain("private");
  const member = await svc.search(f.company.id, { ...query, limit: 50 }, f.authorization(f.userId));
  expect(member.countsByType.issue).toBe(3);
  expect(member.countsByType.agent).toBe(1);
  expect(member.countsByType.project).toBe(1);
  expect(member.countsByType.document).toBe(1);
  await db.delete(accessGroupMembers).where(eq(accessGroupMembers.membershipId, f.member.id));
  const revoked = await svc.search(f.company.id, query, f.authorization(f.userId));
  expect(revoked.countsByType).toEqual(outsider.countsByType);
  expect(JSON.stringify(revoked)).not.toContain("private");
});
it("does not expose ancestry-restricted comments or documents through scoped searches or fuzzy fallback", async () => {
  const f = await fixture(), svc = companySearchService(db);
  for (const scope of ["comments", "documents", "artifacts", "agents", "projects"] as const) {
    const result = await svc.search(f.company.id, companySearchQuerySchema.parse({ q: "quartz", scope }), f.authorization(f.ownerId));
    expect(result.results, scope).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private");
  }
  const fuzzy = await svc.search(f.company.id, companySearchQuerySchema.parse({ q: "quarz" }), f.authorization(f.ownerId));
  expect(JSON.stringify(fuzzy)).not.toContain("private");
});
it("checks artifact issue and creator provenance before returning previews or groups", async () => {
  const f = await fixture(), svc = companyArtifactsService(db);
  // Public issue alone cannot publish an artifact created by a restricted agent.
  const [asset] = await db.insert(assets).values({ companyId: f.company.id, provider: "local_disk", objectKey: "canary", contentType: "text/plain", byteSize: 5, sha256: "a".repeat(64), createdByAgentId: f.agent.id, originalFilename: "quartz restricted attachment" }).returning();
  await db.insert(issueAttachments).values({ companyId: f.company.id, issueId: f.publicIssue.id, assetId: asset.id });
  const outside = await svc.list(f.company.id, {}, { authorization: f.authorization(f.ownerId) });
  expect(outside.artifacts).toEqual([]);
  const member = await svc.list(f.company.id, {}, { authorization: f.authorization(f.userId) });
  expect(member.artifacts).toHaveLength(2);
  const groups = await svc.list(f.company.id, { groupBy: "task", groupIssueId: f.child.id }, { authorization: f.authorization(f.ownerId) });
  expect(groups.selectedGroup).toBeNull();
  expect(JSON.stringify(groups)).not.toContain("private");
});
it("extracts only readable issue text and hides restricted document excerpts", async () => {
  const f = await fixture();
  const quartz = companySearchExtractQuerySchema.parse({ kind: "literal", contains: "quartz" });
  const outsider = await companySearchService(db).extract(f.company.id, quartz, f.authorization(f.ownerId));
  expect(outsider.results.map((result) => result.issueId)).toEqual([f.publicIssue.id]);
  expect(JSON.stringify(outsider)).not.toContain("private");
  const [restrictedDocument] = await db.insert(documents).values({
    companyId: f.company.id,
    title: "public attachment",
    latestBody: "quartz agent-only-canary",
    createdByAgentId: f.agent.id,
  }).returning();
  await db.insert(issueDocuments).values({ companyId: f.company.id, issueId: f.publicIssue.id, documentId: restrictedDocument.id, key: "secret-note" });
  const hiddenQuartz = await companySearchService(db).extract(f.company.id, quartz, f.authorization(f.ownerId));
  expect(hiddenQuartz.results.map((result) => result.issueId)).toEqual([f.publicIssue.id]);
  expect(JSON.stringify(hiddenQuartz)).not.toContain("agent-only-canary");
  expect(JSON.stringify(hiddenQuartz)).not.toContain("private");
  const memberQuartz = await companySearchService(db).extract(f.company.id, quartz, f.authorization(f.userId));
  expect(memberQuartz.results.map((result) => result.issueId)).toEqual(expect.arrayContaining([f.parent.id, f.child.id, f.publicIssue.id]));

  // Match dedupe keeps the first occurrence of a substring. These needles are absent from titles.
  const excerpts = (results: { matches: Array<{ excerpt: string }> }[]) => results.flatMap((result) => result.matches.map((match) => match.excerpt));
  const documentQuery = companySearchExtractQuerySchema.parse({ kind: "literal", contains: "agent-only-canary" });
  const hiddenDocument = await companySearchService(db).extract(f.company.id, documentQuery, f.authorization(f.ownerId));
  expect(hiddenDocument.results).toEqual([]);
  const memberDocument = await companySearchService(db).extract(f.company.id, documentQuery, f.authorization(f.userId));
  expect(excerpts(memberDocument.results)).toEqual(expect.arrayContaining([expect.stringContaining("agent-only-canary")]));
  const commentQuery = companySearchExtractQuerySchema.parse({ kind: "literal", contains: "comment canary" });
  const hiddenComment = await companySearchService(db).extract(f.company.id, commentQuery, f.authorization(f.ownerId));
  expect(hiddenComment.results).toEqual([]);
  const memberComment = await companySearchService(db).extract(f.company.id, commentQuery, f.authorization(f.userId));
  expect(excerpts(memberComment.results)).toEqual(expect.arrayContaining([expect.stringContaining("quartz private comment canary")]));
});
