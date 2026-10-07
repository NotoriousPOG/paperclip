import { z } from "zod";

// Internal policy snapshots, not caller-authored request bodies. Keep separate
// from the permissive legacy principal_permission_grants.scope format.
export const SCOPED_RESOURCE_ACTIONS = [
  "company_scope:read", "project:read", "issue:read", "issue:comment", "issue:mutate",
  "tasks:assign", "agent:read", "agent:wake", "agent_config:read",
  "agent_config:update", "agent_instructions:update",
] as const;

export type ScopedResourceAction = (typeof SCOPED_RESOURCE_ACTIONS)[number];

export const SCOPED_ACTION_RESOURCE_TYPES = {
  "company_scope:read": "company",
  "project:read": "project",
  "issue:read": "issue",
  "issue:comment": "issue",
  "issue:mutate": "issue",
  "tasks:assign": "issue",
  "agent:read": "agent",
  "agent:wake": "agent",
  "agent_config:read": "agent",
  "agent_config:update": "agent",
  "agent_instructions:update": "agent",
} as const satisfies Record<ScopedResourceAction, string>;

const id = z.string().guid();
const principalId = z.string().min(1).max(256)
  .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), "Invalid principal ID");
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const actions = z.array(z.enum(SCOPED_RESOURCE_ACTIONS)).max(SCOPED_RESOURCE_ACTIONS.length)
  .refine((value) => new Set(value).size === value.length, "Duplicate actions");

export const scopedResourceGrantSchema = z.object({
  principalType: z.enum(["user", "agent"]),
  principalId,
  actions,
  expiresAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
}).strict().superRefine((grant, context) => {
  if (grant.principalType === "agent" && !id.safeParse(grant.principalId).success) {
    context.addIssue({ code: "custom", path: ["principalId"], message: "Agent principal must be a UUID" });
  }
});

export const scopedResourcePolicySchema = z.object({
  version: z.literal(1),
  companyId: id,
  scopeId: id,
  revision,
  resource: z.object({ type: z.enum(["company", "project", "issue", "agent"]), id }).strict(),
  accessMode: z.enum(["company", "members", "restricted"]),
  classification: z.enum(["normal", "internal", "confidential", "restricted"]),
  companyBaseline: z.object({ user: actions, agent: actions }).strict(),
  grants: z.array(scopedResourceGrantSchema).max(1_024),
}).strict().superRefine((policy, context) => {
  if (policy.classification === "restricted" && policy.accessMode !== "restricted") {
    context.addIssue({ code: "custom", path: ["accessMode"], message: "Restricted classification requires restricted access" });
  }
  if (policy.accessMode !== "company" && (policy.companyBaseline.user.length || policy.companyBaseline.agent.length)) {
    context.addIssue({ code: "custom", path: ["companyBaseline"], message: "Protected scopes cannot inherit company grants" });
  }
  const declared = [...policy.companyBaseline.user, ...policy.companyBaseline.agent, ...policy.grants.flatMap((grant) => grant.actions)];
  if (declared.some((action) => SCOPED_ACTION_RESOURCE_TYPES[action] !== policy.resource.type)) {
    context.addIssue({ code: "custom", path: ["grants"], message: "Action does not apply to the resource type" });
  }
});

export const scopedExecutionGrantSchema = z.object({
  version: z.literal(1),
  companyId: id,
  agentId: id,
  runId: id,
  responsibleUserId: principalId,
  issueId: id.nullable(),
  scopes: z.array(z.object({ scopeId: id, revision }).strict()).min(1).max(64)
    .refine((value) => new Set(value.map((scope) => scope.scopeId)).size === value.length, "Duplicate scopes"),
  actions,
  issuedAt: timestamp,
  expiresAt: timestamp,
  revokedAt: timestamp.nullable(),
}).strict().refine((grant) => grant.expiresAt > grant.issuedAt, "Execution lifetime must be positive");

export type ScopedResourcePolicy = z.infer<typeof scopedResourcePolicySchema>;
export type ScopedResourceGrant = z.infer<typeof scopedResourceGrantSchema>;
export type ScopedExecutionGrant = z.infer<typeof scopedExecutionGrantSchema>;
