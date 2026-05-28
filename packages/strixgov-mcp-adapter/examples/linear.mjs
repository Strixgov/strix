/**
 * Wrap the Linear MCP server with Strix governance.
 *
 *   node examples/linear.mjs                    # offline stub
 *   LINEAR_API_KEY=lin_api_… \
 *     node examples/linear.mjs                  # live — spawns a Linear MCP server
 *
 * Rounds out the "team operations" trio with Notion + Slack. The
 * Linear pack classifies the common surface (~10 tools) — bare
 * tool names (no `linear_` prefix), MEDIUM writes, HIGH delete.
 *
 *   - LOW READ → ALLOW: list_issues, get_issue, search_issues,
 *     list_projects, get_project, list_teams
 *   - MEDIUM WRITE → APPROVAL_REQUIRED: create_issue, update_issue,
 *     create_comment
 *   - HIGH WRITE → APPROVAL_REQUIRED: delete_issue
 *   - Out-of-pack → CRITICAL → DENY: e.g. `archive_team` would
 *     fall to heuristic-CRITICAL and be blocked
 *
 * Live mode spawns a Linear MCP server via stdio. The Linear MCP
 * ecosystem has several implementations; this example uses the
 * default `npx @some/linear-mcp-server` pattern and accepts a
 * `LINEAR_MCP_COMMAND` / `LINEAR_MCP_ARGS` override for BYO server.
 */

import { governMCPServer } from "@strixgov/mcp-adapter";
import { linearCapabilities } from "@strixgov/capabilities-mcp-common/linear";

const toolSource = await loadToolSource();
console.log(`\n→ Using ${toolSource.mode} Linear tools (serverId=linear)\n`);

const governed = governMCPServer(toolSource.iface, {
  serverId: "linear",
  capabilities: linearCapabilities,
  policy: {
    riskOverrides: {
      LOW: "ALLOW",
      MEDIUM: "APPROVAL_REQUIRED",
      HIGH: "APPROVAL_REQUIRED",
      CRITICAL: "DENY",
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

const receipts = [];
governed.gateway.on("receipt", (r) => receipts.push(r));

await tryCall("list_issues",    { team: "STRIX", state: "open" });
await tryCall("get_issue",      { id: "STRIX-1234" });
await tryCall("create_comment", { issueId: "STRIX-1234", body: "Ship it." });
await tryCall("create_issue",   { team: "STRIX", title: "Track Tier-2 wraps", priority: 3 });
await tryCall("update_issue",   { id: "STRIX-1234", state: "in_progress" });
await tryCall("delete_issue",   { id: "STRIX-1234" });
await tryCall("archive_team",   { team: "STRIX" }); // out-of-pack → heuristic CRITICAL → DENY

console.log(`\n─── ${receipts.length} signed receipts ──────────────────────────────`);
for (const r of receipts) {
  const sigPreview = r.signature ? r.signature.slice(0, 16) + "…" : "<missing>";
  console.log(
    `  ${r.decision.padEnd(8)} ${r.capabilityId.padEnd(36)} sig=${sigPreview}`,
  );
}

const chain = await governed.gateway.verifyChain();
console.log(`\nproof chain: valid=${chain.valid}, receipts=${chain.count ?? receipts.length}`);
console.log("\nEvery issue mutation is bound to the approver + signed receipt.");

if (toolSource.dispose) await toolSource.dispose();

async function tryCall(name, args) {
  try {
    const result = await governed.callTool(name, args, { actorId: "agent-linear-1" });
    const preview = JSON.stringify(result).slice(0, 80);
    console.log(`  ✓ ${name.padEnd(16)} → ALLOW   ${preview}`);
  } catch (err) {
    console.log(`  ✗ ${name.padEnd(16)} → ${err.code ?? "ERROR"}`);
  }
}

async function loadToolSource() {
  const wantsLive = Boolean(process.env.LINEAR_API_KEY || process.env.LINEAR_MCP_COMMAND);
  if (wantsLive) {
    try {
      return await connectLiveLinearMcp();
    } catch (err) {
      console.warn(
        `\n⚠  Live mode requested but failed: ${err.message}\n` +
          "   Falling back to stub. Set LINEAR_MCP_COMMAND + LINEAR_MCP_ARGS\n" +
          "   to point at your Linear MCP server, or install one of the community\n" +
          "   implementations and adjust accordingly.\n",
      );
    }
  }
  return { mode: "stub", iface: buildStubHandlers() };
}

async function connectLiveLinearMcp() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const command = process.env.LINEAR_MCP_COMMAND ?? "npx";
  const args = process.env.LINEAR_MCP_ARGS
    ? JSON.parse(process.env.LINEAR_MCP_ARGS)
    : ["-y", "@some/linear-mcp-server"];

  const transport = new StdioClientTransport({ command, args, env: process.env });
  const client = new Client({ name: "strix-demo", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    mode: `live (${command} ${args.join(" ")} via stdio)`,
    iface: {
      serverId: "linear",
      listTools: async () => {
        const out = await client.listTools();
        return out.tools.map((t) => ({ name: t.name, description: t.description }));
      },
      handler: async (name, a) => {
        return await client.callTool({ name, arguments: a ?? {} });
      },
    },
    dispose: async () => {
      try { await client.close(); } catch { /* */ }
    },
  };
}

function buildStubHandlers() {
  return {
    list_issues:    async ({ team, state }) => ({ team, state, issues: [{ id: "STRIX-1234", title: "Demo issue" }] }),
    get_issue:      async ({ id }) => ({ id, title: "Demo issue", state: "open", priority: 2 }),
    search_issues:  async ({ query }) => ({ query, hits: [] }),
    list_projects:  async () => ({ projects: [{ id: "proj_1", name: "Tier-2 Wraps" }] }),
    get_project:    async ({ id }) => ({ id, name: "Tier-2 Wraps" }),
    list_teams:     async () => ({ teams: [{ id: "team_1", key: "STRIX" }] }),
    create_issue:   async ({ team, title }) => ({ id: "STRIX-9999", team, title, state: "open" }),
    update_issue:   async ({ id, state }) => ({ id, state, ok: true }),
    create_comment: async ({ issueId, body }) => ({ commentId: "c_demo", issueId, body }),
    delete_issue:   async ({ id }) => ({ id, deleted: true }),
    // NOTE: deliberately no archive_team — out-of-pack heuristic blocks it.
  };
}
