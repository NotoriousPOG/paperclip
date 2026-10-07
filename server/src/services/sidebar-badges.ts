import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, heartbeatRuns } from "@paperclipai/db";
import { isHeartbeatRunVisibleInMine, type SidebarBadges } from "@paperclipai/shared";
import { issueReadPredicate, resourceReadPredicate, type ResourceReadAuthorization } from "./authorized-resource-query.js";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"];
const CONTEXT_ISSUE_UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

function readableApprovalCeiling(companyId: string, authorization: ResourceReadAuthorization) {
  const readableIssue = issueReadPredicate(companyId, authorization, sql`aq_issue.id`, sql`aq_issue.company_id`);
  return sql`exists (
    select 1 from issue_approvals aq_link
    join issues aq_issue on aq_issue.id = aq_link.issue_id and aq_issue.company_id = aq_link.company_id
    where aq_link.approval_id = ${approvals.id} and aq_link.company_id = ${companyId} and ${readableIssue}
  ) and not exists (
    select 1 from issue_approvals aq_hidden
    where aq_hidden.approval_id = ${approvals.id} and aq_hidden.company_id = ${companyId}
      and not exists (
        select 1 from issues aq_issue
        where aq_issue.id = aq_hidden.issue_id and aq_issue.company_id = ${companyId} and ${readableIssue}
      )
  )`;
}

function readableRunContext(companyId: string, authorization: ResourceReadAuthorization, key: "issueId" | "taskId") {
  const issueId = sql`${heartbeatRuns.contextSnapshot} ->> ${key}`;
  const issueUuid = sql`(${issueId})::uuid`;
  return sql`case
    when ${issueId} is null or ${issueId} !~ ${CONTEXT_ISSUE_UUID} then true
    else ${issueReadPredicate(companyId, authorization, issueUuid, sql`${companyId}::uuid`)}
  end`;
}

function normalizeTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: Date | string | null | undefined,
) {
  const dismissedAt = dismissedAtByKey.get(itemKey);
  if (dismissedAt == null) return false;
  return dismissedAt >= normalizeTimestamp(activityAt);
}

export function sidebarBadgeService(db: Db) {
  return {
    get: async (
      companyId: string,
      extra?: {
        currentUserId?: string | null;
        dismissals?: ReadonlyMap<string, number>;
        joinRequests?: Array<{ id: string; updatedAt: Date | string | null; createdAt: Date | string }>;
        unreadTouchedIssues?: number;
        authorization?: ResourceReadAuthorization;
      },
    ): Promise<SidebarBadges> => {
      const authorization = extra?.authorization;
      const actionableApprovals = await db
        .select({ id: approvals.id, updatedAt: approvals.updatedAt })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
            authorization ? readableApprovalCeiling(companyId, authorization) : undefined,
          ),
        )
        .then((rows) =>
          rows.filter((row) => !isDismissed(extra?.dismissals ?? new Map(), `approval:${row.id}`, row.updatedAt)).length
        );

      const latestRunByAgent = await db
        .selectDistinctOn([heartbeatRuns.agentId], {
          id: heartbeatRuns.id,
          runStatus: heartbeatRuns.status,
          responsibleUserId: heartbeatRuns.responsibleUserId,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(agents.companyId, companyId),
            not(eq(agents.status, "terminated")),
            authorization
              ? resourceReadPredicate(companyId, authorization, {
                type: "agent",
                id: heartbeatRuns.agentId,
                companyId: heartbeatRuns.companyId,
              })
              : undefined,
            authorization ? readableRunContext(companyId, authorization, "issueId") : undefined,
            authorization ? readableRunContext(companyId, authorization, "taskId") : undefined,
          ),
        )
        .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt));

      const failedRuns = latestRunByAgent.filter((row) =>
        FAILED_HEARTBEAT_STATUSES.includes(row.runStatus)
        && (extra?.currentUserId === undefined || isHeartbeatRunVisibleInMine(row, extra.currentUserId))
        && !isDismissed(extra?.dismissals ?? new Map(), `run:${row.id}`, row.createdAt),
      ).length;

      const joinRequests = (extra?.joinRequests ?? []).filter((row) =>
        !isDismissed(
          extra?.dismissals ?? new Map(),
          `join:${row.id}`,
          row.updatedAt ?? row.createdAt,
        )
      ).length;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
      return {
        inbox: actionableApprovals + failedRuns + joinRequests + unreadTouchedIssues,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
      };
    },
  };
}
