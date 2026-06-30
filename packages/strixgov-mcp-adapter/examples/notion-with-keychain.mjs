#!/usr/bin/env node
/**
 * Example: start the Notion MCP proxy with credentials from the OS keychain.
 *
 * One-time setup (run once per machine):
 *
 *   npx strix-mcp-credentials set notion.token
 *   # Enter your Notion Internal Integration Token when prompted.
 *   # It is stored in the OS keychain — not in any config file.
 *
 * Then start the proxy:
 *
 *   node notion-with-keychain.mjs
 *
 * Or wire it into Claude Desktop's mcp_servers config:
 *
 *   {
 *     "mcp_servers": {
 *       "notion": {
 *         "command": "node",
 *         "args": ["/path/to/notion-with-keychain.mjs"]
 *       }
 *     }
 *   }
 *
 * The proxy fetches the Notion token from the OS keychain at startup and
 * injects it into the upstream server's environment as NOTION_API_KEY.
 * The token never appears in shell history, config files, or process listings.
 *
 * Requires:
 *   npm install -g @strixgov/mcp-proxy @strixgov/mcp-credentials @strixgov/capabilities-mcp-common
 */

import { startProxy } from "@strixgov/mcp-proxy";

await startProxy({
  serverId: "notion",

  upstream: {
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    // NOTION_API_KEY is NOT set here — it is resolved from the keychain below.
  },

  // upstreamCredentials: resolved at startup, merged into upstream.env.
  // The "notion.token" keychain entry is set with:
  //   strix-mcp-credentials set notion.token
  upstreamCredentials: {
    NOTION_API_KEY: { from: "keychain", key: "notion.token" },
  },

  // Capability pack for Notion — classifies each tool by risk level.
  capabilities: "@strixgov/capabilities-mcp-common/notion",

  policy: {
    riskOverrides: {
      LOW: "ALLOW",
      MEDIUM: "APPROVAL_REQUIRED",
      CRITICAL: "DENY",
    },
    default: "DENY",
  },

  // Approval gate: "file" works under Claude Desktop's headless spawn.
  // The proxy writes a request file; an operator approves by creating
  // the matching response file. "auto" skips approval (demos only).
  approval: { enabled: true, type: "file" },
});
