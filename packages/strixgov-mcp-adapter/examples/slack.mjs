/**
 * Wrap the Slack MCP server with Strix governance.
 *
 *   node examples/slack.mjs                       # offline stub
 *   SLACK_MCP_XOXP_TOKEN=xoxp-… \
 *     node examples/slack.mjs                     # live — spawns a Slack MCP
 *
 * Demonstrates the CISO-legible governance story: agents talking on
 * Slack. The Slack MCP exposes ~13 tools the
 * @strixgov/capabilities-mcp-common/slack pack classifies. Slack tool
 * names are SERVER-PREFIXED (`slack_send_message`, `slack_read_channel`)
 * — different from GitHub's bare names — so this example also exercises
 * the `cap.name` lookup path on the adapter side. That path was added
 * as the P0 #2 fix earlier on this branch; if it regresses, this demo
 * silently fails closed because none of the Slack tools would match
 * the companion pack.
 *
 *   - LOW READ → ALLOW   read_channel, read_thread, search_public,
 *                        send_message_draft (drafting a message is
 *                        intent, not action — the pack classifies it
 *                        LOW because nothing is posted)
 *   - MEDIUM   → APPROVAL_REQUIRED (auto-approved):
 *                send_message — the real "agent posted to a channel"
 *                action that the pack gates by default. Operators
 *                often add per-channel DENY rules on top of this
 *                (e.g. `"mcp.slack.send_message": "DENY"` for
 *                #all-staff via custom policy logic).
 *   - out-of-pack → heuristic CRITICAL → DENY:
 *                slack_delete_channel (intentionally not in the pack;
 *                the heuristic + fail-closed default blocks it)
 *
 * Live mode requires a Slack MCP and a workspace token; the canonical
 * options are still moving. The example uses the same dual-mode
 * pattern as notion.mjs / filesystem.mjs / github.mjs — falls back to
 * stub silently when live peers aren't installed.
 */

import { governMCPServer } from "@strixgov/mcp-adapter";
import { slackCapabilities } from "@strixgov/capabilities-mcp-common/slack";

// ─── 1. Acquire a tool source ─────────────────────────────────────────────────

const toolSource = await loadToolSource();
console.log(`\n→ Using ${toolSource.mode} Slack tools (serverId=slack)\n`);

// ─── 2. Wrap with Strix — five lines ──────────────────────────────────────────

const governed = governMCPServer(toolSource.iface, {
  serverId: "slack",
  capabilities: slackCapabilities,
  policy: {
    riskOverrides: {
      LOW: "ALLOW",                 // reads + send_message_draft auto-allowed
      MEDIUM: "APPROVAL_REQUIRED",  // send_message + canvas writes held
      HIGH: "APPROVAL_REQUIRED",
      CRITICAL: "DENY",             // anything heuristic-classified CRITICAL
    },
    default: "DENY",
  },
  approval: {
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
//
// Tool names are server-prefixed (`slack_*`) — same shape as the live
// Slack MCP. The pack's `cap.name` field carries this prefix; if the
// adapter's lookup regresses, none of these will match the companion
// pack and every call falls through to the heuristic. Stub mode will
// still render output but `capabilityId` on the receipts would all be
// `mcp.slack.slack_*` (heuristic-derived) instead of `mcp.slack.*`
// (companion-pack canonical). The post-run check below pins this.

await tryCall("slack_search_public",       { query: "deploy" });
await tryCall("slack_read_channel",        { channel: "C0DEPLOYS" });
await tryCall("slack_read_thread",         { channel: "C0DEPLOYS", ts: "1716489600.000100" });
await tryCall("slack_send_message_draft",  { channel: "C0DEPLOYS", text: "Deploy looks healthy" });
await tryCall("slack_send_message",        { channel: "C0DEPLOYS", text: "Deploying #1234 in 5 minutes" });
await tryCall("slack_delete_channel",      { channel: "C0DEPLOYS" }); // out-of-pack → heuristic CRITICAL → DENY

// ─── 5. Show what we proved ───────────────────────────────────────────────────

console.log(`\n─── ${receipts.length} signed receipts ──────────────────────────────`);
for (const r of receipts) {
  const sigPreview = r.signature ? r.signature.slice(0, 16) + "…" : "<missing>";
  console.log(
    `  ${r.decision.padEnd(8)} ${r.capabilityId.padEnd(38)} sig=${sigPreview}`,
  );
}

// Companion-pack lookup regression check — every IN-PACK Slack tool
// must produce a receipt whose capabilityId matches the pack-canonical
// `mcp.slack.<bare>` form (no doubled `slack_` prefix). Out-of-pack
// tools (like `slack_delete_channel` below) legitimately produce a
// heuristic-derived id (`mcp.slack.slack_delete_channel`) — that's
// the correct shape for "unclassified, fail-closed at CRITICAL." So
// the check excludes those.
const inPackNames = new Set([
  "slack_search_public",
  "slack_read_channel",
  "slack_read_thread",
  "slack_send_message_draft",
  "slack_send_message",
]);
const packMisses = receipts.filter(
  (r) =>
    /\bmcp\.slack\.slack_/.test(r.capabilityId) &&
    // Was this tool supposed to be in the pack? If so, the doubled prefix
    // means the cap.name lookup failed and the heuristic fired instead.
    inPackNames.has(r.capabilityId.replace(/^mcp\.slack\./, "")),
);
if (packMisses.length > 0) {
  console.error("\n✗ REGRESSION: companion-pack lookup missed for in-pack Slack tools:");
  for (const m of packMisses) console.error(`    ${m.capabilityId}`);
  console.error("  Expected the pack-canonical id (e.g. mcp.slack.send_message).");
  console.error("  This means the cap.name lookup path regressed — see the P0 #2 fix on");
  console.error("  this branch (commit a5db1f2) and the regression test at");
  console.error("  packages/strixgov-mcp-adapter/test/companion-pack-prefixed-name.test.mjs");
  process.exit(1);
}

const chain = await governed.gateway.verifyChain();
console.log(`\nproof chain: valid=${chain.valid}, receipts=${chain.count ?? receipts.length}`);
console.log("\nEvery send_message is now bound to the approver + receipt.");
console.log("Verify offline with:");
console.log("  npx @strixgov/verifier chain ~/.strix-mcp-adapter/receipts.jsonl");

if (toolSource.dispose) await toolSource.dispose();

// ─── helpers ─────────────────────────────────────────────────────────────────

async function tryCall(name, args) {
  try {
    const result = await governed.callTool(name, args, { actorId: "agent-slack-1" });
    const preview = JSON.stringify(result).slice(0, 80);
    console.log(`  ✓ ${name.padEnd(28)} → ALLOW   ${preview}`);
  } catch (err) {
    const code = err.code ?? "ERROR";
    console.log(`  ✗ ${name.padEnd(28)} → ${code}`);
  }
}

async function loadToolSource() {
  const wantsLive = Boolean(process.env.SLACK_MCP_XOXP_TOKEN);
  if (wantsLive) {
    try {
      return await connectLiveSlackMcp();
    } catch (err) {
      console.warn(
        `\n⚠  Live mode requested but failed: ${err.message}\n` +
          "   Falling back to stub. Install the MCP SDK + your chosen Slack MCP server\n" +
          "   and ensure SLACK_MCP_XOXP_TOKEN is set.\n",
      );
    }
  }
  return { mode: "stub", iface: buildStubHandlers() };
}

async function connectLiveSlackMcp() {
  // The Slack MCP server ecosystem is still consolidating (multiple
  // implementations, different distribution names). The connector
  // below targets the stdio + MCP SDK pattern used by Notion/Filesystem/
  // GitHub above; the consumer points it at whichever Slack MCP they
  // have via SLACK_MCP_COMMAND (defaults to a placeholder).
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const command = process.env.SLACK_MCP_COMMAND ?? "npx";
  const args = process.env.SLACK_MCP_ARGS
    ? JSON.parse(process.env.SLACK_MCP_ARGS)
    : ["-y", "@modelcontextprotocol/server-slack"];

  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, SLACK_MCP_XOXP_TOKEN: process.env.SLACK_MCP_XOXP_TOKEN },
  });
  const client = new Client({ name: "strix-demo", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    mode: `live (${command} ${args.join(" ")} via stdio)`,
    iface: {
      serverId: "slack",
      listTools: async () => {
        const out = await client.listTools();
        return out.tools.map((t) => ({ name: t.name, description: t.description }));
      },
      handler: async (name, ar) => {
        return await client.callTool({ name, arguments: ar ?? {} });
      },
    },
    dispose: async () => {
      try { await client.close(); } catch { /* best-effort */ }
    },
  };
}

function buildStubHandlers() {
  // Mirrors the on-the-wire tool surface of the Slack MCP companion pack.
  // Tool names are server-prefixed (slack_*) — important: this exercises
  // the cap.name lookup path on the adapter side.
  return {
    slack_search_public:      async ({ query }) => ({ query, results: [{ channel: "C0DEPLOYS", ts: "1716489600.000100", text: "Deploy #1234 prepared" }] }),
    slack_read_channel:       async ({ channel }) => ({ channel, messages: [{ ts: "1716489600.000100", user: "U_AGENT", text: "(canned)" }] }),
    slack_read_thread:        async ({ channel, ts }) => ({ channel, ts, replies: [] }),
    slack_send_message_draft: async ({ channel, text }) => ({ channel, draft_id: "draft_demo", text }),
    slack_send_message:       async ({ channel, text }) => ({ channel, ts: "1716489605.000200", text, posted: true }),
    // NOTE: deliberately no `slack_delete_channel` — the demo proves the
    // heuristic + default-DENY blocks unknown destructive tools.
  };
}
