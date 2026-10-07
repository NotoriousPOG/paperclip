import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accessGroups } from "./access_groups.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/** Absence means company-visible. Restriction is exclusive and survives group deletion attempts. */
export const resourceAccessScopes = pgTable("resource_access_scopes", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  agentId: uuid("agent_id"),
  projectId: uuid("project_id"),
  secretId: uuid("secret_id"),
  groupId: uuid("group_id").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  oneResource: check("resource_access_scopes_one_resource", sql`num_nonnulls(${t.agentId}, ${t.projectId}, ${t.secretId}) = 1`),
  positiveRevision: check("resource_access_scopes_revision_positive", sql`${t.revision} > 0`),
  agentUnique: unique("resource_access_scopes_agent_uq").on(t.agentId),
  projectUnique: unique("resource_access_scopes_project_uq").on(t.projectId),
  secretUnique: unique("resource_access_scopes_secret_uq").on(t.secretId),
  secretFk: foreignKey({ columns: [t.companyId, t.secretId], foreignColumns: [companySecrets.companyId, companySecrets.id] }).onDelete("cascade"),
  groupFk: foreignKey({ columns: [t.companyId, t.groupId], foreignColumns: [accessGroups.companyId, accessGroups.id] }).onDelete("restrict"),
  agentFk: foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade"),
  projectFk: foreignKey({ columns: [t.companyId, t.projectId], foreignColumns: [projects.companyId, projects.id] }).onDelete("cascade"),
}));
