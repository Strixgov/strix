/**
 * @strixgov/capabilities-odysseus — pre-classified capability registry
 * for the Odysseus self-hosted AI workspace.
 *
 * This is a HOST pack (namespace `odysseus.*`, like `claude.*` in
 * @strixgov/capabilities-claude-code), not an MCP-server pack
 * (`mcp.<server>.*`). It classifies the workspace's ACTION surface —
 * shell, files, email, web, scheduled tasks, persistent memory,
 * secrets, MCP passthrough, skill installation — so a policy engine
 * has deterministic inputs for every consequential thing the workspace
 * can do.
 *
 * Per-surface modules are exposed as subpath imports:
 *
 *   import { shellCapabilities }     from "@strixgov/capabilities-odysseus/shell";
 *   import { emailCapabilities }     from "@strixgov/capabilities-odysseus/email";
 *   ...
 *
 * Enforcement honesty (load-bearing — read before quoting this pack
 * in any public claim):
 *
 *   Every capability carries an `interception` field.
 *   - "mcp-proxy":  enforceable TODAY — route Odysseus's MCP config
 *                   through @strixgov/mcp-proxy and the call is
 *                   intercepted before its side effect.
 *   - "host-hook":  the action uses Odysseus's NATIVE code path. Until
 *                   an upstream host hook routes it through the
 *                   gateway, this surface is OBSERVE-ONLY and must be
 *                   labeled "OBSERVE ONLY — ACTION NOT ENFORCED"
 *                   wherever it is rendered. Observe-only output is
 *                   never called governed execution.
 *
 * Capability IDs follow `odysseus.<surface>.<action>`. Override any
 * classification in your local policy ruleset; these are starters,
 * not policy.
 *
 * Program contract: strix-platform
 * docs/strategy/workspace-governance-adapter-program-v1.md
 */

import { shellCapabilities } from "./shell.mjs";
import { filesystemCapabilities } from "./filesystem.mjs";
import { emailCapabilities } from "./email.mjs";
import { webCapabilities } from "./web.mjs";
import { scheduleCapabilities } from "./schedule.mjs";
import { memoryCapabilities } from "./memory.mjs";
import { secretCapabilities } from "./secrets.mjs";
import { extensionCapabilities } from "./extensions.mjs";

export {
  shellCapabilities,
  filesystemCapabilities,
  emailCapabilities,
  webCapabilities,
  scheduleCapabilities,
  memoryCapabilities,
  secretCapabilities,
  extensionCapabilities,
};

export const REGISTRY_NAME = "odysseus";
export const REGISTRY_VERSION = "0.1.0";

/** All nine surfaces' classifications, in a single frozen array. */
export const allOdysseusCapabilities = Object.freeze([
  ...shellCapabilities,
  ...filesystemCapabilities,
  ...emailCapabilities,
  ...webCapabilities,
  ...scheduleCapabilities,
  ...memoryCapabilities,
  ...secretCapabilities,
  ...extensionCapabilities,
]);

/**
 * @returns {Record<string, import("./types.d.ts").OdysseusCapability>}
 */
export function odysseusCapabilityMap() {
  /** @type {Record<string, import("./types.d.ts").OdysseusCapability>} */
  const map = {};
  for (const cap of allOdysseusCapabilities) {
    map[cap.id] = { ...cap };
  }
  return map;
}

/**
 * The subset of this pack that pre-execution interception can reach
 * TODAY (interception === "mcp-proxy"). This is the only subset a
 * public surface may describe as enforced — see "Enforcement honesty"
 * above and §5 of the program doc. Growing this list is a deliberate
 * event: it requires a real interception path, not a re-label.
 */
export function enforceableToday() {
  return allOdysseusCapabilities.filter((c) => c.interception === "mcp-proxy");
}

/**
 * The complement of {@link enforceableToday}: native-path capabilities
 * that are OBSERVE-ONLY until Odysseus host hooks exist upstream.
 */
export function observeOnlyToday() {
  return allOdysseusCapabilities.filter((c) => c.interception === "host-hook");
}

/**
 * Suggested policy (same semantics as @strixgov/capabilities-mcp-common):
 *   - CRITICAL → DENY
 *   - LOW READ → ALLOW
 *   - any other READ (MEDIUM / HIGH) → APPROVAL_REQUIRED
 *     (web.fetch and secret.access are reads that can exfiltrate)
 *   - WRITE / EXECUTE at any non-CRITICAL risk → APPROVAL_REQUIRED
 *   - default: DENY
 *
 * Policy applies to the WHOLE registry, including host-hook surfaces —
 * the rules are ready the day an interception path exists. Having a
 * rule is not the same as enforcing it; see `enforceableToday()`.
 */
export function suggestedPolicy() {
  /** @type {Record<string, "ALLOW" | "DENY" | "APPROVAL_REQUIRED">} */
  const rules = {};
  for (const cap of allOdysseusCapabilities) {
    if (cap.risk === "CRITICAL") {
      rules[cap.id] = "DENY";
    } else if (cap.mode === "READ" && cap.risk === "LOW") {
      rules[cap.id] = "ALLOW";
    } else {
      rules[cap.id] = "APPROVAL_REQUIRED";
    }
  }
  return {
    rules,
    riskOverrides: { CRITICAL: "DENY" },
    default: "DENY",
  };
}
