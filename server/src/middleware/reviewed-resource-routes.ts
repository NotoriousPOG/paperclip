const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const company = (rest = "") => new RegExp(`^/companies/${UUID}${rest}$`);
const issueRead = (rest = "") => new RegExp(`^/issues/${UUID}${rest}$`);
const documentKey = "[A-Za-z0-9][A-Za-z0-9_-]*";

const companyReads = [
  company("/(?:issues|projects|agents|goals|search|attention)"),
  company("/search/extract"),
  company("/secrets(?:/catalog)?"),
  company("/issues/count"),
  company("/timeline"),
  company("/sidebar-badges"),
  company("/dashboard"),
  company("/recovery-observability"),
  company("/access-groups"),
  company(`/access-groups/${UUID}/invites`),
  company("/team-workspace"),
  company("/resource-scopes"),
  company("/activity"),
];
const objectReads = [
  issueRead(),
  issueRead("/comments"),
  issueRead("/documents"),
  issueRead(`/documents/${documentKey}`),
  issueRead("/attachments"),
  issueRead("/activity"),
  issueRead("/runs"),
  new RegExp(`^/projects/${UUID}$`),
  new RegExp(`^/agents/${UUID}$`),
  new RegExp(`^/secrets/${UUID}/(?:usage|access-events)$`),
  new RegExp(`^/assets/${UUID}/content$`),
];

/** Exact admission. Handlers still have to filter titles, identifiers, and counts. */
export function reviewedResourceRoute(method: string, path: string) {
  const read = method === "GET" || method === "HEAD";
  if (read && ["/auth/get-session", "/auth/profile", "/health", "/team-access", "/cli-auth/me", "/companies"].includes(path)) return true;
  if (read && company(``).test(path)) return true;
  if (method === "POST" && path === "/auth/sign-out") return true;
  if (read && /^\/invites\/[A-Za-z0-9_-]+$/.test(path)) return true;
  if (method === "POST" && /^\/invites\/[A-Za-z0-9_-]+\/accept$/.test(path)) return true;
  if (read && (companyReads.some((pattern) => pattern.test(path)) || objectReads.some((pattern) => pattern.test(path)))) return true;
  if ((method === "PATCH" || method === "DELETE") && new RegExp(`^/secrets/${UUID}$`).test(path)) return true;
  if (method === "POST" && new RegExp(`^/secrets/${UUID}/rotate$`).test(path)) return true;
  if (method === "POST" && (company("/access-groups").test(path) || company("/resource-scopes").test(path) || path === "/instance/resource-scope-maintenance")) return true;
  if (method === "PATCH" && company(`/access-groups/${UUID}`).test(path)) return true;
  if (method === "PUT" && company(`/access-groups/${UUID}/members`).test(path)) return true;
  if (method === "DELETE" && (company(`/access-groups/${UUID}/members/${UUID}`).test(path) || company(`/access-groups/${UUID}/invites/${UUID}`).test(path))) return true;
  if (method === "POST" && (company(`/access-groups/${UUID}/invites`).test(path) || company(`/access-groups/${UUID}/notes`).test(path) || company(`/team-workspace/${UUID}/notes`).test(path))) return true;
  return false;
}

export function canonicalResourcePath(path: string) {
  return /^\/[A-Za-z0-9_/-]*$/.test(path) && !path.includes("//");
}
