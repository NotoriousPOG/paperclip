import { and, eq, inArray } from "drizzle-orm";
import { accessGroups, accessGroupMembers, agents, companyMemberships, companySecrets, projects, resourceAccessScopes, type Db } from "@paperclipai/db";

export type VisibilityPrincipal = { type: "user" | "agent"; id: string };
export type VisibilityTarget = { type: "agent" | "project" | "secret"; id: string };
export type VisibilityDecision = { allowed: boolean; reason: "company_baseline" | "group_member" | "unavailable" | "not_group_member" | "inactive_principal" | "delegator_denied" | "secret_policy_required" };

/** A read constraint only. This never grants execute, configure, secrets, or write authority. */
export function resourceVisibilityService(db: Pick<Db, "select">) {
  async function active(companyId: string, principal: VisibilityPrincipal) {
    const [member] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, principal.type), eq(companyMemberships.principalId, principal.id)));
    if (member && member.status !== "active") return null;
    if (principal.type === "user") return member ?? null;
    const [agent] = await db.select({ id: agents.id, status: agents.status }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, principal.id)));
    if (!agent || agent.status === "terminated") return null;
    return { id: member?.id ?? null };
  }

  async function decide(companyId: string, target: VisibilityTarget, principal: VisibilityPrincipal, responsibleUserId?: string | null, operation: "read" | "write" = "read"): Promise<VisibilityDecision> {
    const member = await active(companyId, principal);
    if (!member) return { allowed: false, reason: "inactive_principal" };
    const table = target.type === "agent" ? agents : target.type === "project" ? projects : companySecrets;
    const [resource] = await db.select({ id: table.id }).from(table).where(and(eq(table.companyId, companyId), eq(table.id, target.id)));
    if (!resource) return { allowed: false, reason: "unavailable" };
    const column = target.type === "agent" ? resourceAccessScopes.agentId : target.type === "project" ? resourceAccessScopes.projectId : resourceAccessScopes.secretId;
    const [scope] = await db.select().from(resourceAccessScopes).where(and(eq(resourceAccessScopes.companyId, companyId), eq(column, target.id)));
    // Secrets never acquire baseline visibility from this default-resource rule.
    if (!scope && target.type === "secret") return { allowed: false, reason: "secret_policy_required" };
    let decision: VisibilityDecision = { allowed: true, reason: "company_baseline" };
    if (scope) {
      const [group] = await db.select({ audience: accessGroups.audience }).from(accessGroups).where(and(eq(accessGroups.companyId, companyId), eq(accessGroups.id, scope.groupId)));
      if (group?.audience !== "team") return { allowed: false, reason: "unavailable" };
      const [grant] = member.id ? await db.select({ id: accessGroupMembers.membershipId }).from(accessGroupMembers).where(and(eq(accessGroupMembers.companyId, companyId), eq(accessGroupMembers.groupId, scope.groupId), eq(accessGroupMembers.membershipId, member.id), inArray(accessGroupMembers.role, operation === "write" ? ["contributor"] : ["viewer", "contributor"]))) : [];
      decision = grant ? { allowed: true, reason: "group_member" } : { allowed: false, reason: "not_group_member" };
    }
    if (decision.allowed && principal.type === "agent" && responsibleUserId) {
      const delegated = await decide(companyId, target, { type: "user", id: responsibleUserId }, null, operation);
      if (!delegated.allowed) return { allowed: false, reason: "delegator_denied" };
    }
    return decision;
  }
  return { decide };
}
