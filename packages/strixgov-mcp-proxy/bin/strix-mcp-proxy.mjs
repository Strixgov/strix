#!/usr/bin/env node
/**
 * strix-mcp-proxy — CLI entry.
 *
 * Two invocation modes:
 *
 *   strix-mcp-proxy --config ./proxy-config.json
 *
 *   strix-mcp-proxy \
 *     --upstream-command npx \
 *     --upstream-arg "-y" --upstream-arg "@notionhq/notion-mcp-server" \
 *     --server-id notion \
 *     --capabilities @strixgov/capabilities-mcp-common/notion \
 *     --policy-default DENY \
 *     --risk-low ALLOW --risk-medium APPROVAL_REQUIRED
 *
 * The CLI is intentionally minimal — anything elaborate goes in the
 * config file. Operators wiring this into Claude Desktop, mcp-cli, or
 * an IDE integration just change their existing MCP command from
 * `<upstream>` to `strix-mcp-proxy --config <path>`.
 *
 * Audit events (proxy lifecycle + denied calls) print to stderr so the
 * MCP stdio channel on stdout stays clean for the protocol.
 */

import { startProxy, loadConfig, resolveCapabilities } from "../src/index.mjs";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  printHelp();
  process.exit(0);
}
if (argv.includes("--version") || argv.includes("-v")) {
  const { default: pkg } = await import("../package.json", { with: { type: "json" } });
  console.log(`strix-mcp-proxy ${pkg.version}`);
  process.exit(0);
}

try {
  const opts = await parseArgs(argv);
  const handle = await startProxy({
    ...opts,
    onAudit: (event) => {
      // stderr: doesn't collide with the MCP stdio protocol on stdout.
      console.error(`[strix-proxy] ${event.kind} ${JSON.stringify(event.detail)}`);
    },
    onReceipt: (r) => {
      // One-line summary per receipt; full receipts persist via storagePath when set.
      console.error(`[strix-proxy] receipt ${r.decision} ${r.capabilityId}`);
    },
  });

  const shutdown = async (signal) => {
    console.error(`[strix-proxy] shutting down (${signal})`);
    try { await handle.stop(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} catch (err) {
  console.error(`[strix-proxy] startup failed: ${err.message}`);
  process.exit(1);
}

// ─── arg parsing ────────────────────────────────────────────────────────────

async function parseArgs(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flagAll = (name) => {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === name) out.push(argv[i + 1]);
    }
    return out;
  };

  const configPath = flag("--config");
  if (configPath) {
    const cfg = await loadConfig(configPath);
    return {
      serverId: cfg.serverId,
      upstream: cfg.upstream,
      capabilities: await resolveCapabilities(cfg.capabilities),
      policy: cfg.policy,
      approval: cfg.approval,
      storagePath: cfg.storagePath,
      keyPath: cfg.keyPath,
    };
  }

  const upstreamCommand = flag("--upstream-command");
  if (!upstreamCommand) {
    throw new Error("missing --config or --upstream-command (run with --help)");
  }
  const upstreamArgs = flagAll("--upstream-arg");
  const serverId = flag("--server-id") ?? "proxy";
  const capabilitiesPath = flag("--capabilities");
  const policyDefault = flag("--policy-default") ?? "DENY";
  const riskOverrides = {};
  for (const level of ["LOW", "MEDIUM", "HIGH", "CRITICAL"]) {
    const v = flag(`--risk-${level.toLowerCase()}`);
    if (v) riskOverrides[level] = v;
  }
  const approvalEnabled = argv.includes("--approval-enabled");
  const storagePath = flag("--storage-path");

  return {
    serverId,
    upstream: { command: upstreamCommand, args: upstreamArgs },
    capabilities: capabilitiesPath ? await resolveCapabilities(capabilitiesPath) : undefined,
    policy: {
      riskOverrides: Object.keys(riskOverrides).length > 0 ? riskOverrides : undefined,
      default: policyDefault,
    },
    approval: { enabled: approvalEnabled },
    storagePath,
  };
}

function printHelp() {
  console.log(`strix-mcp-proxy — governed MCP proxy

USAGE
  strix-mcp-proxy --config <path>
  strix-mcp-proxy --upstream-command <cmd> [--upstream-arg <a> ...] [other flags]

CONFIG-FILE MODE
  --config <path>           Path to a JSON config file (see README for shape)

FLAG MODE
  --upstream-command <cmd>  Command to spawn the upstream MCP server (e.g. "npx")
  --upstream-arg <arg>      One arg for the upstream command (repeatable)
  --server-id <id>          Namespace prefix for capability ids (default: "proxy")
  --capabilities <pkg>      Companion-pack import path
                            (e.g. @strixgov/capabilities-mcp-common/notion)
  --policy-default <D>      Default decision for unmatched calls: ALLOW or DENY
                            (default: DENY)
  --risk-low <D>            Override decision for LOW-risk calls
  --risk-medium <D>         Override decision for MEDIUM-risk calls
  --risk-high <D>           Override decision for HIGH-risk calls
  --risk-critical <D>       Override decision for CRITICAL-risk calls
  --approval-enabled        Enable the approval gate (requires custom prompt)
  --storage-path <dir>      Persist receipts to JSONL at this directory
                            (default: in-memory)

GENERAL
  --help, -h                Show this help
  --version, -v             Show proxy version

The proxy speaks MCP over stdio toward its consumer. Configure your
MCP-aware client (Claude Desktop, mcp-cli, etc.) to spawn this binary
in place of the upstream MCP server you previously used directly.
`);
}
