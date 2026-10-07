import { and, eq } from "drizzle-orm";
import { resourceAccessScopes, type Db } from "@paperclipai/db";
import { resourceVisibilityService, type VisibilityPrincipal } from "./resource-visibility.js";

export type RestrictedSecretContext = {
  actorType?: string;
  actorId?: string | null;
  consumerType?: string;
  consumerId?: string;
  responsibleUserId?: string | null;
};

/** Additional restriction only: callers must still enforce secret permissions and bindings. */
export function restrictedSecretAccessService(db: Pick<Db, "select">) {
  const visibility = resourceVisibilityService(db);
  return {
    async allowed(companyId: string, secretId: string, context?: RestrictedSecretContext, operation: "read" | "write" = "read"): Promise<boolean> {
      const [scope] = await db.select({ id: resourceAccessScopes.id }).from(resourceAccessScopes)
        .where(and(eq(resourceAccessScopes.companyId, companyId), eq(resourceAccessScopes.secretId, secretId)));
      if (!scope) return true;
      const principals: VisibilityPrincipal[] = [];
      if ((context?.actorType === "user" || context?.actorType === "agent") && context.actorId) {
        principals.push({ type: context.actorType, id: context.actorId });
      }
      if ((context?.consumerType === "agent" || context?.consumerType === "agent_api") && context.consumerId) {
        principals.push({ type: "agent", id: context.consumerId });
      }
      // A system/plugin context cannot silently stand in for an authorized principal.
      if (!principals.length) return false;
      if (context?.responsibleUserId) principals.push({ type: "user", id: context.responsibleUserId });
      for (const principal of principals) {
        if (!(await visibility.decide(companyId, { type: "secret", id: secretId }, principal, null, operation)).allowed) return false;
      }
      return true;
    },
  };
}
