/**
 * Enforcement honesty — the GOG-2 ratchet for this pack.
 *
 * The program contract (strix-platform
 * docs/strategy/workspace-governance-adapter-program-v1.md §5) says a
 * surface may only be described as ENFORCED when pre-execution
 * interception is real. For Odysseus today that is exactly one
 * capability: the MCP passthrough, because @strixgov/mcp-proxy wraps
 * the MCP boundary. Every native-path capability is OBSERVE-ONLY.
 *
 * This test pins that set. Moving a capability from "host-hook" to
 * "mcp-proxy" is a deliberate event that requires a real interception
 * path landing first — updating this test is the review tripwire, the
 * same pattern as gate-J's REQUIRED_GUARD_BASELINE = 0.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  allOdysseusCapabilities,
  enforceableToday,
  observeOnlyToday,
} from "../src/index.mjs";

test("exactly one capability is enforceable today: the MCP passthrough", () => {
  const enforced = enforceableToday();
  assert.deepEqual(
    enforced.map((c) => c.id),
    ["odysseus.mcp.invoke"],
    "growing the enforceable set requires a REAL interception path, not a re-label",
  );
});

test("enforceable + observe-only partition the whole registry", () => {
  const enforced = new Set(enforceableToday().map((c) => c.id));
  const observed = new Set(observeOnlyToday().map((c) => c.id));
  assert.equal(enforced.size + observed.size, allOdysseusCapabilities.length);
  for (const id of enforced) {
    assert.ok(!observed.has(id), `${id} in both sets`);
  }
});

test("the highest-risk native surfaces are honestly marked host-hook (not claimed enforced)", () => {
  const observed = new Set(observeOnlyToday().map((c) => c.id));
  for (const id of [
    "odysseus.shell.execute",
    "odysseus.email.send",
    "odysseus.skill.install",
    "odysseus.secret.access",
  ]) {
    assert.ok(observed.has(id), `${id} must be observe-only until a host hook exists`);
  }
});
