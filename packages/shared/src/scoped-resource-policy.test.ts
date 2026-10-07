import { describe, expect, it } from "vitest";
import { scopedResourcePolicySchema, type ScopedResourcePolicy } from "./scoped-resource-policy.js";

const id = "10000000-0000-4000-8000-000000000001";
function policy(): ScopedResourcePolicy {
  return {
    version: 1, companyId: id, scopeId: id, revision: 1,
    resource: { type: "issue", id }, accessMode: "restricted", classification: "restricted",
    companyBaseline: { user: [], agent: [] },
    grants: [{ principalType: "user", principalId: "alice", actions: ["issue:read"], expiresAt: null, revokedAt: null }],
  };
}

describe("strict scoped policy contract", () => {
  it("accepts the versioned contract", () => {
    expect(scopedResourcePolicySchema.safeParse(policy()).success).toBe(true);
  });

  it("rejects deleting any mandatory field", () => {
    for (const key of Object.keys(policy())) {
      const value: Record<string, unknown> = policy();
      delete value[key];
      expect(scopedResourcePolicySchema.safeParse(value).success, key).toBe(false);
    }
  });

  it("rejects 256 generated unknown fields rather than allowing legacy metadata", () => {
    for (let index = 0; index < 256; index++) {
      const unknown = { [`unknown_${index}`]: index };
      for (const value of [
        { ...policy(), ...unknown },
        { ...policy(), resource: { ...policy().resource, ...unknown } },
        { ...policy(), companyBaseline: { ...policy().companyBaseline, ...unknown } },
        { ...policy(), grants: [{ ...policy().grants[0], ...unknown }] },
      ]) expect(scopedResourcePolicySchema.safeParse(value).success, `case=${index}`).toBe(false);
    }
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", null])("rejects invalid revision %s", (revision) => {
    expect(scopedResourcePolicySchema.safeParse({ ...policy(), revision }).success).toBe(false);
  });

  it.each([
    { principalId: " alice" }, { principalId: "alice\u0000" }, { principalId: "" },
    { principalType: "group" }, { principalType: "agent", principalId: "alice" },
    { actions: ["issue:read", "issue:read"] },
    { actions: ["project:read"] }, { actions: ["unknown:read"] },
    { expiresAt: -1 }, { revokedAt: "false" },
  ])("rejects malformed grants: %j", (patch) => {
    expect(scopedResourcePolicySchema.safeParse({ ...policy(), grants: [{ ...policy().grants[0], ...patch }] }).success).toBe(false);
  });

  it("bounds the snapshot size", () => {
    expect(scopedResourcePolicySchema.safeParse({ ...policy(), grants: Array.from({ length: 1_025 }, () => policy().grants[0]) }).success).toBe(false);
  });
});
