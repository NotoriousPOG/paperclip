import type { PermissionEditorChange, PermissionEditorData } from "@paperclipai/shared/permission-editor";
import { api } from "./client";
export const permissionEditorApi = {
  get: (companyId: string) => api.get<PermissionEditorData>(`/companies/${companyId}/permission-editor`),
  save: (companyId: string, memberId: string, change: PermissionEditorChange) =>
    api.patch<{ saved: boolean }>(`/companies/${companyId}/permission-editor/${memberId}`, change),
};
