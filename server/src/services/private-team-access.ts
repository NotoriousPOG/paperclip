import { and, eq, or } from "drizzle-orm";
import { companyMemberships, resourceAccessScopes, type Db } from "@paperclipai/db";
type ReadDb = Pick<Db, "select">;
import type { AuthorizationActor } from "./authorization.js";

export async function isPrivateTeamPrincipal(db: ReadDb, companyId: string, principalType: "user" | "agent", principalId: string | null | undefined) {
  if (!principalId) return false;
  const [row] = await db.select({ mode: companyMemberships.accessMode }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, principalType), eq(companyMemberships.principalId, principalId),
  ));
  return row?.mode === "groups";
}

export async function privateTeamMemberships(db: ReadDb, actor: AuthorizationActor) {
  const principals = [];
  if (actor.type === "board" && actor.source !== "local_implicit" && actor.userId) {
    principals.push(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, actor.userId)));
  }
  if (actor.type === "agent" && actor.agentId) {
    principals.push(and(eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, actor.agentId)));
    if (actor.onBehalfOfUserId) principals.push(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, actor.onBehalfOfUserId)));
  }
  if (!principals.length) return [];
  // Include suspended/archived memberships: revocation must never erase the boundary.
  return db.select().from(companyMemberships).where(and(eq(companyMemberships.accessMode, "groups"), or(...principals)));
}

export const PROTECTED_EXECUTION_DENIAL = "Restricted resources require an isolated, scope-qualified runtime; execution is not enabled";

/** Host isolation is not qualified. Callers must keep execution denied while qualified is false. */
export function protectedRuntimeQualification() {
  return {
    qualified: false as const,
    reasons: [
      "Host filesystem and network isolation are not qualified for every co-resident adapter.",
      "The application pool is not pinned to a non-bypass database role.",
    ],
  };
}

/** Containment gate while restricted runtime/tool sessions are not qualified. */
export async function hasRestrictedResources(db: ReadDb, companyId?: string) {
  const [scope] = await db.select({ id: resourceAccessScopes.id }).from(resourceAccessScopes)
    .where(companyId ? eq(resourceAccessScopes.companyId, companyId) : undefined).limit(1);
  return Boolean(scope);
}
