import { z } from "zod";
import { PERMISSION_KEYS } from "./constants.js";

export const permissionEditorChangeSchema = z.object({
  permissionKey: z.enum(PERMISSION_KEYS),
  expectedGrantId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  scope: z.object({
    projectIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    agentIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.scope && (value.permissionKey !== "tasks:assign_scope" || !Object.keys(value.scope).length)) {
    ctx.addIssue({ code: "custom", message: "Resource restrictions require a nonempty task assignment scope." });
  }
  if (value.enabled && value.permissionKey === "tasks:assign_scope" && !value.scope) {
    ctx.addIssue({ code: "custom", message: "Scoped assignment requires selected resources." });
  }
});
export type PermissionEditorChange = z.infer<typeof permissionEditorChangeSchema>;
export interface PermissionEditorPrincipal {
  id: string;
  principalType: "user" | "agent";
  principalId: string;
  name: string;
  role: string | null;
  status: string;
  editable: boolean;
  accessMode?: "company" | "groups";
  grants: Array<{ id: string; permissionKey: string; scope: Record<string, unknown> | null }>;
}
export interface PermissionEditorData {
  principals: PermissionEditorPrincipal[];
  projects: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
  localTrusted: boolean;
}
