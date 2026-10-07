import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { privateTeamMemberships } from "../services/private-team-access.js";
import { canonicalResourcePath, reviewedResourceRoute } from "./reviewed-resource-routes.js";

/** Fail closed outside the reviewed, scope-filtered routes. */
export function privateTeamBoundary(db: Db): RequestHandler {
  return async (req, res, next) => {
    try {
      const privateMemberships = await privateTeamMemberships(db, req.actor);
      if (!privateMemberships.length) return next();
      res.setHeader("Cache-Control", "no-store");
      if (canonicalResourcePath(req.path) && reviewedResourceRoute(req.method, req.path)) return next();
      res.status(403).json({ error: "This operation is not available with private team access", code: "PRIVATE_TEAM_ROUTE_DENIED" });
    } catch (error) { next(error); }
  };
}
