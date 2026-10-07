import { z } from "zod";

export const resourceScopeTargetSchema = z.object({ type: z.enum(["agent", "project", "secret"]), id: z.string().uuid() }).strict();
export const changeResourceScopeSchema = z.object({
  groupId: z.string().uuid().nullable(),
  expectedGroupId: z.string().uuid().nullable(),
  expectedRevision: z.number().int().positive().nullable(),
  publish: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if ((value.expectedGroupId === null) !== (value.expectedRevision === null)) {
    context.addIssue({ code: "custom", path: ["expectedRevision"], message: "Company scope requires a null revision; restricted scope requires its revision" });
  }
  if (value.groupId === null && value.expectedGroupId !== null && value.publish !== true) {
    context.addIssue({ code: "custom", path: ["publish"], message: "Publishing a restricted resource requires explicit confirmation" });
  }
  if (value.groupId !== null && value.publish === true) {
    context.addIssue({ code: "custom", path: ["publish"], message: "Publication applies only to company scope" });
  }
});
export type ResourceScopeTarget = z.infer<typeof resourceScopeTargetSchema>;
export type ChangeResourceScope = z.infer<typeof changeResourceScopeSchema>;
export interface ResourceScopeReceipt {
  resource: ResourceScopeTarget;
  companyId: string;
  groupId: string | null;
  revision: number | null;
  changed: boolean;
}
