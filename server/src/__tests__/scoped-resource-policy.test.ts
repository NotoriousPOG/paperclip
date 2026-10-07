import { describe, expect, it } from "vitest";
import type { ScopedExecutionGrant, ScopedResourcePolicy } from "@paperclipai/shared/scoped-resource-policy";
import { evaluateScopedResourcePolicy } from "../services/scoped-resource-policy.js";
import type { AuthorizationActor } from "../services/authorization.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const scopeId = "10000000-0000-4000-8000-000000000002";
const issueId = "10000000-0000-4000-8000-000000000003";
const agentId = "10000000-0000-4000-8000-000000000004";
const runId = "10000000-0000-4000-8000-000000000005";
const otherId = "10000000-0000-4000-8000-000000000006";
const now = 1_000;
const resource = { type: "issue" as const, companyId, issueId };
const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId, agentId, runId, onBehalfOfUserId: "alice" };

function policy(): ScopedResourcePolicy {
  return {
    version: 1, companyId, scopeId, revision: 1,
    resource: { type: "issue", id: issueId }, accessMode: "restricted", classification: "restricted",
    companyBaseline: { user: [], agent: [] },
    grants: [
      { principalType: "user", principalId: "alice", actions: ["issue:read"], expiresAt: null, revokedAt: null },
      { principalType: "agent", principalId: agentId, actions: ["issue:read"], expiresAt: null, revokedAt: null },
    ],
  };
}

function execution(): ScopedExecutionGrant {
  return {
    version: 1, companyId, agentId, runId, responsibleUserId: "alice", issueId,
    scopes: [{ scopeId, revision: 1 }], actions: ["issue:read"], issuedAt: 0, expiresAt: 2_000, revokedAt: null,
  };
}

describe("scoped resource narrowing policy", () => {
  it("requires user, agent, resource, and live execution authority", () => {
    expect(evaluateScopedResourcePolicy({ actor, action: "issue:read", resource, policy: policy(), executionGrant: execution() }, now))
      .toEqual({ allowed: true, revision: 1 });
  });

  it.each(["session", "board_key"] as const)("allows an explicitly granted %s user without a run", (source) => {
    expect(evaluateScopedResourcePolicy({ actor: { type: "board", userId: "alice", source }, action: "issue:read", resource, policy: policy() }, now).allowed).toBe(true);
  });

  it.each(["local_implicit", "cloud_control", "none"] as const)("does not accept %s as authenticated scoped access", (source) => {
    expect(evaluateScopedResourcePolicy({ actor: { type: "board", userId: "alice", source, isInstanceAdmin: true }, action: "issue:read", resource, policy: policy() }, now).allowed).toBe(false);
  });

  it("does not let instance administrators bypass resource grants", () => {
    expect(evaluateScopedResourcePolicy({ actor: { type: "board", userId: "bob", source: "session", isInstanceAdmin: true }, action: "issue:read", resource, policy: policy() }, now))
      .toEqual({ allowed: false, reason: "missing_grant" });
  });

  it.each([undefined, null, {}, [], false, 1, "allow", { version: 2 }])("denies malformed snapshots: %j", (value) => {
    expect(evaluateScopedResourcePolicy({ actor, action: "issue:read", resource, policy: value }, now))
      .toEqual({ allowed: false, reason: "invalid_policy" });
  });

  it.each(["__proto__", "constructor", "project:read", "unknown:read"])("denies unsupported or mismatched action %s", (action) => {
    expect(evaluateScopedResourcePolicy({ actor, action, resource, policy: policy(), executionGrant: execution() }, now).allowed).toBe(false);
  });

  it.each([
    { companyId: otherId }, { agentId: otherId }, { runId: otherId }, { responsibleUserId: "bob" },
    { issueId: otherId }, { issueId: null }, { scopes: [{ scopeId: otherId, revision: 1 }] },
    { scopes: [{ scopeId, revision: 2 }] }, { actions: [] }, { revokedAt: 0 },
    { expiresAt: now }, { issuedAt: now + 1 }, { version: 2 }, { extra: true },
  ])("denies substituted, expired, or widened execution grants: %j", (patch) => {
    expect(evaluateScopedResourcePolicy({ actor, action: "issue:read", resource, policy: policy(), executionGrant: { ...execution(), ...patch } }, now).allowed).toBe(false);
  });

  it("denies company, resource, and resource-type substitution", () => {
    for (const target of [{ ...resource, companyId: otherId }, { ...resource, issueId: otherId }, { type: "project" as const, companyId, projectId: issueId }]) {
      expect(evaluateScopedResourcePolicy({ actor, action: "issue:read", resource: target, policy: policy(), executionGrant: execution() }, now))
        .toEqual({ allowed: false, reason: "resource_mismatch" });
    }
  });

  it("treats explicit company baselines as grants only for company-visible policies", () => {
    const value = policy();
    value.accessMode = "company";
    value.classification = "internal";
    value.grants = [];
    value.companyBaseline = { user: ["issue:read"], agent: ["issue:read"] };
    expect(evaluateScopedResourcePolicy({ actor, action: "issue:read", resource, policy: value, executionGrant: execution() }, now).allowed).toBe(true);
    for (const accessMode of ["members", "restricted"] as const) {
      expect(evaluateScopedResourcePolicy({ actor, action: "issue:read", resource, policy: { ...value, accessMode }, executionGrant: execution() }, now).allowed).toBe(false);
    }
  });

  it("fails closed after each step in a grant/revoke/renew sequence", () => {
    const value = policy();
    const grant = execution();
    const check = () => evaluateScopedResourcePolicy({ actor, action: "issue:read", resource, policy: value, executionGrant: grant }, now).allowed;
    expect(check()).toBe(true);
    value.grants[0]!.revokedAt = now;
    expect(check()).toBe(false);
    value.grants[0]!.revokedAt = null;
    value.revision++;
    expect(check()).toBe(false);
    grant.scopes[0]!.revision = value.revision;
    expect(check()).toBe(true);
    grant.revokedAt = now;
    expect(check()).toBe(false);
  });

  it("matches an independent boolean oracle for 1024 generated cases (seed 0x5c0fed)", () => {
    // Fixed seed and case index make a failing example reproducible. The oracle
    // is a conjunction of independently generated gates, not the evaluator.
    let seed = 0x5c0fed;
    const flip = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 24) % 5 !== 0; };
    for (let index = 0; index < 1_024; index++) {
      const gates = Array.from({ length: 8 }, flip);
      const [user, agent, action, currentRevision, unexpired, unrevoked, company, task] = gates;
      const value = policy();
      const grant = execution();
      if (!user) value.grants[0]!.actions = [];
      if (!agent) value.grants[1]!.actions = [];
      if (!action) grant.actions = [];
      if (!currentRevision) value.revision++;
      if (!unexpired) grant.expiresAt = now;
      if (!unrevoked) grant.revokedAt = 0;
      if (!company) grant.companyId = otherId;
      if (!task) grant.issueId = otherId;
      const result = evaluateScopedResourcePolicy({ actor, action: "issue:read", resource, policy: value, executionGrant: grant }, now);
      expect(result.allowed, `seed=0x5c0fed case=${index} gates=${JSON.stringify(gates)}`).toBe(gates.every(Boolean));
      // Removing all principal grants cannot turn any denied case into allow.
      value.grants = [];
      expect(evaluateScopedResourcePolicy({ actor, action: "issue:read", resource, policy: value, executionGrant: grant }, now).allowed).toBe(false);
    }
  });
});
