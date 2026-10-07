import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { VisibilityPrincipal } from "./resource-visibility.js";

export interface AuthorizedResourceQuery {
  companyId: string;
  principal: VisibilityPrincipal;
  responsibleUserId?: string | null;
  operation?: "read" | "write";
  resource: { type: "agent" | "project" | "secret" | "issue"; id: SQLWrapper; companyId: SQLWrapper };
}

/** SQL admission ceiling, never an action grant. Apply before LIMIT/count/search.
 * Unscoped secrets still require the existing secret policy. No admin bypass.
 * All dynamic identity values are bound parameters; identifiers below are closed.
 */
export function authorizedResourcePredicate(input: AuthorizedResourceQuery): SQL<boolean> {
  const { companyId, principal, resource } = input;
  const principals = [principal];
  if (principal.type === "agent" && input.responsibleUserId) principals.push({ type: "user", id: input.responsibleUserId });

  function active(subject: VisibilityPrincipal): SQL {
    const membership = sql`exists (select 1 from company_memberships aq_member
      where aq_member.company_id = ${companyId} and aq_member.principal_type = ${subject.type}
      and aq_member.principal_id = ${subject.id} and aq_member.status = 'active')`;
    if (subject.type === "user") return membership;
    // Agent identity exists independently of its optional explicit group membership.
    return sql`exists (select 1 from agents aq_actor where aq_actor.id = ${subject.id}
      and aq_actor.company_id = ${companyId} and aq_actor.status <> 'terminated')
      and not exists (select 1 from company_memberships aq_member
        where aq_member.company_id = ${companyId} and aq_member.principal_type = 'agent'
        and aq_member.principal_id = ${subject.id} and aq_member.status <> 'active')`;
  }

  function target(type: "agent" | "project" | "secret", id: SQLWrapper): SQL {
    const table = sql.raw(type === "agent" ? "agents" : type === "project" ? "projects" : "company_secrets");
    const scopeColumn = sql.raw(type === "agent" ? "aq_scope.agent_id" : type === "project" ? "aq_scope.project_id" : "aq_scope.secret_id");
    const grants = principals.map(subject => sql`exists (
      select 1 from access_groups aq_group
      join access_group_members aq_grant on aq_grant.group_id = aq_group.id and aq_grant.company_id = aq_group.company_id
      join company_memberships aq_member on aq_member.id = aq_grant.membership_id and aq_member.company_id = aq_grant.company_id
      where aq_group.id = aq_scope.group_id and aq_group.company_id = ${companyId}
        and aq_group.audience = 'team' and aq_member.status = 'active'
        and aq_member.principal_type = ${subject.type} and aq_member.principal_id = ${subject.id}
        and ${input.operation === "write" ? sql`aq_grant.role = 'contributor'` : sql`aq_grant.role in ('viewer', 'contributor')`}
    )`);
    return sql`(exists (select 1 from ${table} aq_target where aq_target.id = ${id} and aq_target.company_id = ${companyId})
      and not exists (select 1 from resource_access_scopes aq_scope where ${scopeColumn} = ${id}
        and not (aq_scope.company_id = ${companyId} and ${sql.join(grants, sql` and `)})))`;
  }

  let scope: SQL;
  if (resource.type !== "issue") {
    scope = target(resource.type, resource.id);
  } else {
    // Correlate the CTE to each candidate row. The 64th node is valid only if it
    // ends the chain. Missing/foreign parents or linked resources never publish it.
    scope = sql`exists (
      with recursive aq_ancestry as (
        select aq_root.id, aq_root.company_id, aq_root.parent_id, aq_root.project_id,
          aq_root.assignee_agent_id, aq_root.conversation_agent_id,
          array[aq_root.id]::uuid[] as visited, 1 as depth, false as cycle
        from issues aq_root where aq_root.id = ${resource.id} and aq_root.company_id = ${companyId}
        union all
        select aq_parent.id, aq_parent.company_id, aq_parent.parent_id, aq_parent.project_id,
          aq_parent.assignee_agent_id, aq_parent.conversation_agent_id,
          aq_chain.visited || aq_parent.id, aq_chain.depth + 1, aq_parent.id = any(aq_chain.visited)
        from aq_ancestry aq_chain join issues aq_parent on aq_parent.id = aq_chain.parent_id
        where aq_chain.depth < 64 and not aq_chain.cycle
      )
      select 1 where exists (select 1 from aq_ancestry)
        and not exists (select 1 from aq_ancestry aq_node where
          aq_node.company_id <> ${companyId} or aq_node.cycle
          or (aq_node.depth = 64 and aq_node.parent_id is not null)
          or (aq_node.parent_id is not null and not exists
            (select 1 from issues aq_check where aq_check.id = aq_node.parent_id and aq_check.company_id = ${companyId}))
          or (aq_node.project_id is not null and not ${target("project", sql`aq_node.project_id`)})
          or (aq_node.assignee_agent_id is not null and not ${target("agent", sql`aq_node.assignee_agent_id`)})
          or (aq_node.conversation_agent_id is not null and not ${target("agent", sql`aq_node.conversation_agent_id`)}))
    )`;
  }
  return sql<boolean>`(${resource.companyId} = ${companyId} and ${sql.join(principals.map(subject => sql`(${active(subject)})`), sql` and `)} and ${scope})`;
}

export type ResourceReadAuthorization = Omit<AuthorizedResourceQuery, "companyId" | "resource">;

/** Missing authorization keeps the company baseline. A present context is a ceiling. */
export function resourceReadPredicate(
  companyId: string,
  authorization: ResourceReadAuthorization | undefined,
  resource: AuthorizedResourceQuery["resource"],
): SQL {
  if (!authorization) return sql`true`;
  return authorizedResourcePredicate({ ...authorization, companyId, resource });
}

export function issueReadPredicate(
  companyId: string,
  authorization: ResourceReadAuthorization | undefined,
  issueId: SQLWrapper,
  issueCompanyId: SQLWrapper,
): SQL {
  return resourceReadPredicate(companyId, authorization, {
    type: "issue",
    id: issueId,
    companyId: issueCompanyId,
  });
}
