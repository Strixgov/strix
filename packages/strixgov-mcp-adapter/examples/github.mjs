/**
 * Wrap the GitHub MCP server with Strix governance.
 *
 *   node examples/github.mjs                # offline stub
 *   GITHUB_PERSONAL_ACCESS_TOKEN=ghp_… \
 *     node examples/github.mjs              # live — spawns github-mcp-server
 *
 * Demonstrates the strongest narrative wrap in the bundle: the
 * `merge_pull_request` flow. The GitHub MCP exposes ~30 tools; the
 * official @strixgov/capabilities-mcp-common/github pack classifies
 * every one of them. Merging is CRITICAL because it is irreversible
 * from the governance gate's perspective — a merged PR cannot be
 * un-merged atomically; revert is a *new* commit. This is the
 * cleanest "Strix held the irreversible action for approval, the
 * approval is bound cryptographically to the signed receipt" demo.
 *
 *   - LOW READ  → ALLOW   list_pull_requests, get_file_contents
 *   - MEDIUM    → APPROVAL_REQUIRED (auto-approved):
 *                 add_issue_comment, create_branch,
 *                 create_or_update_file
 *   - HIGH      → APPROVAL_REQUIRED (auto-approved):
 *                 create_pull_request
 *   - CRITICAL  → APPROVAL_REQUIRED (auto-approved) for the demo:
 *                 merge_pull_request — irreversible; gated by policy
 *                 to a known approver
 *   - out-of-pack → heuristic CRITICAL → DENY:
 *                 delete_repository (intentionally not in the pack;
 *                 the heuristic + fail-closed default blocks it,
 *                 proving "Strix fails closed on anything
 *                 unclassified")
 *
 * Live mode requires the optional MCP SDK + the official GitHub MCP:
 *
 *   npm install --no-save @modelcontextprotocol/sdk @modelcontextprotocol/server-github
 *   export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…
 *
 * Without those the example silently runs in stub mode so the
 * governance flow is still visible end to end.
 */

import { governMCPServer } from "@strixgov/mcp-adapter";
import { githubCapabilities } from "@strixgov/capabilities-mcp-common/github";

// ─── 1. Acquire a tool source ─────────────────────────────────────────────────

const toolSource = await loadToolSource();
console.log(`\n→ Using ${toolSource.mode} GitHub tools (serverId=github)\n`);

// ─── 2. Wrap with Strix — five lines ──────────────────────────────────────────

const governed = governMCPServer(toolSource.iface, {
  serverId: "github",
  capabilities: githubCapabilities,
  policy: {
    rules: {
      // Marquee story — CRITICAL irreversible action is held for
      // approval rather than outright DENY'd. The approver's identity
      // is bound to the receipt; the merge cannot be retroactively
      // approved. This is the procurement-legible policy.
      "mcp.github.merge_pull_request": "APPROVAL_REQUIRED",
    },
    riskOverrides: {
      LOW: "ALLOW",
      MEDIUM: "APPROVAL_REQUIRED",
      HIGH: "APPROVAL_REQUIRED",
      // Any OTHER CRITICAL action (i.e. one not named in `rules`)
      // defaults DENY. Combined with the heuristic-CRITICAL classification
      // for out-of-pack tools, this is what blocks `delete_repository`.
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

// ─── 3. Observe every signed receipt ──────────────────────────────────────────

const receipts = [];
governed.gateway.on("receipt", (r) => receipts.push(r));

// ─── 4. Drive a few representative calls ─────────────────────────────────────

await tryCall("list_pull_requests",    { owner: "octocat", repo: "hello", state: "open" });
await tryCall("get_file_contents",     { owner: "octocat", repo: "hello", path: "README.md" });
await tryCall("add_issue_comment",     { owner: "octocat", repo: "hello", issue_number: 1, body: "LGTM" });
await tryCall("create_branch",         { owner: "octocat", repo: "hello", branch: "feature/x", from: "main" });
await tryCall("create_or_update_file", { owner: "octocat", repo: "hello", path: "x.md", branch: "feature/x", message: "add x.md", content: "..." });
await tryCall("create_pull_request",   { owner: "octocat", repo: "hello", title: "Add x", head: "feature/x", base: "main" });
await tryCall("merge_pull_request",    { owner: "octocat", repo: "hello", pull_number: 7, merge_method: "merge" });
await tryCall("delete_repository",     { owner: "octocat", repo: "hello" }); // out-of-pack → heuristic CRITICAL → DENY

// ─── 5. Show what we proved ───────────────────────────────────────────────────

console.log(`\n─── ${receipts.length} signed receipts ──────────────────────────────`);
for (const r of receipts) {
  const sigPreview = r.signature ? r.signature.slice(0, 16) + "…" : "<missing>";
  console.log(
    `  ${r.decision.padEnd(8)} ${r.capabilityId.padEnd(38)} sig=${sigPreview}`,
  );
}

const chain = await governed.gateway.verifyChain();
console.log(`\nproof chain: valid=${chain.valid}, receipts=${chain.count ?? receipts.length}`);
console.log("\nThe approver identity on merge_pull_request is now bound");
console.log("cryptographically to the signed receipt. Verify offline with:");
console.log("  npx @strixgov/verifier chain ~/.strix-mcp-adapter/receipts.jsonl");

if (toolSource.dispose) await toolSource.dispose();

// ─── helpers ─────────────────────────────────────────────────────────────────

async function tryCall(name, args) {
  try {
    const result = await governed.callTool(name, args, { actorId: "agent-github-1" });
    const preview = JSON.stringify(result).slice(0, 80);
    console.log(`  ✓ ${name.padEnd(24)} → ALLOW   ${preview}`);
  } catch (err) {
    const code = err.code ?? "ERROR";
    console.log(`  ✗ ${name.padEnd(24)} → ${code}`);
  }
}

async function loadToolSource() {
  const wantsLive = Boolean(process.env.GITHUB_PERSONAL_ACCESS_TOKEN);
  if (wantsLive) {
    try {
      return await connectLiveGithubMcp();
    } catch (err) {
      console.warn(
        `\n⚠  Live mode requested but failed: ${err.message}\n` +
          "   Falling back to stub. Install the optional peers:\n" +
          "     npm install --no-save @modelcontextprotocol/sdk @modelcontextprotocol/server-github\n",
      );
    }
  }
  return { mode: "stub", iface: buildStubHandlers() };
}

async function connectLiveGithubMcp() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN },
  });
  const client = new Client({ name: "strix-demo", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    mode: "live (server-github via stdio)",
    iface: {
      serverId: "github",
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
  // Mirrors the on-the-wire tool surface of @modelcontextprotocol/server-github.
  // Just enough to render meaningful receipts.
  return {
    list_pull_requests:    async ({ owner, repo, state }) => ({ owner, repo, state, prs: [{ number: 7, title: "Add x", state: "open" }] }),
    get_file_contents:     async ({ owner, repo, path }) => ({ owner, repo, path, content: "(stub content)" }),
    add_issue_comment:     async ({ issue_number, body }) => ({ issue_number, comment_id: "c_demo", body }),
    create_branch:         async ({ branch, from }) => ({ branch, from, sha: "abc1234" }),
    create_or_update_file: async ({ path, branch, message }) => ({ path, branch, commit: "def5678", message }),
    create_pull_request:   async ({ title, head, base }) => ({ number: 7, title, head, base, state: "open" }),
    merge_pull_request:    async ({ pull_number, merge_method }) => ({ pull_number, merged: true, merge_method, sha: "merge1234" }),
    // NOTE: deliberately no `delete_repository` stub — the demo proves
    // the heuristic + default-DENY blocks unknown tools.
  };
}
