import { eq, sql } from "drizzle-orm";
import { resourceAccessScopes, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import type { AuthorizedResourceQuery } from "./authorized-resource-query.js";

export type ResourceQueryContext = Omit<AuthorizedResourceQuery, "companyId" | "resource">;

type ScopeProbeRow = { scopeProbe?: string | null };
type ScopeProbeQuery = PromiseLike<ScopeProbeRow[]> & {
  limit?: (count: number) => PromiseLike<ScopeProbeRow[]>;
};

/** Trusted identity adapter. Never populate this context from query/body fields. */
export async function resourceQueryContext(
  db: Pick<Db, "select">,
  companyId: string,
  actor: AuthorizationActor,
): Promise<ResourceQueryContext | undefined> {
  // The probe literal distinguishes a real scope row from unrelated mocked selects.
  const built = db.select({
    scopeProbe: sql<string>`'resource-access-scope'`,
  }).from(resourceAccessScopes).where(eq(resourceAccessScopes.companyId, companyId)) as ScopeProbeQuery;
  const rows = await (typeof built.limit === "function" ? built.limit(1) : built);
  const scope = Array.isArray(rows)
    ? rows.find((row) => row?.scopeProbe === "resource-access-scope")
    : undefined;
  if (!scope) return undefined;
  if (actor.type === "agent" && actor.agentId) {
    return { principal: { type: "agent", id: actor.agentId }, responsibleUserId: actor.onBehalfOfUserId, operation: "read" };
  }
  if (actor.type === "board" && actor.source !== "local_implicit" && actor.userId) {
    return { principal: { type: "user", id: actor.userId }, operation: "read" };
  }
  throw forbidden("Restricted resource queries require an authenticated principal");
}
