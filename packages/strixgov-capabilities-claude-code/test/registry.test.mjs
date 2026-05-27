import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeCodeCapabilities,
  claudeCodeCapabilityMap,
  suggestedPolicy,
  REGISTRY_NAME,
} from "../src/index.mjs";

test("registry name and contents are stable", () => {
  assert.equal(REGISTRY_NAME, "claude-code");
  assert.ok(claudeCodeCapabilities.length >= 16, "expected ≥ 16 tools");
});

test("every capability has the canonical (id, name, risk, mode, description) shape", () => {
  for (const cap of claudeCodeCapabilities) {
    assert.equal(typeof cap.id, "string");
    assert.match(cap.id, /^claude\./);
    assert.equal(typeof cap.name, "string");
    assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(cap.risk));
    assert.ok(["READ", "WRITE", "EXECUTE"].includes(cap.mode));
    assert.equal(typeof cap.description, "string");
    assert.ok(cap.description.length > 0);
  }
});

test("ids are unique", () => {
  const ids = claudeCodeCapabilities.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("Bash is HIGH EXECUTE — destructive surface invariant", () => {
  const bash = claudeCodeCapabilities.find((c) => c.id === "claude.bash");
  assert.ok(bash);
  assert.equal(bash.risk, "HIGH");
  assert.equal(bash.mode, "EXECUTE");
});

test("Read/Glob/Grep are LOW READ — read-side invariant", () => {
  for (const id of ["claude.read", "claude.glob", "claude.grep"]) {
    const cap = claudeCodeCapabilities.find((c) => c.id === id);
    assert.equal(cap.risk, "LOW");
    assert.equal(cap.mode, "READ");
  }
});

test("claudeCodeCapabilityMap returns a record keyed by id", () => {
  const map = claudeCodeCapabilityMap();
  assert.equal(Object.keys(map).length, claudeCodeCapabilities.length);
  for (const cap of claudeCodeCapabilities) {
    assert.deepEqual(map[cap.id], cap);
  }
});

test("suggestedPolicy denies by default and covers every capability", () => {
  const policy = suggestedPolicy();
  assert.equal(policy.default, "DENY");
  for (const cap of claudeCodeCapabilities) {
    assert.ok(
      cap.id in policy.rules,
      `suggestedPolicy is missing rule for ${cap.id}`,
    );
  }
});

test("suggestedPolicy never auto-allows EXECUTE-class tools without approval", () => {
  const policy = suggestedPolicy();
  for (const cap of claudeCodeCapabilities) {
    if (cap.mode === "EXECUTE" && cap.risk !== "LOW") {
      assert.notEqual(
        policy.rules[cap.id],
        "ALLOW",
        `${cap.id} should require approval, not ALLOW`,
      );
    }
  }
});

test("freezing — accidental mutation is rejected", () => {
  assert.throws(() => {
    claudeCodeCapabilities[0] = { id: "x" };
  });
});
