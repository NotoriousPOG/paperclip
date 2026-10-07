import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { accessGroups, accessGroupMembers, accessGroupResources, accessGroupNotes, activityLog, agents, companies, companyMemberships, heartbeatRuns, invites, projects, type Db } from "@paperclipai/db";
import { createAccessGroupSchema, updateAccessGroupSchema, accessGroupMemberSchema, teamInviteSchema, teamInviteDefaultsSchema, teamNoteSchema } from "@paperclipai/shared/access-groups";
import { accessGroupService } from "../services/access-groups.js";
import { accessService } from "../services/access.js";
import { privateTeamMemberships } from "../services/private-team-access.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

export function accessGroupRoutes(db: Db) {
  const router = Router();
  const service = accessGroupService(db);
  const access = accessService(db);
  function id(value: unknown) { const parsed = z.string().uuid().safeParse(value); if (!parsed.success) throw notFound(); return parsed.data; }
  async function owner(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") throw forbidden("Human owner access required");
    if (req.actor.source === "local_implicit") return;
    const member = req.actor.userId ? await access.getMembership(companyId, "user", req.actor.userId) : null;
    if (member?.status !== "active" || member.membershipRole !== "owner" || member.accessMode !== "company") throw forbidden("Company owner access required");
  }
  function parse<T>(schema: z.ZodType<T>, body: unknown): T { const result = schema.safeParse(body); if (!result.success) throw badRequest("Invalid team request", result.error.issues); return result.data; }
  async function group(companyId: string, groupId: string) { const [row] = await db.select().from(accessGroups).where(and(eq(accessGroups.companyId, companyId), eq(accessGroups.id, groupId))); if (!row) throw notFound("Team not found"); return row; }
  const audit = (req: Request, companyId: string, groupId: string, action: string, details: Record<string, unknown>) => ({ companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", action, entityType: "access_group", entityId: groupId, details });

  router.get("/team-access", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const memberships = await privateTeamMemberships(db, req.actor);
    const companyIds = memberships.filter(m => m.status === "active").map(m => m.companyId);
    const rows = companyIds.length ? await db.select({ id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix }).from(companies).where(inArray(companies.id, companyIds)) : [];
    res.json({ private: memberships.length > 0, userId: req.actor.userId ?? req.actor.agentId ?? null, companies: rows });
  });
  router.get("/companies/:companyId/access-groups", async (req, res) => { const companyId = id(req.params.companyId); await owner(req, companyId); res.json(await service.list(companyId)); });
  router.post("/companies/:companyId/access-groups", async (req, res) => {
    const companyId = id(req.params.companyId); await owner(req, companyId); const input = parse(createAccessGroupSchema, req.body);
    const created = await db.transaction(async tx => { const [row] = await tx.insert(accessGroups).values({ companyId, name: input.name, audience: input.audience }).returning(); await tx.insert(activityLog).values(audit(req, companyId, row.id, "team.created", { name: row.name, audience: row.audience })); return row; });
    res.status(201).json(created);
  });
  router.patch("/companies/:companyId/access-groups/:groupId", async (req, res) => {
    const companyId = id(req.params.companyId), groupId = id(req.params.groupId); await owner(req, companyId); const input = parse(updateAccessGroupSchema, req.body);
    await db.transaction(async tx => {
      const [current] = await tx.select().from(accessGroups).where(and(eq(accessGroups.companyId, companyId), eq(accessGroups.id, groupId))).for("update");
      if (!current) throw notFound("Team not found");
      if (current.revision !== input.revision) throw conflict("Team changed. Reload before saving.");
      for (const [ids, table] of [[input.agentIds, agents], [input.projectIds, projects]] as const) {
        if (new Set(ids).size !== ids.length) throw badRequest("Duplicate resources");
        if (ids.length) { const rows = await tx.select({ id: table.id }).from(table).where(and(eq(table.companyId, companyId), inArray(table.id, ids))); if (rows.length !== ids.length) throw badRequest("Unavailable resources"); }
      }
      await tx.delete(accessGroupResources).where(and(eq(accessGroupResources.companyId, companyId), eq(accessGroupResources.groupId, groupId)));
      const resources = [...input.agentIds.map(agentId => ({ companyId, groupId, agentId })), ...input.projectIds.map(projectId => ({ companyId, groupId, projectId }))];
      if (resources.length) await tx.insert(accessGroupResources).values(resources);
      await tx.update(accessGroups).set({ name: input.name, revision: current.revision + 1 }).where(eq(accessGroups.id, groupId));
      await tx.insert(activityLog).values(audit(req, companyId, groupId, "team.resources_updated", { agentIds: input.agentIds, projectIds: input.projectIds, revision: current.revision + 1 }));
    });
    res.json({ saved: true });
  });
  router.put("/companies/:companyId/access-groups/:groupId/members", async (req, res) => {
    const companyId = id(req.params.companyId), groupId = id(req.params.groupId); await owner(req, companyId); const input = parse(accessGroupMemberSchema, req.body); const targetGroup = await group(companyId, groupId);
    if (targetGroup.audience !== "team") throw badRequest("Company-wide audiences are inherited automatically and do not accept individual members");
    await db.transaction(async tx => {
      const [member] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, input.membershipId))).for("update");
      if (!member || member.status !== "active") throw notFound("Active member not found");
      if (member.membershipRole === "owner" || (member.principalType === "user" && await access.isInstanceAdmin(member.principalId))) throw forbidden("Company owners and instance administrators cannot become private team members");
      const activeRuns = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), member.principalType === "agent" ? eq(heartbeatRuns.agentId, member.principalId) : eq(heartbeatRuns.responsibleUserId, member.principalId), inArray(heartbeatRuns.status, ["queued", "running"])));
      if (activeRuns.length) throw conflict("Stop active agent work before changing this member's access boundary");
      if (member.principalType === "agent") {
        const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, member.principalId))).for("update");
        if (!agent || agent.status !== "paused") throw conflict("Pause the agent before assigning private team membership");
      }
      await tx.update(companyMemberships).set({ accessMode: "groups", membershipRole: "viewer", updatedAt: new Date() }).where(eq(companyMemberships.id, member.id));
      await tx.insert(accessGroupMembers).values({ companyId, groupId, membershipId: member.id, role: input.role }).onConflictDoUpdate({ target: [accessGroupMembers.groupId, accessGroupMembers.membershipId], set: { role: input.role } });
      await tx.insert(activityLog).values(audit(req, companyId, groupId, "team.member_added", { membershipId: member.id, role: input.role, accessMode: "groups" }));
    });
    res.json({ saved: true });
  });
  router.delete("/companies/:companyId/access-groups/:groupId/members/:memberId", async (req, res) => {
    const companyId = id(req.params.companyId), groupId = id(req.params.groupId), membershipId = id(req.params.memberId); await owner(req, companyId); await group(companyId, groupId);
    await db.transaction(async tx => { await tx.delete(accessGroupMembers).where(and(eq(accessGroupMembers.companyId, companyId), eq(accessGroupMembers.groupId, groupId), eq(accessGroupMembers.membershipId, membershipId))); await tx.insert(activityLog).values(audit(req, companyId, groupId, "team.member_removed", { membershipId })); });
    res.json({ removed: true });
  });
  router.get("/companies/:companyId/access-groups/:groupId/invites", async (req, res) => {
    const companyId = id(req.params.companyId), groupId = id(req.params.groupId);
    await owner(req, companyId); await group(companyId, groupId);
    res.setHeader("Cache-Control", "no-store");
    const rows = await db.select().from(invites).where(and(eq(invites.companyId, companyId), eq(invites.inviteType, "team_join")));
    res.json(rows.flatMap(row => {
      const parsed = teamInviteDefaultsSchema.safeParse(row.defaultsPayload);
      if (!parsed.success || parsed.data.team.groupId !== groupId) return [];
      return [{ id: row.id, email: parsed.data.team.email, role: parsed.data.team.role, expiresAt: row.expiresAt, acceptedAt: row.acceptedAt, revokedAt: row.revokedAt }];
    }));
  });
  router.delete("/companies/:companyId/access-groups/:groupId/invites/:inviteId", async (req, res) => {
    const companyId = id(req.params.companyId), groupId = id(req.params.groupId), inviteId = id(req.params.inviteId);
    await owner(req, companyId); await group(companyId, groupId);
    await db.transaction(async tx => {
      const [row] = await tx.select().from(invites).where(and(eq(invites.companyId, companyId), eq(invites.id, inviteId), eq(invites.inviteType, "team_join"))).for("update");
      const parsed = teamInviteDefaultsSchema.safeParse(row?.defaultsPayload);
      if (!row || !parsed.success || parsed.data.team.groupId !== groupId) throw notFound("Invitation not found");
      if (row.acceptedAt) throw conflict("Invitation already accepted. Remove the team membership instead.");
      await tx.update(invites).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(invites.id, inviteId));
      await tx.insert(activityLog).values(audit(req, companyId, groupId, "team.invite_revoked", { inviteId }));
    });
    res.json({ revoked: true });
  });
  router.post("/companies/:companyId/access-groups/:groupId/invites", async (req, res) => {
    const companyId = id(req.params.companyId), groupId = id(req.params.groupId); await owner(req, companyId); const input = parse(teamInviteSchema, req.body); const targetGroup = await group(companyId, groupId);
    if (targetGroup.audience !== "team") throw badRequest("Invite into a private team; company-wide access is inherited automatically");
    const token = randomBytes(32).toString("base64url");
    await db.transaction(async tx => { const [invite] = await tx.insert(invites).values({ companyId, inviteType: "team_join", tokenHash: createHash("sha256").update(token).digest("hex"), allowedJoinTypes: "human", invitedByUserId: req.actor.userId ?? "local-board", defaultsPayload: { team: { ...input, groupId } }, expiresAt: new Date(Date.now() + 7 * 86400_000) }).returning(); await tx.insert(activityLog).values(audit(req, companyId, groupId, "team.invite_created", { inviteId: invite.id, role: input.role })); });
    res.status(201).json({ invitePath: `/invite/${token}` });
  });
  router.post("/companies/:companyId/access-groups/:groupId/notes", async (req, res) => {
    const companyId = id(req.params.companyId), groupId = id(req.params.groupId);
    await owner(req, companyId);
    const targetGroup = await group(companyId, groupId);
    if (targetGroup.audience === "team") throw badRequest("Publish private team documents from the team workspace");
    const input = parse(teamNoteSchema, req.body);
    const note = await db.transaction(async tx => {
      const [created] = await tx.insert(accessGroupNotes).values({ ...input, companyId, groupId, createdBy: req.actor.userId ?? "local-board" }).returning();
      await tx.insert(activityLog).values(audit(req, companyId, groupId, "company_document.created", { noteId: created.id, audience: targetGroup.audience }));
      return created;
    });
    res.status(201).json({ id: note.id });
  });
  router.get("/companies/:companyId/team-workspace", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const companyId = id(req.params.companyId);
    const principalType = req.actor.type === "agent" ? "agent" : "user";
    const principalId = req.actor.type === "agent" ? req.actor.agentId : req.actor.userId;
    if (!principalId) throw forbidden("Sign in required");
    if (req.actor.source === "local_implicit") assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent" && req.actor.companyId !== companyId) throw notFound();
    res.json(await service.workspace(companyId, principalType, principalId, req.actor.type === "agent" ? req.actor.onBehalfOfUserId : undefined, req.actor.type === "board" && req.actor.source === "local_implicit"));
  });
  router.post("/companies/:companyId/team-workspace/:groupId/notes", async (req, res) => {
    const companyId = id(req.params.companyId), groupId = id(req.params.groupId); const input = parse(teamNoteSchema, req.body);
    if (req.actor.type !== "board" || !req.actor.userId) throw forbidden("Human team membership required");
    const userId = req.actor.userId;
    const note = await db.transaction(async tx => {
      const [membership] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))).for("update");
      if (!membership) throw forbidden();
      const [member] = await tx.select().from(accessGroupMembers).where(and(eq(accessGroupMembers.companyId, companyId), eq(accessGroupMembers.groupId, groupId), eq(accessGroupMembers.membershipId, membership.id))).for("update");
      const [targetGroup] = await tx.select().from(accessGroups).where(and(eq(accessGroups.companyId, companyId), eq(accessGroups.id, groupId)));
      if (!targetGroup) throw notFound("Team not found");
      const ownerCanPublish = membership.membershipRole === "owner" && membership.accessMode === "company";
      if (targetGroup.audience === "team" ? member?.role !== "contributor" : !ownerCanPublish) throw forbidden("Team contributor or company-wide publishing authority required");
      const [created] = await tx.insert(accessGroupNotes).values({ ...input, companyId, groupId, createdBy: userId }).returning();
      await tx.insert(activityLog).values(audit(req, companyId, groupId, "team.note_created", { noteId: created.id })); return created;
    });
    res.status(201).json({ id: note.id });
  });
  router.use((error: unknown, _req: Request, _res: Response, next: NextFunction) => {
    const details = error as { code?: string; constraint?: string; constraint_name?: string; cause?: { code?: string; constraint?: string; constraint_name?: string } };
    const postgres = details.cause ?? details;
    if (postgres.code === "23505" && (postgres.constraint ?? postgres.constraint_name) === "access_groups_company_name_uq") return next(conflict("A team with this name already exists"));
    next(error);
  });
  return router;
}
