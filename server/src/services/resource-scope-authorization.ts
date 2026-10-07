import { and, eq } from "drizzle-orm";
import { agents, issues, projects, resourceAccessScopes, type Db } from "@paperclipai/db";
import type { AuthorizationAction, AuthorizationActor, AuthorizationResource } from "./authorization.js";
import { resourceVisibilityService, type VisibilityTarget } from "./resource-visibility.js";

const READ_ACTIONS = new Set<AuthorizationAction>([
  "agent:read", "agent_config:read", "project:read", "issue:read", "company_scope:read",
  "decision_queue:read", "secrets:read",
]);

/** Persisted scope is an independent ceiling on existing action grants. */
export function resourceScopeAuthorizationService(db: Pick<Db, "select">) {
  const visibility = resourceVisibilityService(db);
  return {
    async decide(input: { actor: AuthorizationActor; action: AuthorizationAction; resource: AuthorizationResource }) {
      const { actor, action, resource } = input;
      const scopes = await db.select().from(resourceAccessScopes)
        .where(eq(resourceAccessScopes.companyId, resource.companyId));
      if (!scopes.length) return { allowed: true, restricted: false };
      if ((resource.type === "project" && !resource.projectId)
        || (resource.type === "agent" && !resource.agentId && action !== "agents:create")
        || (resource.type === "issue" && !resource.issueId && READ_ACTIONS.has(action))) {
        return { allowed: false, restricted: true };
      }
      const targets: VisibilityTarget[] = [];
      const addProject = (id?: string | null) => { if (id) targets.push({ type: "project", id }); };
      const addAgent = (id?: string | null) => { if (id) targets.push({ type: "agent", id }); };
      if (resource.type === "project") addProject(resource.projectId);
      if (resource.type === "agent") addAgent(resource.agentId);
      if (resource.type === "issue") {
        // Reload persisted ancestry; caller-provided project/agent fields cannot erase restrictions.
        let id = resource.issueId ?? resource.parentIssueId;
        const visited = new Set<string>();
        if (!resource.issueId) {
          addProject(resource.projectId);
          addAgent(resource.assigneeAgentId);
        }
        while (id) {
          if (visited.has(id) || visited.size >= 64) return { allowed: false, restricted: true };
          visited.add(id);
          const [issue] = await db.select({ projectId: issues.projectId, parentId: issues.parentId,
            assigneeAgentId: issues.assigneeAgentId, conversationAgentId: issues.conversationAgentId })
            .from(issues).where(and(eq(issues.companyId, resource.companyId), eq(issues.id, id)));
          if (!issue) return { allowed: false, restricted: true };
          addProject(issue.projectId);
          addAgent(issue.assigneeAgentId);
          addAgent(issue.conversationAgentId);
          id = issue.parentId;
        }
      }
      // Legacy issue foreign keys do not encode company ownership. Validate every
      // discovered reference rather than treating a foreign target as unscoped.
      const verified = new Set<string>();
      for (const target of targets) {
        const key = `${target.type}:${target.id}`;
        if (verified.has(key)) continue;
        verified.add(key);
        const table = target.type === "project" ? projects : agents;
        const [row] = await db.select({ id: table.id }).from(table)
          .where(and(eq(table.id, target.id), eq(table.companyId, resource.companyId)));
        if (!row) return { allowed: false, restricted: true };
      }
      const matched = scopes.filter(scope => targets.some(target =>
        target.type === "project" ? scope.projectId === target.id : scope.agentId === target.id));
      // Company-wide telemetry is an aggregate: it cannot bypass any constituent scope.
      const required = resource.type === "company" && action === "company_scope:read" ? scopes : matched;
      if (!required.length) return { allowed: true, restricted: false };
      const principal = actor.type === "agent" && actor.agentId ? { type: "agent" as const, id: actor.agentId }
        : actor.type === "board" && actor.userId ? { type: "user" as const, id: actor.userId } : null;
      if (!principal) return { allowed: false, restricted: true };
      for (const scope of required) {
        const target: VisibilityTarget = scope.projectId ? { type: "project", id: scope.projectId }
          : scope.agentId ? { type: "agent", id: scope.agentId } : { type: "secret", id: scope.secretId! };
        const decision = await visibility.decide(resource.companyId, target, principal,
          actor.onBehalfOfUserId, READ_ACTIONS.has(action) ? "read" : "write");
        if (!decision.allowed) return { allowed: false, restricted: true };
      }
      return { allowed: true, restricted: true };
    },
  };
}
