import { and, eq, inArray } from "drizzle-orm";
import { accessGroups, activityLog, agents, authUsers, companies, companyMemberships, companySecrets, heartbeatRuns, projects, resourceAccessScopes, type Db } from "@paperclipai/db";
import { changeResourceScopeSchema, resourceScopeTargetSchema, type ChangeResourceScope, type ResourceScopeReceipt, type ResourceScopeTarget } from "@paperclipai/shared/resource-scope-management";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";

/** Internal operation only; no public activation route until runtime isolation is qualified.
 * The maintenance guard must ensure the host remains quiesced for the ENTIRE move.
 * Merely finding no queued/running heartbeat rows does not fence probes or processes.
 */
export function resourceScopeManagementService(db: Db, options: { assertRuntimeQuiesced?: () => Promise<void> } = {}) {
  async function assertOwner(companyId: string, actor: AuthorizationActor) {
    if (actor.type !== "board" || !actor.userId || actor.source === "local_implicit") throw forbidden("Authenticated company owner required");
    const [membership] = await db.select({ status: companyMemberships.status, membershipRole: companyMemberships.membershipRole }).from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, actor.userId)));
    if (membership?.status !== "active" || membership.membershipRole !== "owner") throw forbidden("Authenticated company owner required");
  }
  async function list(companyId: string, actor: AuthorizationActor) {
    await assertOwner(companyId, actor);
    const rows = await db.select({
      agentId: resourceAccessScopes.agentId,
      projectId: resourceAccessScopes.projectId,
      secretId: resourceAccessScopes.secretId,
      groupId: resourceAccessScopes.groupId,
      revision: resourceAccessScopes.revision,
    }).from(resourceAccessScopes).where(eq(resourceAccessScopes.companyId, companyId));
    return rows.map((row) => ({
      resourceType: row.agentId ? "agent" as const : row.projectId ? "project" as const : "secret" as const,
      resourceId: (row.agentId ?? row.projectId ?? row.secretId)!,
      groupId: row.groupId,
      revision: row.revision,
    }));
  }
  async function move(input: { companyId: string; actor: AuthorizationActor; resource: ResourceScopeTarget; change: ChangeResourceScope }): Promise<ResourceScopeReceipt> {
    const parsedTarget = resourceScopeTargetSchema.safeParse(input.resource);
    const parsedChange = changeResourceScopeSchema.safeParse(input.change);
    if (!parsedTarget.success || !parsedChange.success) throw badRequest("Invalid resource scope change");
    const resource = parsedTarget.data, change = parsedChange.data;
    const { actor, companyId } = input;
    if (actor.type !== "board" || !actor.userId || actor.source === "local_implicit") throw forbidden("Authenticated company owner required");
    const userId = actor.userId;
    return db.transaction(async tx => {
      // Serialize every scope edit for the company, including insertion from an
      // absent scope row. Lock the persisted target too, before checking CAS.
      const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("update");
      if (!company) throw notFound("Resource not found");
      const [user] = await tx.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId)).for("share");
      const [membership] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId))).for("share");
      if (!user || membership?.status !== "active" || membership.membershipRole !== "owner") throw forbidden("Authenticated company owner required");
      const table = resource.type === "agent" ? agents : resource.type === "project" ? projects : companySecrets;
      const [target] = await tx.select({ id: table.id }).from(table).where(and(eq(table.companyId, companyId), eq(table.id, resource.id))).for("update");
      if (!target) throw notFound("Resource not found");
      const column = resource.type === "agent" ? resourceAccessScopes.agentId : resource.type === "project" ? resourceAccessScopes.projectId : resourceAccessScopes.secretId;
      const [current] = await tx.select().from(resourceAccessScopes).where(and(eq(resourceAccessScopes.companyId, companyId), eq(column, resource.id))).for("update");
      async function requireTeamGroup(groupId: string) {
        const [group] = await tx.select({ id: accessGroups.id }).from(accessGroups).where(and(eq(accessGroups.companyId, companyId), eq(accessGroups.id, groupId), eq(accessGroups.audience, "team"))).for("share");
        if (!group) throw notFound("Resource scope not available");
      }
      // Company owners administer scope assignment. Membership is not a content grant.
      if (change.groupId) await requireTeamGroup(change.groupId);
      if ((current?.groupId ?? null) !== change.expectedGroupId || (current?.revision ?? null) !== change.expectedRevision) throw conflict("Resource scope changed; refresh before retrying");
      if ((current?.groupId ?? null) === change.groupId) return { resource, companyId, groupId: change.groupId, revision: current?.revision ?? null, changed: false };
      if (change.groupId) {
        if (!options.assertRuntimeQuiesced) throw forbidden("Resource restriction requires verified runtime maintenance mode");
        await options.assertRuntimeQuiesced();
        const [activeRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.status, ["queued", "running"])).limit(1);
        if (activeRun) throw conflict("Resource restriction requires idle agent execution");
      }
      let revision: number | null = null;
      if (change.groupId === null) {
        if (change.publish !== true) throw badRequest("Explicit publication confirmation required");
        await tx.delete(resourceAccessScopes).where(eq(resourceAccessScopes.id, current!.id));
      } else if (current) {
        revision = current.revision + 1;
        await tx.update(resourceAccessScopes).set({ groupId: change.groupId, revision, updatedAt: new Date() }).where(eq(resourceAccessScopes.id, current.id));
      } else {
        revision = 1;
        await tx.insert(resourceAccessScopes).values({ companyId, groupId: change.groupId,
          agentId: resource.type === "agent" ? resource.id : null,
          projectId: resource.type === "project" ? resource.id : null,
          secretId: resource.type === "secret" ? resource.id : null });
      }
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: userId,
        action: "resource.scope_changed", entityType: resource.type, entityId: resource.id,
        details: { previousGroupId: current?.groupId ?? null, groupId: change.groupId, previousRevision: current?.revision ?? null, revision, published: change.groupId === null } });
      return { resource, companyId, groupId: change.groupId, revision, changed: true };
    });
  }
  return { list, move };
}
