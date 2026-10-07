import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccessGroup, AccessAudience } from "@paperclipai/shared/access-groups";
import type { ResourceScopeAssignment } from "@/api/accessGroups";
import type { PermissionEditorData } from "@paperclipai/shared/permission-editor";
import { accessGroupsApi } from "@/api/accessGroups";
import { permissionEditorApi } from "@/api/permissionEditor";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Button } from "@/components/ui/button";

const fieldClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
export function CompanyTeams() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [name, setName] = useState("");
  const [section, setSection] = useState<"groups" | "baseline">("groups");
  const [selectedId, setSelectedId] = useState("");
  const client = useQueryClient();
  useEffect(() => { setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: "Groups & access" }]); }, [setBreadcrumbs]);
  const groups = useQuery({ queryKey: ["access-groups", selectedCompanyId], queryFn: () => accessGroupsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId, retry: false });
  const catalog = useQuery({ queryKey: ["permission-editor", selectedCompanyId], queryFn: () => permissionEditorApi.get(selectedCompanyId!), enabled: !!selectedCompanyId, retry: false });
  const create = useMutation({ mutationFn: (input: { name: string; audience: AccessAudience }) => accessGroupsApi.create(selectedCompanyId!, input.name, input.audience), onSuccess: async g => { setName(""); setSelectedId(g.id); await client.invalidateQueries({ queryKey: ["access-groups", selectedCompanyId] }); } });
  const visibleGroups = groups.data?.filter(g => section === "groups" ? !g.audience || g.audience === "team" : g.audience !== "team" && !!g.audience) ?? [];
  const group = visibleGroups.find(g => g.id === selectedId) ?? visibleGroups[0];
  return <div className="max-w-3xl space-y-6">
    <div className="space-y-2"><h1 className="text-lg font-semibold">Groups & access</h1><p className="text-sm text-muted-foreground">Everyone starts with company-wide shared resources. A group adds private access for its people and agents. You only need to create each group once.</p></div>
    <p className="rounded-md border border-border p-3 text-sm">Restricted members use the same app. Lists, search, and direct reads hide resources outside their groups. Agent execution stays disabled until runtime isolation is qualified.</p>
    {[groups.error, catalog.error, create.error].filter(Boolean).map((e, i) => <p role="alert" className="text-sm text-destructive" key={i}>{e!.message}</p>)}
    {groups.isLoading && <p role="status">Loading groups...</p>}
    <div className="flex gap-2" role="group" aria-label="Access settings">
      <Button variant={section === "groups" ? "default" : "outline"} aria-pressed={section === "groups"} onClick={() => { setSection("groups"); setSelectedId(""); }}>Groups</Button>
      <Button variant={section === "baseline" ? "default" : "outline"} aria-pressed={section === "baseline"} onClick={() => { setSection("baseline"); setSelectedId(""); }}>Company baseline</Button>
    </div>
    {section === "groups" ? <>
      <p className="text-sm text-muted-foreground">Create a named group, add people and agents, then choose its shared resources. Groups do not inherit access from other groups.</p>
      <form className="flex items-end gap-3" onSubmit={e => { e.preventDefault(); create.mutate({ name, audience: "team" }); }}>
        <label className="flex-1 space-y-2 text-sm">Group name<input className={fieldClass} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. HR or Finance" maxLength={100} required /></label>
        <Button disabled={!selectedCompanyId || create.isPending || !name.trim()}>Create group</Button>
      </form>
    </> : <section className="space-y-3">
      <h2 className="font-semibold">Company baseline</h2>
      <p className="text-sm text-muted-foreground">Resources you share here are inherited automatically. People and agents have separate baseline settings so agents do not automatically receive everything a person can read. You do not need duplicate groups.</p>
      {([['company_users', 'people'], ['company_agents', 'agents']] as const).map(([audience, label]) => {
        const existing = groups.data?.find(g => g.audience === audience);
        return <Button key={audience} variant="outline" disabled={!selectedCompanyId || groups.isLoading || !!groups.error || create.isPending} onClick={() => existing ? setSelectedId(existing.id) : create.mutate({ name: `Company baseline - ${label}`, audience })}>{existing ? 'Manage' : 'Set up'} baseline for {label}</Button>;
      })}
    </section>}
    {visibleGroups.length > 0 && <label className="block space-y-2 text-sm">{section === "groups" ? "Selected group" : "Shared baseline"}<select className={fieldClass} value={group?.id ?? ""} onChange={e => setSelectedId(e.target.value)}>{visibleGroups.map(g => <option value={g.id} key={g.id}>{g.name}</option>)}</select></label>}
    {group && catalog.data && selectedCompanyId && <TeamEditor key={`${selectedCompanyId}:${group.id}:${group.revision}`} companyId={selectedCompanyId} group={group} catalog={catalog.data} />}
    {selectedCompanyId && <ResourceScopePanel companyId={selectedCompanyId} groups={groups.data ?? []} />}
  </div>;
}
function TeamEditor({ companyId, group, catalog }: { companyId: string; group: AccessGroup; catalog: PermissionEditorData }) {
  const client = useQueryClient();
  const [name, setName] = useState(group.name);
  const [agentIds, setAgentIds] = useState(group.agentIds);
  const [projectIds, setProjectIds] = useState(group.projectIds);
  const [documentTitle, setDocumentTitle] = useState("");
  const [documentBody, setDocumentBody] = useState("");
  const isTeam = !group.audience || group.audience === "team";
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "contributor">("viewer");
  const [memberId, setMemberId] = useState("");
  const [memberRole, setMemberRole] = useState<"viewer" | "contributor">("viewer");
  const [inviteUrl, setInviteUrl] = useState("");
  const invitations = useQuery({ queryKey: ["team-invitations", companyId, group.id], queryFn: () => accessGroupsApi.invitations(companyId, group.id), enabled: isTeam, retry: false });
  const [message, setMessage] = useState("");
  const mutation = useMutation({ mutationFn: (operation: () => Promise<unknown>) => operation(), onSuccess: async () => { await client.invalidateQueries({ queryKey: ["access-groups", companyId] }); await client.invalidateQueries({ queryKey: ["permission-editor", companyId] }); await client.invalidateQueries({ queryKey: ["team-invitations", companyId, group.id] }); setMessage("Saved."); } });
  const run = (op: () => Promise<unknown>) => { setMessage(""); mutation.mutate(op); };
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
  return <div className="space-y-5">
    <h2 className="text-lg font-semibold">{group.name}</h2>
    {!isTeam && <p className="text-sm text-muted-foreground">These shared resources are available to all active {group.audience === "company_agents" ? "agents" : "people"} in this company inherit the selected resources as viewers. It does not grant execution or access to unselected resources. Only explicitly selected resources are shared.</p>}
    <form className="space-y-4 rounded-xl border border-border p-5" onSubmit={e => { e.preventDefault(); run(() => accessGroupsApi.update(companyId, { id: group.id, revision: group.revision, name, agentIds, projectIds })); }}>
      <h3 className="text-sm font-semibold">Shared resources</h3>
      <p className="text-sm text-muted-foreground">These checkboxes do not remove company-wide visibility. Use Resource scope below for an exclusive move. Sharing an agent profile lets members view it. Adding an agent as a member controls what that agent can read. Neither enables agent execution.</p>
      <label className="block space-y-2 text-sm">{isTeam ? "Group name" : "Baseline name"}<input className={fieldClass} value={name} onChange={e => setName(e.target.value)} required maxLength={100} /></label>
      {([['Shared agent profiles', catalog.agents, agentIds, setAgentIds], ['Shared project overviews', catalog.projects, projectIds, setProjectIds]] as const).map(([label, options, ids, setIds]) => <fieldset key={label} className="space-y-2" disabled={mutation.isPending}><legend className="text-sm font-medium">{label}</legend>{options.map(o => <label className="flex items-center gap-2 text-sm" key={o.id}><input type="checkbox" checked={ids.includes(o.id)} onChange={() => setIds(toggle([...ids], o.id))} />{o.name}</label>)}</fieldset>)}
      <div className="flex justify-end"><Button disabled={mutation.isPending}>Save shared resources</Button></div>
    </form>
    {isTeam && <><section className="space-y-4 rounded-xl border border-border p-5"><h2 className="text-sm font-semibold">Invite to {group.name}</h2><p className="text-sm text-muted-foreground">The invitation is tied to their sign-in email and expires after seven days. Viewer can read shared resources and group documents. Contributor can also create group documents.</p>
      <label className="block space-y-2 text-sm">Invitation role<select className={fieldClass} value={role} onChange={e => setRole(e.target.value as typeof role)}><option value="viewer">Viewer</option><option value="contributor">Contributor</option></select></label>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); run(async () => { const result = await accessGroupsApi.invite(companyId, group.id, email, role); setInviteUrl(new URL(result.invitePath, window.location.origin).href); }); }}><label className="block space-y-2 text-sm">Email<input className={fieldClass} type="email" value={email} onChange={e => setEmail(e.target.value)} required /></label><div className="flex justify-end"><Button disabled={mutation.isPending}>Create invitation for {group.name}</Button></div></form>
      {inviteUrl && <label className="block space-y-2 text-sm">Invitation link<input className={fieldClass} readOnly value={inviteUrl} onFocus={e => e.target.select()} /><span className="text-muted-foreground">Copy and send this link to the intended recipient.</span></label>}
    </section>
    <section className="space-y-3 rounded-xl border border-border p-5"><h2 className="text-sm font-semibold">{group.name} invitations</h2>
      {invitations.error && <p role="alert" className="text-sm text-destructive">{invitations.error.message}</p>}
      {invitations.data?.map(invite => <div key={invite.id} className="flex items-center justify-between gap-3 text-sm"><span>{invite.email} ({invite.role}) - {invite.acceptedAt ? "Accepted" : invite.revokedAt ? "Revoked" : new Date(invite.expiresAt).getTime() <= Date.now() ? "Expired" : "Pending"}</span>{!invite.acceptedAt && !invite.revokedAt && <Button variant="outline" disabled={mutation.isPending} onClick={() => run(async () => { await accessGroupsApi.revokeInvitation(companyId, group.id, invite.id); setInviteUrl(""); })}>Revoke invitation</Button>}</div>)}
    </section>
    <section className="space-y-4 rounded-xl border border-border p-5"><h2 className="text-sm font-semibold">{group.name} members</h2><p className="text-sm text-muted-foreground">Adding someone lets them read resources moved into this group. It does not hide company-wide resources and it does not enable agent execution. Agents must be paused first.</p>
      {group.members.map(m => {
        const principal = catalog.principals.find(p => p.id === m.membershipId);
        return <div key={m.membershipId} className="flex items-center justify-between gap-3 text-sm"><span>{principal?.name ?? m.membershipId} ({principal?.principalType === "agent" ? "Agent" : "Person"}, {m.role})</span><Button variant="outline" disabled={mutation.isPending} onClick={() => run(() => accessGroupsApi.removeMember(companyId, group.id, m.membershipId))}>Remove</Button></div>;
      })}
      <label className="block space-y-2 text-sm">Person or agent<select className={fieldClass} value={memberId} onChange={e => setMemberId(e.target.value)}>
        <option value="">Select a member</option>
        {([['user', 'People'], ['agent', 'Agents']] as const).map(([type, label]) => <optgroup key={type} label={label}>{catalog.principals.filter(p => p.principalType === type && (p.editable || p.accessMode === "groups") && p.status === "active").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}
      </select></label>
      <label className="block space-y-2 text-sm">Member role<select className={fieldClass} value={memberRole} onChange={e => setMemberRole(e.target.value as typeof memberRole)}><option value="viewer">Viewer</option><option value="contributor">Contributor</option></select></label>
      <div className="flex justify-end"><Button disabled={!memberId || mutation.isPending} onClick={() => run(() => accessGroupsApi.addMember(companyId, group.id, memberId, memberRole))}>Add to {group.name} as {memberRole}</Button></div>
    </section>
    </>}
    {!isTeam && <form className="space-y-3 rounded-xl border border-border p-5" onSubmit={e => { e.preventDefault(); run(async () => { await accessGroupsApi.companyNote(companyId, group.id, documentTitle, documentBody); setDocumentTitle(""); setDocumentBody(""); }); }}><h2 className="text-sm font-semibold">Publish a company document</h2><p className="text-sm text-muted-foreground">This document will be visible to every active member of the selected audience.</p><label className="block space-y-2 text-sm">Document title<input className={fieldClass} value={documentTitle} onChange={e => setDocumentTitle(e.target.value)} required maxLength={200} /></label><label className="block space-y-2 text-sm">Document content<textarea className={fieldClass} value={documentBody} onChange={e => setDocumentBody(e.target.value)} rows={6} maxLength={100000} /></label><div className="flex justify-end"><Button disabled={mutation.isPending}>Publish document</Button></div></form>}
    {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}{message && <p role="status" className="text-sm">{message}</p>}
  </div>;
}
function ResourceScopePanel({ companyId, groups }: { companyId: string; groups: AccessGroup[] }) {
  const client = useQueryClient();
  const scopes = useQuery({ queryKey: ["resource-scopes", companyId], queryFn: () => accessGroupsApi.listScopes(companyId), retry: false });
  const [resourceType, setResourceType] = useState<ResourceScopeAssignment["resourceType"]>("project");
  const [resourceId, setResourceId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [expectedGroupId, setExpectedGroupId] = useState("");
  const [expectedRevision, setExpectedRevision] = useState("");
  const [publish, setPublish] = useState(false);
  const [message, setMessage] = useState("");
  const teamGroups = groups.filter(group => !group.audience || group.audience === "team");
  const move = useMutation({
    mutationFn: () => accessGroupsApi.moveScope(companyId, {
      resource: { type: resourceType, id: resourceId.trim() },
      change: {
        groupId: groupId || null,
        expectedGroupId: expectedGroupId.trim() || null,
        expectedRevision: expectedRevision.trim() === "" ? null : Number(expectedRevision),
        publish: groupId ? false : publish,
      },
    }),
    onSuccess: async () => { setMessage("Scope saved."); await client.invalidateQueries({ queryKey: ["resource-scopes", companyId] }); },
  });
  const maintenance = useMutation({
    mutationFn: () => accessGroupsApi.openScopeMaintenance(15),
    onSuccess: () => setMessage("Maintenance window opened. It does not stop running processes."),
  });
  return <section className="space-y-4 rounded-xl border border-border p-5">
    <h2 className="text-sm font-semibold">Resource scope</h2>
    <p className="text-sm text-muted-foreground">Moving a resource into a group removes company-wide visibility, including its children, search, files, and activity. Publishing it back is a separate confirmation.</p>
    <p className="text-sm text-muted-foreground">Opening a maintenance window records an operator attestation. It does not stop running processes. Restriction still requires idle execution.</p>
    {scopes.isLoading && <p role="status" className="text-sm">Loading resource scope...</p>}
    {scopes.error && <p role="alert" className="text-sm text-destructive">{scopes.error.message}</p>}
    {scopes.data?.map(row => {
      const groupName = teamGroups.find(group => group.id === row.groupId)?.name ?? row.groupId;
      return <button type="button" className="block text-left text-sm" key={`${row.resourceType}:${row.resourceId}`} onClick={() => { setResourceType(row.resourceType); setResourceId(row.resourceId); setGroupId(row.groupId); setExpectedGroupId(row.groupId); setExpectedRevision(String(row.revision)); setPublish(false); }}>{row.resourceType} {row.resourceId} in {groupName}, revision {row.revision}</button>;
    })}
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); setMessage(""); move.mutate(); }}>
      <label className="block space-y-2 text-sm">Resource type<select className={fieldClass} value={resourceType} onChange={event => setResourceType(event.target.value as ResourceScopeAssignment["resourceType"])}><option value="project">project</option><option value="agent">agent</option><option value="secret">secret</option></select></label>
      <label className="block space-y-2 text-sm">Resource id<input className={fieldClass} value={resourceId} onChange={event => setResourceId(event.target.value)} required /></label>
      <label className="block space-y-2 text-sm">Destination group<select className={fieldClass} value={groupId} onChange={event => setGroupId(event.target.value)}><option value="">Company-wide</option>{teamGroups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label>
      <label className="block space-y-2 text-sm">Expected current group id<input className={fieldClass} value={expectedGroupId} onChange={event => setExpectedGroupId(event.target.value)} /></label>
      <label className="block space-y-2 text-sm">Expected revision<input className={fieldClass} value={expectedRevision} onChange={event => setExpectedRevision(event.target.value)} inputMode="numeric" /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={publish} onChange={event => setPublish(event.target.checked)} />Publish to company-wide access</label>
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" disabled={maintenance.isPending} onClick={() => { setMessage(""); maintenance.mutate(); }}>Open maintenance window</Button>
        <Button disabled={move.isPending || !resourceId.trim() || (groupId === "" && !publish)}>Move resource</Button>
      </div>
    </form>
    {(move.error || maintenance.error) && <p role="alert" className="text-sm text-destructive">{(move.error ?? maintenance.error)!.message}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
