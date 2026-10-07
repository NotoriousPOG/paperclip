import { pgTable, uuid, text, timestamp, unique, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyMemberships = pgTable(
  "company_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    status: text("status").notNull().default("active"),
    membershipRole: text("membership_role"),
    accessMode: text("access_mode").notNull().default("company"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdUnique: unique("company_memberships_company_id_uq").on(table.companyId, table.id),
    companyPrincipalUniqueIdx: uniqueIndex("company_memberships_company_principal_unique_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
    principalStatusIdx: index("company_memberships_principal_status_idx").on(
      table.principalType,
      table.principalId,
      table.status,
    ),
    companyStatusIdx: index("company_memberships_company_status_idx").on(table.companyId, table.status),
  }),
);
