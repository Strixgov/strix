/**
 * Wrap the Notion MCP server with Strix governance.
 *
 *   node examples/notion.mjs            # offline stub — zero config
 *   NOTION_TOKEN=secret_… node examples/notion.mjs
 *                                       # live — spawns @notionhq/notion-mcp-server
 *
 * Demonstrates:
 *   - 5-line wrap of an MCP server with `governMCPServer`
 *   - Companion-pack classification picking up Notion's hyphen-prefixed
 *     tool names (`notion-fetch`, `notion-create-comment`, …)
 *   - Three policy outcomes: LOW READ → ALLOW, MEDIUM WRITE →
 *     APPROVAL_REQUIRED (auto-approved here for the demo), explicit DENY
 *   - Signed Ed25519 receipts emitted for every call — allowed or denied
 *
 * Live mode requires two optional peer installs:
 *
 *   npm install --no-save @modelcontextprotocol/sdk @notionhq/notion-mcp-server
 *
 * If either is missing or NOTION_TOKEN isn't set, the example silently
 * falls back to a stub Notion handler so you can still see the full
 * governance flow end to end.
 */

import { governMCPServer } from "@strixgov/mcp-adapter";
import { notionCapabilities } from "@strixgov/capabilities-mcp-common/notion";

// ─── 1. Acquire a tool source ─────────────────────────────────────────────────
//
// In live mode we connect to the real Notion MCP server over stdio. In
// stub mode we return canned shapes so the example is runnable with zero
// setup. Either way, the Strix wrap below is byte-identical.

const toolSource = await loadToolSource();
console.log(`\n→ Using ${toolSource.mode} Notion tools (serverId=notion)\n`);

// ─── 2. Wrap with Strix — five lines ──────────────────────────────────────────

const governed = governMCPServer(toolSource.iface, {
  serverId: "notion",
  capabilities: notionCapabilities,
  policy: {
    rules: {
      // Explicit per-capability rules win over riskOverrides.
      "mcp.notion.create_database": "DENY", // hard ban for this agent
    },
    // Everything else maps off the companion pack's risk classification.
    riskOverrides: {
      LOW: "ALLOW",                 // every read auto-allowed
      MEDIUM: "APPROVAL_REQUIRED",  // every write held for review
      HIGH: "APPROVAL_REQUIRED",
      CRITICAL: "DENY",
    },
    default: "DENY",
  },
  approval: {
    // Auto-approve every prompt so the demo runs unattended. In real
    // deployments wire `prompt` to a Slack/Linear/Web webhook approver.
    enabled: true,
    prompt: async (cap) => {
      console.log(`  ⏸  approval gate → auto-approving ${cap.id} for demo`);
      return { approved: true, approver: "demo-script" };
    },
  },
});

// ─── 3. Observe every signed receipt ──────────────────────────────────────────

const receipts = [];
governed.gateway.on("receipt", (r) => receipts.push(r));

// ─── 4. Drive a few representative calls ─────────────────────────────────────

await tryCall("notion-fetch",          { id: "doc_demo" });
await tryCall("notion-search",         { query: "Q2 planning" });
await tryCall("notion-create-comment", { pageId: "doc_demo", body: "looks good" });
await tryCall("notion-create-database",{ title: "Quarterly OKRs" });
await tryCall("notion-update-page",    { pageId: "doc_demo", properties: { Status: "Done" } });

// ─── 5. Show what we proved ───────────────────────────────────────────────────

console.log(`\n─── ${receipts.length} signed receipts ──────────────────────────────`);
for (const r of receipts) {
  const sigPreview = r.signature ? r.signature.slice(0, 16) + "…" : "<missing>";
  console.log(
    `  ${r.decision.padEnd(8)} ${r.capabilityId.padEnd(28)} sig=${sigPreview}`,
  );
}

const chain = await governed.gateway.verifyChain();
console.log(`\nproof chain: valid=${chain.valid}, receipts=${chain.count ?? receipts.length}`);
console.log("\nVerify the same receipts offline with:");
console.log("  npx @strixgov/verifier chain ~/.strix-mcp-adapter/receipts.jsonl");

if (toolSource.dispose) await toolSource.dispose();

// ─── helpers ─────────────────────────────────────────────────────────────────

async function tryCall(name, args) {
  try {
    const result = await governed.callTool(name, args, { actorId: "agent-notion-1" });
    const preview = JSON.stringify(result).slice(0, 80);
    console.log(`  ✓ ${name.padEnd(25)} → ALLOW   ${preview}`);
  } catch (err) {
    const code = err.code ?? "ERROR";
    console.log(`  ✗ ${name.padEnd(25)} → ${code}`);
  }
}

/**
 * Returns `{ mode, iface, dispose? }`. `iface` is whatever
 * governMCPServer accepts — either a `{ handler, listTools }` object
 * (live mode) or a plain `Record<name, handler>` (stub mode).
 */
async function loadToolSource() {
  const wantsLive = Boolean(process.env.NOTION_TOKEN);
  if (wantsLive) {
    try {
      return await connectLiveNotionMcp();
    } catch (err) {
      console.warn(
        `\n⚠  Live mode requested but failed: ${err.message}\n` +
          "   Falling back to stub. Install the optional peers to use live mode:\n" +
          "     npm install --no-save @modelcontextprotocol/sdk @notionhq/notion-mcp-server\n",
      );
    }
  }
  return { mode: "stub", iface: buildStubHandlers() };
}

async function connectLiveNotionMcp() {
  // Dynamic-import so the file still runs without the MCP SDK installed.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: { ...process.env, NOTION_TOKEN: process.env.NOTION_TOKEN },
  });
  const client = new Client({ name: "strix-demo", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    mode: "live (notion-mcp-server via stdio)",
    iface: {
      serverId: "notion",
      listTools: async () => {
        const out = await client.listTools();
        return out.tools.map((t) => ({ name: t.name, description: t.description }));
      },
      handler: async (name, args) => {
        return await client.callTool({ name, arguments: args ?? {} });
      },
    },
    dispose: async () => {
      try { await client.close(); } catch { /* best-effort */ }
    },
  };
}

function buildStubHandlers() {
  // Mirrors the on-the-wire tool surface of @notionhq/notion-mcp-server.
  // Just enough for the example to render meaningful receipts.
  return {
    "notion-fetch":            async ({ id }) => ({ id, title: "Demo doc", blocks: 3 }),
    "notion-search":           async ({ query }) => ({ query, hits: [{ id: "doc_demo", score: 0.9 }] }),
    "notion-get-comments":     async ({ pageId }) => ({ pageId, comments: [] }),
    "notion-get-teams":        async () => ({ teams: [{ id: "team_a", name: "Demo Team" }] }),
    "notion-get-users":        async () => ({ users: [{ id: "user_a", name: "Alice" }] }),
    "notion-create-pages":     async ({ pages }) => ({ created: pages?.length ?? 1 }),
    "notion-create-database":  async ({ title }) => ({ id: "db_new", title }),
    "notion-create-view":      async ({ name }) => ({ id: "view_new", name }),
    "notion-create-comment":   async ({ pageId, body }) => ({ id: "comment_1", pageId, body }),
    "notion-update-page":      async ({ pageId, properties }) => ({ pageId, properties, updated: true }),
    "notion-update-data-source": async ({ id }) => ({ id, updated: true }),
    "notion-update-view":      async ({ id }) => ({ id, updated: true }),
    "notion-duplicate-page":   async ({ id }) => ({ from: id, to: "doc_copy" }),
    "notion-move-pages":       async ({ ids }) => ({ moved: ids?.length ?? 0 }),
  };
}
