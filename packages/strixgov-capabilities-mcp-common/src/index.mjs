/**
 * @strixgov/capabilities-mcp-common — pre-classified capability registry
 * for popular MCP servers (Slack, GitHub, Linear, Notion, Filesystem, Postgres).
 *
 * Per-server modules are also exposed as subpath imports:
 *
 *   import { slackCapabilities }      from "@strixgov/capabilities-mcp-common/slack";
 *   import { githubCapabilities }     from "@strixgov/capabilities-mcp-common/github";
 *   import { linearCapabilities }     from "@strixgov/capabilities-mcp-common/linear";
 *   import { notionCapabilities }     from "@strixgov/capabilities-mcp-common/notion";
 *   import { filesystemCapabilities } from "@strixgov/capabilities-mcp-common/filesystem";
 *   import { postgresCapabilities }   from "@strixgov/capabilities-mcp-common/postgres";
 *
 * Or pull all six at once:
 *
 *   import { allMcpCapabilities, mcpCapabilityMap }
 *     from "@strixgov/capabilities-mcp-common";
 *
 * Capability IDs follow the convention `mcp.<server>.<tool>`. Override
 * any classification in your local policy ruleset; these are starters,
 * not policy.
 */

import { slackCapabilities } from "./slack.mjs";
import { githubCapabilities } from "./github.mjs";
import { linearCapabilities } from "./linear.mjs";
import { notionCapabilities } from "./notion.mjs";
import { filesystemCapabilities } from "./filesystem.mjs";
import { postgresCapabilities } from "./postgres.mjs";
import { emailCapabilities } from "./email.mjs";

export {
  slackCapabilities,
  githubCapabilities,
  linearCapabilities,
  notionCapabilities,
  filesystemCapabilities,
  postgresCapabilities,
  emailCapabilities,
};

export const REGISTRY_NAME = "mcp-common";
export const REGISTRY_VERSION = "0.1.0";

/** All seven servers' classifications, in a single frozen array. */
export const allMcpCapabilities = Object.freeze([
  ...slackCapabilities,
  ...githubCapabilities,
  ...linearCapabilities,
  ...notionCapabilities,
  ...filesystemCapabilities,
  ...postgresCapabilities,
  ...emailCapabilities,
]);

/**
 * @returns {Record<string, import("./types.d.ts").McpCapability>}
 */
export function mcpCapabilityMap() {
  /** @type {Record<string, import("./types.d.ts").McpCapability>} */
  const map = {};
  for (const cap of allMcpCapabilities) {
    map[cap.id] = { ...cap };
  }
  return map;
}

/**
 * Suggested policy:
 *   - CRITICAL → DENY
 *   - LOW READ → ALLOW (schema introspection, file listing, public search, etc.)
 *   - any other READ (MEDIUM / HIGH) → APPROVAL_REQUIRED
 *     (e.g. Postgres SELECT — reads can exfiltrate; not auto-safe)
 *   - WRITE / EXECUTE at any risk → APPROVAL_REQUIRED
 *   - default: DENY
 *
 * Compose with `claude-code` policy by spreading both rule objects.
 */
export function suggestedPolicy() {
  /** @type {Record<string, "ALLOW" | "DENY" | "APPROVAL_REQUIRED">} */
  const rules = {};
  for (const cap of allMcpCapabilities) {
    if (cap.risk === "CRITICAL") {
      rules[cap.id] = "DENY";
    } else if (cap.mode === "READ" && cap.risk === "LOW") {
      // Only LOW READs auto-allow. MEDIUM/HIGH reads (e.g. Postgres
      // SELECT) can leak sensitive data and require an approver.
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
