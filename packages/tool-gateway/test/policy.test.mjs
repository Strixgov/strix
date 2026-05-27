import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PolicyEngine,
  validateRuleset,
  computePolicyVersion,
} from "../src/policy.mjs";

const defaultCaps = {
  "filesystem.read": { id: "filesystem.read", risk: "LOW", mode: "READ" },
  "filesystem.write": { id: "filesystem.write", risk: "HIGH", mode: "WRITE" },
  "filesystem.delete": {
    id: "filesystem.delete",
    risk: "CRITICAL",
    mode: "WRITE",
  },
  "shell.exec": { id: "shell.exec", risk: "CRITICAL", mode: "EXECUTE" },
};

function engineWith(rules, caps = defaultCaps) {
  return new PolicyEngine(rules, { ...caps });
}

test("exact rule wins over default and prefix", () => {
  const e = engineWith({
    rules: { "filesystem.read": "ALLOW", "filesystem.*": "DENY" },
    default: "DENY",
  });
  assert.equal(
    e.evaluate({ capabilityId: "filesystem.read" }).decision,
    "ALLOW",
  );
});

test("longest prefix wins over shorter", () => {
  const e = engineWith({
    rules: { "filesystem.*": "DENY", "filesystem.write.*": "APPROVAL_REQUIRED" },
  });
  // `filesystem.write` matches `filesystem.*` not `filesystem.write.*`
  // but adding a deeper cap should pick the longer prefix.
  e.registerCapability({
    id: "filesystem.write.atomic",
    risk: "HIGH",
    mode: "WRITE",
  });
  assert.equal(
    e.evaluate({ capabilityId: "filesystem.write.atomic" }).decision,
    "APPROVAL_REQUIRED",
  );
  assert.equal(
    e.evaluate({ capabilityId: "filesystem.write" }).decision,
    "DENY",
  );
});

test("riskOverrides apply when no rule matches", () => {
  const e = engineWith({
    rules: {},
    riskOverrides: { CRITICAL: "DENY", HIGH: "APPROVAL_REQUIRED" },
    default: "ALLOW",
  });
  assert.equal(
    e.evaluate({ capabilityId: "filesystem.delete" }).decision,
    "DENY",
  );
  assert.equal(
    e.evaluate({ capabilityId: "filesystem.write" }).decision,
    "APPROVAL_REQUIRED",
  );
  assert.equal(
    e.evaluate({ capabilityId: "filesystem.read" }).decision,
    "ALLOW",
  );
});

test("missing default → fail closed (DENY)", () => {
  const e = engineWith({ rules: {} });
  const r = e.evaluate({ capabilityId: "filesystem.read" });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reason, "NO_MATCH_FAIL_CLOSED");
});

test("unknown capability → fail closed", () => {
  const e = engineWith({ rules: { "x.*": "ALLOW" }, default: "ALLOW" });
  const r = e.evaluate({ capabilityId: "totally.unknown.tool" });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reason, "UNKNOWN_CAPABILITY");
});

test("malformed invocation → fail closed", () => {
  const e = engineWith({ rules: {}, default: "ALLOW" });
  // @ts-expect-error
  const r = e.evaluate({});
  assert.equal(r.decision, "DENY");
  assert.equal(r.reason, "MALFORMED_INVOCATION");
});

test("validateRuleset rejects bogus decisions", () => {
  assert.throws(
    () => validateRuleset({ rules: { foo: "MAYBE" } }),
    /invalid decision/,
  );
});

test("validateRuleset rejects bogus risk overrides", () => {
  assert.throws(
    () => validateRuleset({ rules: {}, riskOverrides: { NUCLEAR: "ALLOW" } }),
    /invalid risk level/,
  );
});

test("registerCapability rejects invalid risk/mode", () => {
  const e = engineWith({ rules: {} }, {});
  assert.throws(
    () => e.registerCapability({ id: "x", risk: "MEDIUM_RARE", mode: "READ" }),
    /invalid risk/,
  );
  assert.throws(
    () => e.registerCapability({ id: "x", risk: "LOW", mode: "DRAW" }),
    /invalid mode/,
  );
});

// ─── Policy version (content-addressable hash) ─────────────────────────────

test("computePolicyVersion is deterministic across key insertion order", () => {
  const a = computePolicyVersion({
    rules: { "x.read": "ALLOW", "x.write": "DENY" },
    default: "DENY",
  });
  const b = computePolicyVersion({
    rules: { "x.write": "DENY", "x.read": "ALLOW" },
    default: "DENY",
  });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test("computePolicyVersion changes when a rule changes", () => {
  const a = computePolicyVersion({
    rules: { "x.read": "ALLOW" },
    default: "DENY",
  });
  const b = computePolicyVersion({
    rules: { "x.read": "DENY" },
    default: "DENY",
  });
  assert.notEqual(a, b);
});

test("computePolicyVersion changes when default changes", () => {
  const a = computePolicyVersion({ rules: {}, default: "DENY" });
  const b = computePolicyVersion({ rules: {}, default: "ALLOW" });
  assert.notEqual(a, b);
});

test("computePolicyVersion changes when riskOverrides change", () => {
  const a = computePolicyVersion({
    rules: {},
    riskOverrides: { CRITICAL: "DENY" },
  });
  const b = computePolicyVersion({
    rules: {},
    riskOverrides: { CRITICAL: "APPROVAL_REQUIRED" },
  });
  assert.notEqual(a, b);
});

test("PolicyEngine exposes the current version + rotates it on setRuleset", () => {
  const e = engineWith({ rules: { "filesystem.read": "ALLOW" } });
  const v1 = e.version;
  assert.match(v1, /^sha256:/);
  e.setRuleset({ rules: { "filesystem.read": "DENY" } });
  assert.notEqual(v1, e.version);
});
