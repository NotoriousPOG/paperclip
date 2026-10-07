import { eq } from "drizzle-orm";
import { resourceScopeMaintenance, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";

/** The lease is an operator attestation plus the caller's idle-heartbeat check. It does not scan process tables. */
export async function assertResourceScopeMaintenanceLease(db: Pick<Db, "select">) {
  const [row] = await db.select().from(resourceScopeMaintenance).where(eq(resourceScopeMaintenance.singletonKey, "default"));
  if (!row || row.until.getTime() <= Date.now()) throw forbidden("Resource restriction requires verified runtime maintenance mode");
}

export async function openResourceScopeMaintenanceLease(db: Pick<Db, "insert">, untilMinutes: number) {
  const until = new Date(Date.now() + untilMinutes * 60_000);
  const updatedAt = new Date();
  await db.insert(resourceScopeMaintenance).values({ singletonKey: "default", until, updatedAt }).onConflictDoUpdate({
    target: resourceScopeMaintenance.singletonKey,
    set: { until, updatedAt },
  });
  return { until: until.toISOString() };
}
