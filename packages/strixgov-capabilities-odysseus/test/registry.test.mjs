import test from "node:test";
import assert from "node:assert/strict";
import {
  shellCapabilities,
  filesystemCapabilities,
  emailCapabilities,
  webCapabilities,
  scheduleCapabilities,
  memoryCapabilities,
  secretCapabilities,
  extensionCapabilities,
  allOdysseusCapabilities,
  odysseusCapabilityMap,
  suggestedPolicy,
  REGISTRY_NAME,
} from "../src/index.mjs";

test("registry name is odysseus", () => {
  assert.equal(REGISTRY_NAME, "odysseus");
});

test("each surface has at least one capability", () => {
  assert.ok(shellCapabilities.length > 0);
  assert.ok(filesystemCapabilities.length > 0);
  assert.ok(emailCapabilities.length > 0);
  assert.ok(webCapabilities.length > 0);
  assert.ok(scheduleCapabilities.length > 0);
  assert.ok(memoryCapabilities.length > 0);
  assert.ok(secretCapabilities.length > 0);
  assert.ok(extensionCapabilities.length > 0);
});

test("aggregate equals sum of parts", () => {
  assert.equal(
    allOdysseusCapabilities.length,
    shellCapabilities.length +
      filesystemCapabilities.length +
      emailCapabilities.length +
      webCapabilities.length +
      scheduleCapabilities.length +
      memoryCapabilities.length +
      secretCapabilities.length +
      extensionCapabilities.length,
  );
});

test("every capability id is host-namespaced and unique", () => {
  const ids = allOdysseusCapabilities.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate id in registry");
  for (const id of ids) {
    // Host pack: `odysseus.<surface>.<action>` — NOT `mcp.<server>.*`,
    // which is reserved for MCP-server packs (mcp-common convention).
    assert.match(id, /^odysseus\.(shell|file|email|web|schedule|memory|secret|mcp|skill)\./);
  }
});

test("every capability has the canonical shape + the interception field", () => {
  for (const cap of allOdysseusCapabilities) {
    assert.equal(typeof cap.id, "string");
    assert.equal(typeof cap.name, "string");
    assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(cap.risk));
    assert.ok(["READ", "WRITE", "EXECUTE"].includes(cap.mode));
    assert.ok(["mcp-proxy", "host-hook"].includes(cap.interception));
    assert.equal(typeof cap.description, "string");
    assert.ok(cap.description.length > 0);
  }
});

test("capability map is keyed by id and returns copies", () => {
  const map = odysseusCapabilityMap();
  assert.equal(Object.keys(map).length, allOdysseusCapabilities.length);
  const sample = map["odysseus.email.send"];
  assert.ok(sample);
  sample.risk = "LOW";
  assert.equal(odysseusCapabilityMap()["odysseus.email.send"].risk, "HIGH");
});

test("suggested policy: CRITICAL → DENY, LOW READ → ALLOW, everything else → APPROVAL_REQUIRED, default DENY", () => {
  const policy = suggestedPolicy();
  assert.equal(policy.default, "DENY");
  assert.equal(policy.riskOverrides.CRITICAL, "DENY");
  for (const cap of allOdysseusCapabilities) {
    const rule = policy.rules[cap.id];
    assert.ok(rule, `missing rule for ${cap.id}`);
    if (cap.risk === "CRITICAL") {
      assert.equal(rule, "DENY", cap.id);
    } else if (cap.mode === "READ" && cap.risk === "LOW") {
      assert.equal(rule, "ALLOW", cap.id);
    } else {
      assert.equal(rule, "APPROVAL_REQUIRED", cap.id);
    }
  }
});

test("delete-style ops are at least MEDIUM, file deletes at least HIGH", () => {
  const deletes = allOdysseusCapabilities.filter((c) => /\.delete$/.test(c.id));
  assert.ok(deletes.length > 0, "expected delete capabilities");
  for (const cap of deletes) {
    assert.ok(
      ["MEDIUM", "HIGH", "CRITICAL"].includes(cap.risk),
      `${cap.id} should be MEDIUM+, got ${cap.risk}`,
    );
  }
  assert.equal(odysseusCapabilityMap()["odysseus.file.delete"].risk, "HIGH");
});
