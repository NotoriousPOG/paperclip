import { and, eq, inArray, isNull } from "drizzle-orm";
import { accessGroups, accessGroupMembers, accessGroupResources, accessGroupNotes, activityLog, agents, authUsers, companyMemberships, invites, joinRequests, projects, type Db } from "@paperclipai/db";
import { teamInviteDefaultsSchema } from "@paperclipai/shared/access-groups";
import { conflict, forbidden, notFound } from "../errors.js";

type Workspace = {
  groups: Array<{ id: string; name: string; audience: string; role: string }>;
  agents: Array<Pick<typeof agents.$inferSelect, "id" | "name" | "role" | "title" | "status">>;
  projects: Array<Pick<typeof projects.$inferSelect, "id" | "name" | "description" | "status">>;
  notes: Array<Pick<typeof accessGroupNotes.$inferSelect, "id" | "groupId" | "title" | "body" | "createdAt">>;
};
export function accessGroupService(db: Db) {
  async function list(companyId: string) {
    const [groups, members, resources] = await Promise.all([
      db.select().from(accessGroups).where(eq(accessGroups.companyId, companyId)),
      db.select().from(accessGroupMembers).where(eq(accessGroupMembers.companyId, companyId)),
      db.select().from(accessGroupResources).where(eq(accessGroupResources.companyId, companyId)),
    ]);
    return groups.map(g => ({ ...g, members: members.filter(m => m.groupId === g.id).map(m => ({ membershipId: m.membershipId, role: m.role })), agentIds: resources.filter(r => r.groupId === g.id && r.agentId).map(r => r.agentId!), projectIds: resources.filter(r => r.groupId === g.id && r.projectId).map(r => r.projectId!) }));
  }

  async function acceptInvite(inviteId: string, userId: string) {
    return db.transaction(async tx => {
      const [invite] = await tx.select().from(invites).where(eq(invites.id, inviteId)).for("update");
      if (!invite || invite.inviteType !== "team_join" || invite.revokedAt || invite.expiresAt.getTime() <= Date.now() || !invite.companyId) throw notFound("Invite not found");
      const parsed = teamInviteDefaultsSchema.safeParse(invite.defaultsPayload);
      if (!parsed.success) throw forbidden("Invalid team invitation");
      const { team } = parsed.data;
      // Serialize invitations for one identity, including invitations to different teams.
      const [user] = await tx.select().from(authUsers).where(eq(authUsers.id, userId)).for("update");
      if (!user || user.email.toLowerCase() !== team.email.toLowerCase()) throw forbidden("Sign in with the email address this invitation was issued to");
      const [group] = await tx.select().from(accessGroups).where(and(eq(accessGroups.id, team.groupId), eq(accessGroups.companyId, invite.companyId))).for("update");
      if (!group || group.audience !== "team") throw notFound("This team is no longer available");
      if (invite.invitedByUserId && invite.invitedByUserId !== "local-board") {
        const [inviter] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, invite.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, invite.invitedByUserId)));
        if (inviter?.status !== "active" || inviter.membershipRole !== "owner" || inviter.accessMode !== "company") throw forbidden("The inviter no longer has owner authority");
      }
      // Replays return the original receipt; they must never restore a removed grant.
      if (invite.acceptedAt) {
        const [receipt] = await tx.select().from(joinRequests).where(and(eq(joinRequests.inviteId, invite.id), eq(joinRequests.requestingUserId, userId)));
        if (!receipt) throw conflict("Invitation already accepted");
        return receipt;
      }
      const [existing] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, invite.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId))).for("update");
      if (existing && (existing.accessMode !== "groups" || existing.status !== "active")) throw conflict("An owner must review this existing company membership before assigning private team access");
      const member = existing ?? (await tx.insert(companyMemberships).values({ companyId: invite.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "viewer", accessMode: "groups" }).returning())[0];
      await tx.insert(accessGroupMembers).values({ companyId: invite.companyId, groupId: group.id, membershipId: member.id, role: team.role }).onConflictDoNothing();
      const [receipt] = await tx.insert(joinRequests).values({ inviteId: invite.id, companyId: invite.companyId, requestType: "human", requestIp: "team-invitation", requestingUserId: userId, requestEmailSnapshot: user.email, status: "approved", approvedAt: new Date(), approvedByUserId: invite.invitedByUserId }).returning();
      await tx.update(invites).set({ acceptedAt: new Date(), updatedAt: new Date() }).where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt)));
      await tx.insert(activityLog).values({ companyId: invite.companyId, actorType: "user", actorId: userId, action: "team.invite_accepted", entityType: "access_group", entityId: group.id, details: { role: team.role, membershipId: member.id } });
      return receipt;
    });
  }

  async function workspace(companyId: string, principalType: "user" | "agent", principalId: string, onBehalfOfUserId?: string | null, localOperator = false): Promise<Workspace> {
    const [membership] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, principalType), eq(companyMemberships.principalId, principalId), eq(companyMemberships.status, "active")));
    let agentIsEligible = false;
    if (principalType === "agent") {
      const [agent] = await db.select({ status: agents.status }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, principalId)));
      const [anyMembership] = await db.select({ status: companyMemberships.status }).from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, principalId)));
      agentIsEligible = !!agent && agent.status !== "terminated" && (!anyMembership || anyMembership.status === "active");
      if (!agentIsEligible) throw forbidden("Active company agent required");
    }
    if (!membership && !agentIsEligible && !localOperator) throw forbidden("Active company membership required");
    const memberships = membership ? await db.select({ id: accessGroups.id, name: accessGroups.name, audience: accessGroups.audience, role: accessGroupMembers.role }).from(accessGroupMembers).innerJoin(accessGroups, and(eq(accessGroups.id, accessGroupMembers.groupId), eq(accessGroups.companyId, accessGroupMembers.companyId))).where(and(eq(accessGroupMembers.companyId, companyId), eq(accessGroupMembers.membershipId, membership.id))) : [];
    const common = await db.select({ id: accessGroups.id, name: accessGroups.name, audience: accessGroups.audience }).from(accessGroups).where(and(eq(accessGroups.companyId, companyId), eq(accessGroups.audience, principalType === "user" ? "company_users" : "company_agents")));
    // Baseline access is read-only. It never changes membership mode or permits execution.
    const groups = [...memberships.filter(g => g.audience === "team"), ...common.map(g => ({ ...g, role: "viewer" }))];
    if (!groups.length) return { groups: [], agents: [], projects: [], notes: [] };
    const groupIds = groups.map(g => g.id);
    const resources = await db.select().from(accessGroupResources).where(and(eq(accessGroupResources.companyId, companyId), inArray(accessGroupResources.groupId, groupIds)));
    const agentIds = resources.flatMap(r => r.agentId ? [r.agentId] : []);
    const projectIds = resources.flatMap(r => r.projectId ? [r.projectId] : []);
    const sharedAgents = agentIds.length ? await db.select({ id: agents.id, name: agents.name, role: agents.role, title: agents.title, status: agents.status }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))) : [];
    const sharedProjects = projectIds.length ? await db.select({ id: projects.id, name: projects.name, description: projects.description, status: projects.status }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds))) : [];
    const notes = await db.select({ id: accessGroupNotes.id, groupId: accessGroupNotes.groupId, title: accessGroupNotes.title, body: accessGroupNotes.body, createdAt: accessGroupNotes.createdAt }).from(accessGroupNotes).where(and(eq(accessGroupNotes.companyId, companyId), inArray(accessGroupNotes.groupId, groupIds)));
    if (principalType === "agent" && onBehalfOfUserId) {
      const user = await workspace(companyId, "user", onBehalfOfUserId);
      const allowed = <T extends { id: string }>(rows: T[], userRows: Array<{ id: string }>) => {
        const ids = new Set(userRows.map(row => row.id));
        return rows.filter(row => ids.has(row.id));
      };
      // Do not reveal the agent's private team names to an unrelated delegating user.
      return { groups: allowed(groups, user.groups), agents: allowed(sharedAgents, user.agents), projects: allowed(sharedProjects, user.projects), notes: allowed(notes, user.notes) };
    }
    return { groups, agents: sharedAgents, projects: sharedProjects, notes };
  }
  return { list, acceptInvite, workspace };
}
