import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { changeResourceScopeSchema, resourceScopeTargetSchema } from "@paperclipai/shared/resource-scope-management";
import { badRequest, notFound } from "../errors.js";
import { assertInstanceAdmin } from "./authz.js";
import { resourceScopeManagementService } from "../services/resource-scope-management.js";
import { assertResourceScopeMaintenanceLease, openResourceScopeMaintenanceLease } from "../services/resource-scope-maintenance.js";

const maintenanceSchema = z.object({ untilMinutes: z.number().int().min(1).max(60) }).strict();

function companyId(value: unknown) {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw notFound("Resource not found");
  return parsed.data;
}

export function resourceScopeRoutes(db: Db) {
  const router = Router();
  const scopes = resourceScopeManagementService(db, { assertRuntimeQuiesced: () => assertResourceScopeMaintenanceLease(db) });

  router.get("/companies/:companyId/resource-scopes", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await scopes.list(companyId(req.params.companyId), req.actor));
  });

  router.post("/companies/:companyId/resource-scopes", async (req, res) => {
    const resource = resourceScopeTargetSchema.safeParse(req.body?.resource);
    const change = changeResourceScopeSchema.safeParse(req.body?.change);
    if (!resource.success || !change.success) throw badRequest("Invalid resource scope change");
    res.setHeader("Cache-Control", "no-store");
    res.json(await scopes.move({ companyId: companyId(req.params.companyId), actor: req.actor, resource: resource.data, change: change.data }));
  });

  router.post("/instance/resource-scope-maintenance", async (req, res) => {
    assertInstanceAdmin(req);
    const parsed = maintenanceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid maintenance window");
    res.setHeader("Cache-Control", "no-store");
    res.json(await openResourceScopeMaintenanceLease(db, parsed.data.untilMinutes));
  });

  return router;
}
