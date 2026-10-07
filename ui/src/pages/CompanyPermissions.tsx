import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { PermissionEditorData, PermissionEditorPrincipal } from "@paperclipai/shared/permission-editor";
import { permissionEditorApi } from "@/api/permissionEditor";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";

const selectClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const permissionLabels: Record<(typeof PERMISSION_KEYS)[number], string> = {
  "agents:create": "Create agents", "agents:configure": "Configure agents",
  "agents:suggest-changes": "Suggest agent changes", "skills:create": "Create skills",
  "skills:suggest-changes": "Suggest skill changes", "environments:manage": "Manage environments",
  "tools:admin": "Administer tools", "tools:manage_connections": "Manage tool connections",
  "tools:manage_profiles": "Manage tool profiles", "tools:view_audit": "View tool audit",
  "audit:view_agent_actions": "View agent action audit", "tools:use": "Use tools",
  "tools:manage_runtime": "Manage tool runtime", "inbox:manage": "Manage inbox",
  "users:invite": "Invite users", "users:manage_permissions": "Manage member permissions",
  "tasks:assign": "Assign tasks without resource restrictions", "tasks:assign_scope": "Assign tasks within selected resources",
  "tasks:manage_active_checkouts": "Manage active task checkouts", "pipelines:write": "Update pipelines",
  "joins:approve": "Approve join requests",
};
export function CompanyPermissions() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [principalId, setPrincipalId] = useState("");
  useEffect(() => { setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: "Permissions" }]); }, [setBreadcrumbs]);
  const query = useQuery({ queryKey: ["permission-editor", selectedCompanyId], queryFn: () => permissionEditorApi.get(selectedCompanyId!), enabled: !!selectedCompanyId, retry: false });
  const principal = query.data?.principals.find(p => p.id === principalId) ?? query.data?.principals[0];
  return <div className="max-w-3xl space-y-6">
    <div className="space-y-2"><h1 className="text-lg font-semibold">Permissions</h1><p className="text-sm"><Link className="underline" to="/company/settings/teams">Manage teams and private invitations</Link></p><p className="text-sm text-muted-foreground">Manage explicit user and agent grants. Company owners control this page. <Link className="underline" to="/company/settings/members">Manage user roles in Members.</Link></p></div>
    <p className="text-sm text-muted-foreground">Removing a grant does not remove access supplied by a role, agent trust settings, or another permission. Assignment scopes limit assigning tasks; they do not make projects or conversations private.</p>
    {query.data?.localTrusted && <p className="rounded-md border border-border p-3 text-sm">Local trusted mode gives the board full control. Sign-in mode is required to enforce separate human identities.</p>}
    {query.isLoading && <p role="status">Loading permissions...</p>}
    {query.error && <p role="alert" className="text-sm text-destructive">{query.error.message}</p>}
    {query.data && <><label className="block space-y-2 text-sm"><span>User or agent</span><select className={selectClass} value={principal?.id ?? ""} onChange={e => setPrincipalId(e.target.value)}>{query.data.principals.map(p => <option key={p.id} value={p.id}>{p.name} ({p.principalType}, {p.role ?? "member"}, {p.status})</option>)}</select></label>
      {!principal && <p>No users or agents have company memberships yet.</p>}
      {principal && selectedCompanyId && <PermissionForm key={`${selectedCompanyId}:${principal.id}`} companyId={selectedCompanyId} principal={principal} data={query.data} />}
    </>}
  </div>;
}

function PermissionForm({ companyId, principal, data }: { companyId: string; principal: PermissionEditorPrincipal; data: PermissionEditorData }) {
  const client = useQueryClient();
  const [key, setKey] = useState<(typeof PERMISSION_KEYS)[number]>("tasks:assign");
  const grant = principal.grants.find(g => g.permissionKey === key);
  const [enabled, setEnabled] = useState(!!grant);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const supported = !grant?.scope || (key === "tasks:assign_scope" && Object.entries(grant.scope).every(([k, v]) => ["projectIds", "agentIds"].includes(k) && Array.isArray(v) && v.every(x => typeof x === "string")));
  useEffect(() => {
    setEnabled(!!grant); setProjectIds((grant?.scope?.projectIds as string[] | undefined) ?? []); setAgentIds((grant?.scope?.agentIds as string[] | undefined) ?? []);
  }, [key, grant]);
  const mutation = useMutation({ mutationFn: () => permissionEditorApi.save(companyId, principal.id, {
    permissionKey: key, expectedGrantId: grant?.id ?? null, enabled,
    scope: enabled && key === "tasks:assign_scope" ? { ...(projectIds.length ? { projectIds } : {}), ...(agentIds.length ? { agentIds } : {}) } : null,
  }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ["permission-editor", companyId] }); setSaved(true); } });
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
  return <form className="space-y-4 rounded-xl border border-border p-5" onSubmit={e => { e.preventDefault(); setSaved(false); mutation.mutate(); }}>
    {!principal.editable && <p className="text-sm">Private team, owner, instance administrator, and your own grants are protected from edits here. Manage private roles in Teams & access.</p>}
    <label className="block space-y-2 text-sm"><span>Permission</span><select className={selectClass} value={key} disabled={mutation.isPending} onChange={e => { setKey(e.target.value as typeof key); setSaved(false); mutation.reset(); }}>{PERMISSION_KEYS.map(k => <option key={k} value={k}>{permissionLabels[k]}{principal.grants.some(g => g.permissionKey === k) ? " (granted)" : ""}</option>)}</select></label>
    <fieldset disabled={!principal.editable || !supported || mutation.isPending} className="space-y-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); setSaved(false); }} />Explicitly grant this permission</label>
      {key === "tasks:assign_scope" && enabled && <div className="space-y-3"><p className="text-sm text-muted-foreground">Select projects, target agents, or both. When both are selected, both restrictions must match. The permission to assign tasks without resource restrictions can independently allow assignment.</p>{([['Projects', data.projects, projectIds, setProjectIds], ['Target agents', data.agents, agentIds, setAgentIds]] as const).map(([label, options, ids, setIds]) => <fieldset key={label} className="space-y-2"><legend className="text-sm font-medium">{label}</legend>{options.map(o => <label key={o.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ids.includes(o.id)} onChange={() => { setIds(toggle([...ids], o.id)); setSaved(false); }} />{o.name}</label>)}</fieldset>)}</div>}
    </fieldset>
    {!supported && <p role="status" className="text-sm">This grant uses an advanced scope and is read-only here to preserve its restrictions.</p>}
    {!supported && grant?.scope && <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(grant.scope, null, 2)}</pre>}
    {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
    {saved && <p role="status" className="text-sm">Permission saved.</p>}
    <div className="flex items-center justify-between"><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => { mutation.reset(); setSaved(false); setEnabled(!!grant); setProjectIds((grant?.scope?.projectIds as string[] | undefined) ?? []); setAgentIds((grant?.scope?.agentIds as string[] | undefined) ?? []); void client.invalidateQueries({ queryKey: ["permission-editor", companyId] }); }}>Reload</Button><Button type="submit" disabled={!principal.editable || !supported || mutation.isPending || (enabled && key === "tasks:assign_scope" && !projectIds.length && !agentIds.length)}>{mutation.isPending ? "Saving..." : "Save permission"}</Button></div>
  </form>;
}
