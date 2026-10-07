import { z } from "zod";
import { Router, type Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { activityLog, agents, authUsers, companyMemberships, principalPermissionGrants, projects, type Db } from "@paperclipai/db";
import { permissionEditorChangeSchema, type PermissionEditorData } from "@paperclipai/shared/permission-editor";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { accessService } from "../services/access.js";

/** Built-in explicit grant editor. Role and runtime defaults remain independent. */
export function permissionEditorRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  async function authorize(req: Request, companyId: string) {
    if (!z.string().uuid().safeParse(companyId).success) throw notFound("Company not found");
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") throw forbidden("Only human owners can edit permissions");
    if (req.actor.source === "local_implicit") return;
    if (req.actor.userId && await access.isInstanceAdmin(req.actor.userId)) return;
    const member = req.actor.userId ? await access.getMembership(companyId, "user", req.actor.userId) : null;
    if (member?.status !== "active" || member.membershipRole !== "owner") throw forbidden("Company owner access required");
  }
  async function editable(req: Request, member: typeof companyMemberships.$inferSelect) {
    if (member.accessMode === "groups") return false;
    if (member.principalType === "agent") return true;
    return member.principalId !== req.actor.userId && member.membershipRole !== "owner"
      && !await access.isInstanceAdmin(member.principalId);
  }
  router.get("/companies/:companyId/permission-editor", async (req, res) => {
    const companyId = req.params.companyId as string;
    await authorize(req, companyId);
    const [members, grants, companyAgents, companyProjects] = await Promise.all([
      access.listMembers(companyId),
      db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId)),
      db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId)),
      db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.companyId, companyId)),
    ]);
    const userIds = members.filter(m => m.principalType === "user").map(m => m.principalId);
    const users = userIds.length ? await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds)) : [];
    const data: PermissionEditorData = {
      localTrusted: req.actor.source === "local_implicit", projects: companyProjects, agents: companyAgents,
      principals: await Promise.all(members.filter(m => m.principalType === "user" || m.principalType === "agent").map(async m => ({
        id: m.id, principalId: m.principalId, principalType: m.principalType as "user" | "agent",
        name: (m.principalType === "user" ? users : companyAgents).find(p => p.id === m.principalId)?.name ?? m.principalId,
        role: m.membershipRole, status: m.status, accessMode: m.accessMode as "company" | "groups", editable: await editable(req, m),
        grants: grants.filter(g => g.principalType === m.principalType && g.principalId === m.principalId).map(g => ({ id: g.id, permissionKey: g.permissionKey, scope: g.scope })),
      }))),
    };
    res.json(data);
  });
  router.patch("/companies/:companyId/permission-editor/:memberId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await authorize(req, companyId);
    const parsed = permissionEditorChangeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid permission change", parsed.error.issues);
    const input = parsed.data;
    const memberId = req.params.memberId as string;
    if (!z.string().uuid().safeParse(memberId).success) throw notFound("Member not found");
    await db.transaction(async tx => {
      const [member] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId))).for("update");
      if (!member) throw notFound("Member not found");
      if (!await editable(req, member)) throw forbidden("Owner, instance administrator, and self grants are protected");
      for (const [ids, table] of [[input.scope?.projectIds, projects], [input.scope?.agentIds, agents]] as const) {
        if (!ids) continue;
        const rows = await tx.select({ id: table.id }).from(table).where(and(eq(table.companyId, companyId), inArray(table.id, ids)));
        if (new Set(ids).size !== ids.length || rows.length !== ids.length) throw badRequest("Scope contains unavailable resources");
      }
      const where = and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalType, member.principalType), eq(principalPermissionGrants.principalId, member.principalId), eq(principalPermissionGrants.permissionKey, input.permissionKey));
      const [current] = await tx.select().from(principalPermissionGrants).where(where);
      if ((current?.id ?? null) !== input.expectedGrantId) throw conflict("Permissions changed. Reload before saving.");
      await tx.delete(principalPermissionGrants).where(where);
      if (input.enabled) await tx.insert(principalPermissionGrants).values({ companyId, principalType: member.principalType, principalId: member.principalId, permissionKey: input.permissionKey, scope: input.scope, grantedByUserId: req.actor.userId ?? null });
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", action: "permission.updated", entityType: "company_membership", entityId: member.id, details: { permissionKey: input.permissionKey, before: current?.scope ?? null, previouslyGranted: !!current, enabled: input.enabled, scope: input.scope } });
    });
    res.json({ saved: true });
  });
  return router;
}
