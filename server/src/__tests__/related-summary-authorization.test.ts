import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  accessGroups,
  accessGroupMembers,
  agents,
  companies,
  companyMemberships,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueReferenceMentions,
  issueRelations,
  issues,
  projects,
  resourceAccessScopes,
} from "@paperclipai/db";
import { documentService } from "../services/documents.js";
import { issueReferenceService } from "../services/issue-references.js";
import { issueService } from "../services/issues.js";
import { resourceQueryContext } from "../services/resource-query-context.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const TOKEN = "quartzprivate";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("related-scope-");
  db = createDb(database.connectionString);
}, 60_000);
afterAll(async () => { await database?.cleanup(); });

function hidden(value: unknown, ...ids: string[]) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(TOKEN);
  for (const id of ids) expect(text).not.toContain(id);
}

async function fixture() {
  const suffix = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: "Related QA",
    issuePrefix: randomUUID().slice(0, 6).toUpperCase(),
  }).returning();
  const userId = randomUUID();
  const ownerId = randomUUID();
  const [project] = await db.insert(projects).values({
    companyId: company.id,
    name: "Scoped project",
  }).returning();
  const [privateAgent, publicAgent, memberAgent] = await db.insert(agents).values([
    { companyId: company.id, name: "Scoped researcher", role: "engineer", adapterType: "process" },
    { companyId: company.id, name: "Public assignee", role: "engineer", adapterType: "process" },
    { companyId: company.id, name: "Group assignee", role: "engineer", adapterType: "process" },
  ]).returning();
  const [member, , agentMembership] = await db.insert(companyMemberships).values([
    { companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" },
    { companyId: company.id, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
    { companyId: company.id, principalType: "agent", principalId: memberAgent.id, status: "active", membershipRole: "member" },
  ]).returning();
  const [group] = await db.insert(accessGroups).values({ companyId: company.id, name: "Research" }).returning();
  await db.insert(accessGroupMembers).values([
    { companyId: company.id, groupId: group.id, membershipId: member.id, role: "viewer" },
    { companyId: company.id, groupId: group.id, membershipId: agentMembership.id, role: "viewer" },
  ]);
  await db.insert(resourceAccessScopes).values([
    { companyId: company.id, groupId: group.id, projectId: project.id },
    { companyId: company.id, groupId: group.id, agentId: privateAgent.id },
  ]);

  const mark = (label: string) => `${TOKEN}-${label}-${suffix}`;
  const [privateBlocker] = await db.insert(issues).values({
    companyId: company.id,
    projectId: project.id,
    title: mark("blocker"),
    identifier: mark("blocker-id"),
    status: "todo",
  }).returning();
  const [publicBlocked] = await db.insert(issues).values({
    companyId: company.id,
    title: "Visible blocked issue",
    status: "blocked",
  }).returning();
  await db.insert(issueRelations).values({
    companyId: company.id,
    issueId: privateBlocker.id,
    relatedIssueId: publicBlocked.id,
    type: "blocks",
  });

  const [privateMention] = await db.insert(issues).values({
    companyId: company.id,
    projectId: project.id,
    title: mark("mention"),
    identifier: mark("mention-id"),
    status: "todo",
  }).returning();
  const [publicMention] = await db.insert(issues).values({
    companyId: company.id,
    title: "Visible mention issue",
    status: "todo",
  }).returning();
  await db.insert(issueReferenceMentions).values([
    {
      companyId: company.id,
      sourceIssueId: publicMention.id,
      targetIssueId: privateMention.id,
      sourceKind: "description",
      matchedText: mark("outbound"),
    },
    {
      companyId: company.id,
      sourceIssueId: privateMention.id,
      targetIssueId: publicMention.id,
      sourceKind: "title",
      matchedText: mark("inbound"),
    },
  ]);

  const [hiddenWakeParent] = await db.insert(issues).values({
    companyId: company.id,
    assigneeAgentId: publicAgent.id,
    title: "Visible wake parent",
    status: "in_progress",
  }).returning();
  const [hiddenWakeChild] = await db.insert(issues).values({
    companyId: company.id,
    projectId: project.id,
    parentId: hiddenWakeParent.id,
    title: mark("wake-child"),
    identifier: mark("wake-id"),
    status: "done",
  }).returning();
  await db.insert(issueComments).values({
    companyId: company.id,
    issueId: hiddenWakeChild.id,
    body: mark("wake-comment"),
  });

  const [memberWakeParent] = await db.insert(issues).values({
    companyId: company.id,
    assigneeAgentId: memberAgent.id,
    title: "Group wake parent",
    status: "in_progress",
  }).returning();
  const [memberWakeChild] = await db.insert(issues).values({
    companyId: company.id,
    projectId: project.id,
    parentId: memberWakeParent.id,
    title: mark("member-child"),
    status: "done",
  }).returning();
  await db.insert(issueComments).values({
    companyId: company.id,
    issueId: memberWakeChild.id,
    body: mark("member-comment"),
  });

  const [openWakeParent] = await db.insert(issues).values({
    companyId: company.id,
    assigneeAgentId: publicAgent.id,
    title: "Unscoped wake parent",
    status: "in_progress",
  }).returning();
  const [openWakeChild] = await db.insert(issues).values({
    companyId: company.id,
    parentId: openWakeParent.id,
    title: "Visible unscoped child",
    status: "done",
  }).returning();

  const [listParent] = await db.insert(issues).values({
    companyId: company.id,
    title: "Visible list parent",
    status: "todo",
  }).returning();
  const [publicSibling] = await db.insert(issues).values({
    companyId: company.id,
    parentId: listParent.id,
    title: "Visible sibling",
    status: "todo",
  }).returning();
  const [liveRun] = await db.insert(heartbeatRuns).values({
    companyId: company.id,
    agentId: privateAgent.id,
    status: "running",
  }).returning();
  const [liveChild] = await db.insert(issues).values({
    companyId: company.id,
    projectId: project.id,
    parentId: listParent.id,
    title: mark("live-child"),
    identifier: mark("live-id"),
    status: "in_progress",
    executionRunId: liveRun.id,
  }).returning();

  const [privateDocument] = await db.insert(documents).values({
    companyId: company.id,
    title: mark("report"),
    latestBody: mark("report-body"),
  }).returning();
  await db.insert(issueDocuments).values({
    companyId: company.id,
    issueId: privateMention.id,
    documentId: privateDocument.id,
    key: "report",
  });
  const [publicDocument] = await db.insert(documents).values({
    companyId: company.id,
    title: mark("note"),
    latestBody: mark("note-body"),
    createdByAgentId: privateAgent.id,
  }).returning();
  await db.insert(issueDocuments).values({
    companyId: company.id,
    issueId: publicMention.id,
    documentId: publicDocument.id,
    key: "report",
  });

  const authorization = (id: string) => ({ principal: { type: "user" as const, id }, operation: "read" as const });
  return {
    company, member, userId, ownerId, authorization, privateBlocker, publicBlocked,
    privateMention, publicMention, hiddenWakeParent, hiddenWakeChild, memberWakeParent,
    memberWakeChild, openWakeParent, openWakeChild, listParent, publicSibling, liveChild,
  };
}

it("omits restricted blocker identity from relation summaries, lists, and attention", async () => {
  const f = await fixture();
  const svc = issueService(db);
  const outsider = f.authorization(f.ownerId);
  const member = f.authorization(f.userId);

  hidden(await svc.getRelationSummaries(f.publicBlocked.id, outsider), f.privateBlocker.id);
  const seen = await svc.getRelationSummaries(f.publicBlocked.id, member);
  expect(seen.blockedBy.map((row) => row.id)).toEqual([f.privateBlocker.id]);
  expect(seen.blockedBy[0]?.title).toContain(TOKEN);

  const listed = await svc.list(f.company.id, { includeBlockedBy: true, resourceAuthorization: outsider });
  const blocked = listed.find((row) => row.id === f.publicBlocked.id);
  hidden(blocked, f.privateBlocker.id);
  expect(listed.some((row) => row.id === f.privateBlocker.id)).toBe(false);

  const attention = await svc.listBlockerAttention(f.company.id, [f.publicBlocked], db, outsider);
  hidden(attention.get(f.publicBlocked.id), f.privateBlocker.id);

  const open = await svc.getRelationSummaries(f.publicBlocked.id);
  expect(open.blockedBy.map((row) => row.id)).toEqual([f.privateBlocker.id]);

  await db.delete(accessGroupMembers).where(eq(accessGroupMembers.membershipId, f.member.id));
  hidden(await svc.getRelationSummaries(f.publicBlocked.id, member), f.privateBlocker.id);
}, 60_000);

it("omits restricted mention titles, identifiers, and matched text", async () => {
  const f = await fixture();
  const refs = issueReferenceService(db);
  hidden(
    await refs.listIssueReferenceSummary(f.publicMention.id, db, f.authorization(f.ownerId)),
    f.privateMention.id,
  );
  const seen = await refs.listIssueReferenceSummary(f.publicMention.id, db, f.authorization(f.userId));
  expect(JSON.stringify(seen)).toContain(f.privateMention.id);
  expect(JSON.stringify(seen)).toContain(`${TOKEN}-outbound`);
  expect(JSON.stringify(seen)).toContain(`${TOKEN}-inbound`);
  const open = await refs.listIssueReferenceSummary(f.publicMention.id);
  expect(open.outbound).toHaveLength(1);
  expect(open.inbound).toHaveLength(1);
}, 60_000);

it("redacts hidden child completion payloads and keeps unscoped children visible", async () => {
  const f = await fixture();
  const svc = issueService(db);
  const hiddenWake = await svc.getWakeableParentAfterChildCompletion(f.hiddenWakeParent.id, {
    issueId: f.hiddenWakeChild.id,
    summary: `${TOKEN}-completion`,
  });
  expect(hiddenWake?.id).toBe(f.hiddenWakeParent.id);
  expect(hiddenWake?.childIssueIds).toEqual([]);
  hidden(hiddenWake, f.hiddenWakeChild.id);

  const memberWake = await svc.getWakeableParentAfterChildCompletion(f.memberWakeParent.id);
  expect(memberWake?.childIssueIds).toEqual([f.memberWakeChild.id]);
  expect(JSON.stringify(memberWake)).toContain(`${TOKEN}-member-comment`);

  const openWake = await svc.getWakeableParentAfterChildCompletion(f.openWakeParent.id);
  expect(openWake?.childIssueIds).toEqual([f.openWakeChild.id]);
}, 60_000);

it("filters child lists and live descendant counts by issue scope", async () => {
  const f = await fixture();
  const svc = issueService(db);
  const outsider = f.authorization(f.ownerId);
  const member = f.authorization(f.userId);
  const outsideChildren = await svc.list(f.company.id, {
    parentId: f.listParent.id,
    resourceAuthorization: outsider,
  });
  expect(outsideChildren.map((row) => row.id)).toEqual([f.publicSibling.id]);
  hidden(outsideChildren, f.liveChild.id);

  const memberChildren = await svc.list(f.company.id, {
    parentId: f.listParent.id,
    resourceAuthorization: member,
  });
  expect(memberChildren.map((row) => row.id).sort()).toEqual([f.publicSibling.id, f.liveChild.id].sort());

  const outsideList = await svc.list(f.company.id, {
    includeLiveDescendantSummary: true,
    resourceAuthorization: outsider,
  });
  const outsideParent = outsideList.find((row) => row.id === f.listParent.id) as { liveDescendantCount?: number } | undefined;
  expect(outsideParent?.liveDescendantCount).toBe(0);
  hidden(outsideList, f.liveChild.id);

  const memberList = await svc.list(f.company.id, {
    includeLiveDescendantSummary: true,
    resourceAuthorization: member,
  });
  const memberParent = memberList.find((row) => row.id === f.listParent.id) as { liveDescendantCount?: number } | undefined;
  expect(memberParent?.liveDescendantCount).toBe(1);
}, 60_000);

it("hides document bodies through creator and linked-issue provenance", async () => {
  const f = await fixture();
  const docs = documentService(db);
  const outsider = f.authorization(f.ownerId);
  const member = f.authorization(f.userId);
  const issue = { id: f.publicMention.id, description: null };
  hidden(await docs.getIssueDocumentPayload(issue, { companyId: f.company.id, authorization: outsider }));
  expect((await docs.getIssueDocumentPayload(issue, { authorization: outsider })).documentSummaries).toEqual([]);
  const memberPayload = await docs.getIssueDocumentPayload(issue, { companyId: f.company.id, authorization: member });
  expect(memberPayload.documentSummaries.map((row) => row.title)).toEqual(expect.arrayContaining([expect.stringContaining(TOKEN)]));
  const open = await docs.listIssueDocuments(f.publicMention.id);
  expect(open.map((row) => row.key)).toEqual(["report"]);

  hidden(await docs.listIssueDocuments(f.privateMention.id, { companyId: f.company.id, authorization: outsider }));
  const privateDocs = await docs.listIssueDocuments(f.privateMention.id, {
    companyId: f.company.id,
    authorization: member,
  });
  expect(privateDocs.map((row) => row.body)).toEqual([expect.stringContaining(`${TOKEN}-report-body`)]);
}, 60_000);

it("requires an authenticated principal once a company has a scope", async () => {
  const f = await fixture();
  const actor = {
    type: "board" as const,
    userId: f.ownerId,
    companyIds: [f.company.id],
  };
  await expect(resourceQueryContext(db, f.company.id, { ...actor, source: "local_implicit" }))
    .rejects.toMatchObject({ status: 403 });
  await expect(resourceQueryContext(db, f.company.id, { ...actor, source: "session" }))
    .resolves.toEqual({ principal: { type: "user", id: f.ownerId }, operation: "read" });
}, 60_000);
