import type { AccessGroup, AccessAudience } from "@paperclipai/shared/access-groups";
import { api } from "./client";
export interface TeamAccess { private: boolean; userId: string | null; companies: Array<{ id: string; name: string; issuePrefix: string }> }
export interface TeamWorkspace {
  groups: Array<{ id: string; name: string; role: "viewer" | "contributor"; audience: AccessAudience }>;
  agents: Array<{ id: string; name: string; role: string; title: string | null; status: string }>;
  projects: Array<{ id: string; name: string; description: string | null; status: string }>;
  notes: Array<{ id: string; groupId: string; title: string; body: string; createdAt: string }>;
}
export interface TeamInvitation { id: string; email: string; role: "viewer" | "contributor"; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }
export const accessGroupsApi = {
  invitations: (companyId: string, groupId: string) => api.get<TeamInvitation[]>(`/companies/${companyId}/access-groups/${groupId}/invites`),
  revokeInvitation: (companyId: string, groupId: string, inviteId: string) => api.delete(`/companies/${companyId}/access-groups/${groupId}/invites/${inviteId}`),
  list: (companyId: string) => api.get<AccessGroup[]>(`/companies/${companyId}/access-groups`),
  create: (companyId: string, name: string, audience: AccessAudience = "team") => api.post<AccessGroup>(`/companies/${companyId}/access-groups`, { name, audience }),
  update: (companyId: string, group: Pick<AccessGroup, "id" | "revision" | "name" | "agentIds" | "projectIds">) => {
    const { id, ...body } = group; return api.patch(`/companies/${companyId}/access-groups/${id}`, body);
  },
  addMember: (companyId: string, groupId: string, membershipId: string, role: "viewer" | "contributor") => api.put(`/companies/${companyId}/access-groups/${groupId}/members`, { membershipId, role }),
  removeMember: (companyId: string, groupId: string, memberId: string) => api.delete(`/companies/${companyId}/access-groups/${groupId}/members/${memberId}`),
  invite: (companyId: string, groupId: string, email: string, role: "viewer" | "contributor") => api.post<{ invitePath: string }>(`/companies/${companyId}/access-groups/${groupId}/invites`, { email, role }),
  access: () => api.get<TeamAccess>("/team-access"),
  workspace: (companyId: string) => api.get<TeamWorkspace>(`/companies/${companyId}/team-workspace`),
  companyNote: (companyId: string, groupId: string, title: string, body: string) => api.post(`/companies/${companyId}/access-groups/${groupId}/notes`, { title, body }),
  note: (companyId: string, groupId: string, title: string, body: string) => api.post(`/companies/${companyId}/team-workspace/${groupId}/notes`, { title, body }),
  listScopes: (companyId: string) => api.get<ResourceScopeAssignment[]>(`/companies/${companyId}/resource-scopes`),
  moveScope: (companyId: string, body: { resource: { type: ResourceScopeAssignment["resourceType"]; id: string }; change: { groupId: string | null; expectedGroupId: string | null; expectedRevision: number | null; publish?: boolean } }) => api.post(`/companies/${companyId}/resource-scopes`, body),
  openScopeMaintenance: (untilMinutes: number) => api.post<{ until: string }>("/instance/resource-scope-maintenance", { untilMinutes }),
};
export interface ResourceScopeAssignment { resourceType: "agent" | "project" | "secret"; resourceId: string; groupId: string; revision: number }
