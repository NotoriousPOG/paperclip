import {
  SCOPED_ACTION_RESOURCE_TYPES,
  scopedExecutionGrantSchema,
  scopedResourcePolicySchema,
  type ScopedResourceAction,
  type ScopedResourcePolicy,
} from "@paperclipai/shared/scoped-resource-policy";
import type { AuthorizationActor, AuthorizationResource } from "./authorization.js";

export type ScopedResourceDenial =
  | "invalid_policy" | "resource_mismatch" | "unsupported_action" | "unauthenticated"
  | "missing_grant" | "responsible_user_denied" | "invalid_execution_grant";

export type ScopedResourceDecision =
  | { allowed: true; revision: number }
  | { allowed: false; reason: ScopedResourceDenial };

function resourceId(resource: AuthorizationResource) {
  switch (resource.type) {
    case "company": return resource.companyId;
    case "project": return resource.projectId;
    case "issue": return resource.issueId;
    case "agent": return resource.agentId;
  }
}

function permits(policy: ScopedResourcePolicy, type: "user" | "agent", id: string, action: ScopedResourceAction, now: number) {
  return (policy.accessMode === "company" && policy.companyBaseline[type].includes(action))
    || policy.grants.some((grant) => grant.principalType === type && grant.principalId === id
      && grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now)
      && grant.actions.includes(action));
}

/**
 * A narrowing check only. Callers must still run the existing authorization
 * service and load policy/execution snapshots from trusted current storage.
 * This first increment deliberately has no public policy input or activation.
 */
export function evaluateScopedResourcePolicy(input: {
  actor: AuthorizationActor;
  action: string;
  resource: AuthorizationResource;
  policy: unknown;
  executionGrant?: unknown;
}, now = Date.now()): ScopedResourceDecision {
  const deny = (reason: ScopedResourceDenial): ScopedResourceDecision => ({ allowed: false, reason });
  if (!Number.isSafeInteger(now) || now < 0) return deny("invalid_policy");
  const parsed = scopedResourcePolicySchema.safeParse(input.policy);
  if (!parsed.success) return deny("invalid_policy");
  const policy = parsed.data;
  if (input.resource.companyId !== policy.companyId || input.resource.type !== policy.resource.type
    || resourceId(input.resource) !== policy.resource.id) return deny("resource_mismatch");
  if (!Object.hasOwn(SCOPED_ACTION_RESOURCE_TYPES, input.action)) return deny("unsupported_action");
  const action = input.action as ScopedResourceAction;
  if (SCOPED_ACTION_RESOURCE_TYPES[action] !== input.resource.type) return deny("unsupported_action");

  const actor = input.actor;
  if (actor.type === "board") {
    if (!actor.userId || (actor.source !== "session" && actor.source !== "board_key")) return deny("unauthenticated");
    return permits(policy, "user", actor.userId, action, now)
      ? { allowed: true, revision: policy.revision } : deny("missing_grant");
  }
  if (actor.type !== "agent" || !actor.agentId || actor.companyId !== policy.companyId
    || (actor.source !== "agent_jwt" && actor.source !== "agent_key")) return deny("unauthenticated");
  if (!permits(policy, "agent", actor.agentId, action, now)) return deny("missing_grant");
  if (!actor.onBehalfOfUserId || !permits(policy, "user", actor.onBehalfOfUserId, action, now)) {
    return deny("responsible_user_denied");
  }

  // Automation delegation is intentionally unsupported until its durable
  // lifecycle exists. Missing human provenance never becomes agent-only access.
  const execution = scopedExecutionGrantSchema.safeParse(input.executionGrant);
  if (!execution.success) return deny("invalid_execution_grant");
  const grant = execution.data;
  if (grant.companyId !== policy.companyId || grant.agentId !== actor.agentId
    || !actor.runId || grant.runId !== actor.runId || grant.responsibleUserId !== actor.onBehalfOfUserId
    || grant.revokedAt !== null || grant.issuedAt > now || grant.expiresAt <= now
    || !grant.actions.includes(action)
    || !grant.scopes.some((scope) => scope.scopeId === policy.scopeId && scope.revision === policy.revision)
    || (input.resource.type === "issue" && grant.issueId !== input.resource.issueId)) {
    return deny("invalid_execution_grant");
  }
  return { allowed: true, revision: policy.revision };
}
