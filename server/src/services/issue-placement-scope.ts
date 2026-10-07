import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { resourceAccessScopes, type Db } from "@paperclipai/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";

type Placement = { parentId: string | null; projectId: string | null; assigneeAgentId: string | null };
type CurrentIssue = Placement & { id: string; status?: string | null };

/** Reject a placement the actor cannot read, and require explicit publication before a restricted issue becomes company-visible. */
export async function assertProposedIssuePlacement(db: Db, input: {
  companyId: string;
  actor?: AuthorizationActor | null;
  publish?: boolean;
  current?: CurrentIssue | null;
  proposed: { parentId?: string | null; projectId?: string | null; assigneeAgentId?: string | null };
}) {
  const [scope] = await db.select({ id: resourceAccessScopes.id }).from(resourceAccessScopes)
    .where(eq(resourceAccessScopes.companyId, input.companyId)).limit(1);
  if (!scope) return;
  const current = input.current ?? null;
  const proposed: Placement = {
    parentId: input.proposed.parentId ?? null,
    projectId: input.proposed.projectId ?? null,
    assigneeAgentId: input.proposed.assigneeAgentId ?? null,
  };
  if (current && proposed.parentId === current.parentId && proposed.projectId === current.projectId && proposed.assigneeAgentId === current.assigneeAgentId) return;
  if (!current && !proposed.parentId && !proposed.projectId && !proposed.assigneeAgentId) return;

  const auth = authorizationService(db);
  const probe: AuthorizationActor = { type: "board", source: "session", userId: randomUUID() };
  const hidden = async (action: "issue:read" | "project:read" | "agent:read", resource: { type: "issue"; issueId: string } | { type: "project"; projectId: string } | { type: "agent"; agentId: string }) => {
    const decision = await auth.decide({ actor: probe, action, resource: { companyId: input.companyId, ...resource } });
    // The probe has no membership. Only a persisted scope denial means the target is restricted.
    return !decision.allowed && decision.reason === "deny_resource_policy";
  };
  const proposedHidden = Boolean(
    (proposed.parentId && await hidden("issue:read", { type: "issue", issueId: proposed.parentId }))
    || (proposed.projectId && await hidden("project:read", { type: "project", projectId: proposed.projectId }))
    || (proposed.assigneeAgentId && await hidden("agent:read", { type: "agent", agentId: proposed.assigneeAgentId })),
  );
  const currentHidden = current ? await hidden("issue:read", { type: "issue", issueId: current.id }) : false;
  const actor = input.actor;
  const usable = Boolean(actor && actor.type !== "none" && actor.source !== "local_implicit" && (actor.type === "agent" ? actor.agentId : actor.userId));

  if (currentHidden && !proposedHidden) {
    if (input.publish !== true) throw badRequest("Explicit publication confirmation required");
    if (!usable || !current) throw forbidden("Publication requires contributor access");
    const write = await auth.decide({
      actor: actor!,
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: input.companyId,
        issueId: current.id,
        projectId: current.projectId,
        parentIssueId: current.parentId,
        assigneeAgentId: current.assigneeAgentId,
        assigneeUserId: null,
        status: current.status ?? "backlog",
      },
    });
    if (!write.allowed) throw forbidden("Publication requires contributor access");
  }

  const assertReadable = async (reader: AuthorizationActor) => {
    if (proposed.parentId && !(await auth.decide({ actor: reader, action: "issue:read", resource: { type: "issue", companyId: input.companyId, issueId: proposed.parentId } })).allowed) throw notFound("Issue not found");
    if (proposed.projectId && !(await auth.decide({ actor: reader, action: "project:read", resource: { type: "project", companyId: input.companyId, projectId: proposed.projectId } })).allowed) throw notFound("Project not found");
    if (proposed.assigneeAgentId && !(await auth.decide({ actor: reader, action: "agent:read", resource: { type: "agent", companyId: input.companyId, agentId: proposed.assigneeAgentId } })).allowed) throw notFound("Agent not found");
  };
  if (!usable) {
    if (proposedHidden || currentHidden) await assertReadable(probe);
    return;
  }
  if (proposedHidden || currentHidden) await assertReadable(actor!);
}
