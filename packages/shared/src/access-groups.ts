import { z } from "zod";
export const TEAM_ROLES = ["viewer", "contributor"] as const;
export const teamRoleSchema = z.enum(TEAM_ROLES);
export const ACCESS_AUDIENCES = ["team", "company_users", "company_agents"] as const;
export type AccessAudience = typeof ACCESS_AUDIENCES[number];
export const createAccessGroupSchema = z.object({ name: z.string().trim().min(1).max(100), audience: z.enum(ACCESS_AUDIENCES).default("team") }).strict();
export const updateAccessGroupSchema = z.object({
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  agentIds: z.array(z.string().uuid()).max(100),
  projectIds: z.array(z.string().uuid()).max(100),
}).strict();
export const accessGroupMemberSchema = z.object({ membershipId: z.string().uuid(), role: teamRoleSchema }).strict();
export const teamInviteSchema = z.object({ email: z.string().email().max(254).transform(s => s.toLowerCase()), role: teamRoleSchema }).strict();
export const teamInviteDefaultsSchema = z.object({ team: z.object({ email: z.string().email(), groupId: z.string().uuid(), role: teamRoleSchema }).strict() }).strict();
export const teamNoteSchema = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(100_000) }).strict();
export interface AccessGroup {
  id: string; companyId: string; name: string; revision: number; audience: AccessAudience;
  agentIds: string[]; projectIds: string[];
  members: Array<{ membershipId: string; role: typeof TEAM_ROLES[number] }>;
}
