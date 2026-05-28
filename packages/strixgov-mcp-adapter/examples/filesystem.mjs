/**
 * Wrap the Filesystem MCP server with Strix governance.
 *
 *   node examples/filesystem.mjs                       # offline stub
 *   STRIX_FS_LIVE_ROOT=/tmp/strix-fs-demo \
 *     node examples/filesystem.mjs                     # live — spawns
 *                                                      # @modelcontextprotocol/server-filesystem
 *
 * Demonstrates:
 *   - 5-line wrap of the filesystem MCP server with `governMCPServer`
 *   - Companion-pack classifications for the reference server's tool
 *     surface (read/list → LOW READ; write/edit → MEDIUM WRITE;
 *     move → HIGH WRITE; unknown → CRITICAL EXECUTE via heuristic)
 *   - Four policy outcomes against realistic filesystem operations:
 *     LOW READ ALLOW, MEDIUM WRITE APPROVAL_REQUIRED (auto-approved),
 *     HIGH WRITE APPROVAL_REQUIRED (auto-approved), and a heuristic-
 *     classified CRITICAL DENY for an unknown `delete_file` tool
 *   - Signed Ed25519 receipts emitted for every call — allowed or denied
 *
 * Live mode requires two optional peer installs:
 *
 *   npm install --no-save @modelcontextprotocol/sdk @modelcontextprotocol/server-filesystem
 *
 * And a root directory the MCP server is allowed to operate within:
 *
 *   mkdir -p /tmp/strix-fs-demo
 *   export STRIX_FS_LIVE_ROOT=/tmp/strix-fs-demo
 *
 * If either peer is missing or `STRIX_FS_LIVE_ROOT` isn't set, the
 * example silently falls back to a stub filesystem so you can still
 * see the full governance flow end to end.
 */

import { governMCPServer } from "@strixgov/mcp-adapter";
import { filesystemCapabilities } from "@strixgov/capabilities-mcp-common/filesystem";

// ─── 1. Acquire a tool source ─────────────────────────────────────────────────

const toolSource = await loadToolSource();
console.log(`\n→ Using ${toolSource.mode} Filesystem tools (serverId=filesystem)\n`);

// ─── 2. Wrap with Strix — five lines ──────────────────────────────────────────

const governed = governMCPServer(toolSource.iface, {
  serverId: "filesystem",
  capabilities: filesystemCapabilities,
  policy: {
    // Every read auto-allowed; every write held for approval; HIGH writes
    // (move_file) also held. Unknown tools fall through to the heuristic
    // (CRITICAL EXECUTE) and the default DENY blocks them — which is the
    // demo's `delete_file` case below.
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

// ─── 3. Observe every signed receipt ──────────────────────────────────────────

const receipts = [];
governed.gateway.on("receipt", (r) => receipts.push(r));

// ─── 4. Drive a few representative calls ─────────────────────────────────────

await tryCall("list_directory",   { path: toolSource.demoPath ?? "." });
await tryCall("read_file",        { path: (toolSource.demoPath ?? ".") + "/hello.txt" });
await tryCall("write_file",       { path: (toolSource.demoPath ?? ".") + "/hello.txt", content: "Hello from a governed agent\n" });
await tryCall("move_file",        { source: (toolSource.demoPath ?? ".") + "/hello.txt", destination: (toolSource.demoPath ?? ".") + "/greeting.txt" });
await tryCall("delete_file",      { path: (toolSource.demoPath ?? ".") + "/greeting.txt" }); // not in pack → heuristic → CRITICAL → DENY

// ─── 5. Show what we proved ───────────────────────────────────────────────────

console.log(`\n─── ${receipts.length} signed receipts ──────────────────────────────`);
for (const r of receipts) {
  const sigPreview = r.signature ? r.signature.slice(0, 16) + "…" : "<missing>";
  console.log(
    `  ${r.decision.padEnd(8)} ${r.capabilityId.padEnd(36)} sig=${sigPreview}`,
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
    const result = await governed.callTool(name, args, { actorId: "agent-fs-1" });
    const preview = JSON.stringify(result).slice(0, 80);
    console.log(`  ✓ ${name.padEnd(20)} → ALLOW   ${preview}`);
  } catch (err) {
    const code = err.code ?? "ERROR";
    console.log(`  ✗ ${name.padEnd(20)} → ${code}`);
  }
}

async function loadToolSource() {
  const wantsLive = Boolean(process.env.STRIX_FS_LIVE_ROOT);
  if (wantsLive) {
    try {
      return await connectLiveFilesystemMcp(process.env.STRIX_FS_LIVE_ROOT);
    } catch (err) {
      console.warn(
        `\n⚠  Live mode requested but failed: ${err.message}\n` +
          "   Falling back to stub. Install the optional peers:\n" +
          "     npm install --no-save @modelcontextprotocol/sdk @modelcontextprotocol/server-filesystem\n",
      );
    }
  }
  return { mode: "stub", iface: buildStubHandlers(), demoPath: "/demo" };
}

async function connectLiveFilesystemMcp(rootDir) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", rootDir],
  });
  const client = new Client({ name: "strix-demo", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    mode: "live (server-filesystem via stdio)",
    iface: {
      serverId: "filesystem",
      listTools: async () => {
        const out = await client.listTools();
        return out.tools.map((t) => ({ name: t.name, description: t.description }));
      },
      handler: async (name, args) => {
        return await client.callTool({ name, arguments: args ?? {} });
      },
    },
    demoPath: rootDir,
    dispose: async () => {
      try { await client.close(); } catch { /* best-effort */ }
    },
  };
}

function buildStubHandlers() {
  // Mirrors the on-the-wire tool surface of @modelcontextprotocol/server-filesystem.
  // Just enough to render meaningful receipts; no real disk I/O.
  const files = new Map([["/demo/hello.txt", "(canned demo content)\n"]]);
  return {
    list_directory: async ({ path }) => ({
      path,
      entries: [...files.keys()]
        .filter((p) => p.startsWith(path))
        .map((p) => ({ name: p.slice(path.length).replace(/^\//, ""), type: "file" })),
    }),
    read_file: async ({ path }) => ({ path, content: files.get(path) ?? "" }),
    read_multiple_files: async ({ paths }) =>
      ({ files: paths.map((p) => ({ path: p, content: files.get(p) ?? "" })) }),
    directory_tree: async ({ path }) => ({ path, tree: { name: path, children: [] } }),
    search_files: async ({ path, pattern }) => ({ path, pattern, matches: [] }),
    get_file_info: async ({ path }) => ({ path, size: (files.get(path) ?? "").length }),
    list_allowed_directories: async () => ({ directories: ["/demo"] }),
    write_file: async ({ path, content }) => { files.set(path, content); return { path, bytes: content.length }; },
    edit_file: async ({ path }) => ({ path, edited: true }),
    create_directory: async ({ path }) => ({ path, created: true }),
    move_file: async ({ source, destination }) => {
      const content = files.get(source);
      if (content !== undefined) {
        files.delete(source);
        files.set(destination, content);
      }
      return { source, destination, moved: content !== undefined };
    },
    // NOTE: deliberately no `delete_file` stub — the demo proves the
    // heuristic + default-DENY blocks unknown tools.
  };
}
