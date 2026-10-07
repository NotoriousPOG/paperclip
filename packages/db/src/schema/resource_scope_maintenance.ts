import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Operator attestation that a scope restriction may be attempted. This row does not stop processes. */
export const resourceScopeMaintenance = pgTable("resource_scope_maintenance", {
  singletonKey: text("singleton_key").primaryKey().default("default"),
  until: timestamp("until", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
