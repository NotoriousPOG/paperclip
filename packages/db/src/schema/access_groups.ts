import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, unique, foreignKey, primaryKey, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companyMemberships } from "./company_memberships.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";

export const accessGroups = pgTable("access_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  audience: text("audience").notNull().default("team"),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ audienceCheck: check("access_groups_audience_check", sql`${t.audience} in ('team', 'company_users', 'company_agents')`), companyIdUnique: unique("access_groups_company_id_uq").on(t.companyId, t.id), nameUnique: unique("access_groups_company_name_uq").on(t.companyId, t.name) }));

export const accessGroupMembers = pgTable("access_group_members", {
  companyId: uuid("company_id").notNull(),
  groupId: uuid("group_id").notNull(),
  membershipId: uuid("membership_id").notNull(),
  role: text("role").notNull().default("viewer"),
}, t => ({
  pk: primaryKey({ columns: [t.groupId, t.membershipId] }),
  groupFk: foreignKey({ columns: [t.companyId, t.groupId], foreignColumns: [accessGroups.companyId, accessGroups.id] }).onDelete("cascade"),
  memberFk: foreignKey({ columns: [t.companyId, t.membershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }).onDelete("cascade"),
  roleCheck: check("access_group_members_role_check", sql`${t.role} in ('viewer', 'contributor')`),
}));

export const accessGroupResources = pgTable("access_group_resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  groupId: uuid("group_id").notNull(),
  agentId: uuid("agent_id"),
  projectId: uuid("project_id"),
}, t => ({
  groupFk: foreignKey({ columns: [t.companyId, t.groupId], foreignColumns: [accessGroups.companyId, accessGroups.id] }).onDelete("cascade"),
  agentFk: foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade"),
  projectFk: foreignKey({ columns: [t.companyId, t.projectId], foreignColumns: [projects.companyId, projects.id] }).onDelete("cascade"),
  resourceCheck: check("access_group_resources_one_target", sql`num_nonnulls(${t.agentId}, ${t.projectId}) = 1`),
  agentUnique: unique("access_group_resources_agent_uq").on(t.groupId, t.agentId),
  projectUnique: unique("access_group_resources_project_uq").on(t.groupId, t.projectId),
}));

export const accessGroupNotes = pgTable("access_group_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  groupId: uuid("group_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ groupFk: foreignKey({ columns: [t.companyId, t.groupId], foreignColumns: [accessGroups.companyId, accessGroups.id] }).onDelete("cascade") }));
