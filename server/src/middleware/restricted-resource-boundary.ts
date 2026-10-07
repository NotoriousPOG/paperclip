import type { RequestHandler } from "express";
import { resourceAccessScopes, type Db } from "@paperclipai/db";
import { canonicalResourcePath, reviewedResourceRoute } from "./reviewed-resource-routes.js";

/** Admission only: every allowed handler must still enforce current resource scope. */
export function restrictedResourceBoundary(db: Pick<Db, "select">): RequestHandler {
  return async (req, res, next) => {
    try {
      const scopes = await db.select({ companyId: resourceAccessScopes.companyId }).from(resourceAccessScopes);
      if (!scopes.length) return next();
      const path = req.path;
      const transport = /^\/(?:mcp|llms)(?:\/|$)/.test(req.originalUrl);
      res.setHeader("Cache-Control", "no-store");
      if (!transport && canonicalResourcePath(path) && reviewedResourceRoute(req.method, path)) return next();
      res.status(403).json({ error: "This operation is not available with restricted resources", code: "RESTRICTED_RESOURCE_ROUTE_DENIED" });
    } catch (error) { next(error); }
  };
}
