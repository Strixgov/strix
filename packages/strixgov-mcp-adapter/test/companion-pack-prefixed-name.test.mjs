/**
 * Regression test — companion pack must classify tools whose on-the-wire
 * names are prefixed with the server name (e.g. Notion exposes
 * `notion-fetch`, `notion-create-pages`, not bare `fetch` / `create_pages`).
 *
 * Before the fix, the adapter only indexed capabilities by `id` and by the
 * `id` with the `mcp.<serverId>.` prefix stripped — neither of which
 * matches the real MCP tool name in the Notion convention. The classifier
 * fell through to the heuristic (MEDIUM EXECUTE) and the companion-pack
 * classifications were silently ignored.
 *
 * This pins the fix: the companion pack must win when `cap.name` matches
 * the on-the-wire MCP tool name.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { governMCPServer } from "../src/index.mjs";

const NOTION_CAPS = [
  { id: "mcp.notion.fetch",          name: "notion-fetch",          risk: "LOW",    mode: "READ"  },
  { id: "mcp.notion.search",         name: "notion-search",         risk: "LOW",    mode: "READ"  },
  { id: "mcp.notion.create_comment", name: "notion-create-comment", risk: "MEDIUM", mode: "WRITE" },
];

const NOTION_TOOLS = {
  "notion-fetch":          async () => ({ ok: "fetched" }),
  "notion-search":         async () => ({ ok: "searched" }),
  "notion-create-comment": async () => ({ ok: "commented" }),
};

test("companion-pack ID-based policy rules match server-prefixed tool names", async () => {
  // Policy keys use the canonical companion-pack id (mcp.notion.fetch),
  // not the on-the-wire name (notion-fetch). This is the documented API.
  const srv = governMCPServer(NOTION_TOOLS, {
    serverId: "notion",
    capabilities: NOTION_CAPS,
    policy: {
      rules: {
        "mcp.notion.fetch":          "ALLOW",
        "mcp.notion.search":         "ALLOW",
        "mcp.notion.create_comment": "DENY",
      },
      default: "DENY",
    },
  });

  const read1 = await srv.callTool("notion-fetch", {});
  assert.deepEqual(read1, { ok: "fetched" });

  const read2 = await srv.callTool("notion-search", {});
  assert.deepEqual(read2, { ok: "searched" });

  await assert.rejects(() => srv.callTool("notion-create-comment", {}), /denied/i);
});

test("companion-pack risk levels apply to server-prefixed tool names", async () => {
  // No per-id rules — purely riskOverrides driven. Before the fix this
  // would route every Notion tool through the MEDIUM EXECUTE heuristic,
  // so the LOW override would never apply and every read would DENY.
  const receipts = [];
  const srv = governMCPServer(NOTION_TOOLS, {
    serverId: "notion",
    capabilities: NOTION_CAPS,
    policy: {
      riskOverrides: { LOW: "ALLOW", MEDIUM: "DENY" },
      default: "DENY",
    },
  });
  srv.gateway.on("receipt", (r) => receipts.push(r));

  await srv.callTool("notion-fetch", {});
  await srv.callTool("notion-search", {});
  await assert.rejects(() => srv.callTool("notion-create-comment", {}));

  assert.equal(receipts.length, 3);
  assert.equal(receipts[0].decision, "ALLOW", "notion-fetch is LOW READ → ALLOW");
  assert.equal(receipts[1].decision, "ALLOW", "notion-search is LOW READ → ALLOW");
  assert.equal(receipts[2].decision, "DENY",  "notion-create-comment is MEDIUM WRITE → DENY");

  // The receipt's capabilityId must be the companion-pack canonical id,
  // not a heuristic-derived `mcp.notion.notion-fetch`. This is what makes
  // policy rules and receipts grep-consistent across an install.
  assert.equal(receipts[0].capabilityId, "mcp.notion.fetch");
  assert.equal(receipts[1].capabilityId, "mcp.notion.search");
  assert.equal(receipts[2].capabilityId, "mcp.notion.create_comment");
});
