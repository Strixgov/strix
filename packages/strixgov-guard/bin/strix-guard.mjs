#!/usr/bin/env node
/**
 * strix-guard — CLI.
 *
 *   strix-guard init [--config <path>] [--webhook <url>] [--dry-run]
 *   strix-guard pending
 *   strix-guard approve <requestId> [--by <name>] [--reason <text>]
 *   strix-guard deny    <requestId> [--by <name>] [--reason <text>]
 *
 * All human-facing output goes to stderr-style plain lines on stdout —
 * this CLI never speaks the MCP protocol; the proxy does.
 */
import { runInit } from "../src/init.mjs";
import { listPending, respond } from "../src/approvals.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

function help() {
  console.log(`strix-guard — the seatbelt for MCP agents

Usage:
  strix-guard init [--config <path>] [--webhook <slack-webhook-url>] [--dry-run]
      Detect your MCP client config (Claude Code ./.mcp.json, Claude
      Desktop, Cursor), back it up, and wrap every server with the
      governed Strix proxy. Reads pass; writes block for human approval;
      every action produces a signed receipt.

  strix-guard pending
      List approval requests currently waiting on a human.

  strix-guard approve <requestId> [--by <name>] [--reason <text>]
  strix-guard deny    <requestId> [--by <name>] [--reason <text>]
      Decide a pending request. The blocked call resumes (or is refused)
      the moment the response lands.

Guard home: ~/.strix-guard (override: STRIX_GUARD_HOME)
No network telemetry — activation state stays in state.json, local only.`);
}

try {
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    help();
    process.exit(cmd ? 0 : 1);
  } else if (cmd === "--version" || cmd === "-v") {
    const { default: pkg } = await import("../package.json", { with: { type: "json" } });
    console.log(`strix-guard ${pkg.version}`);
  } else if (cmd === "init") {
    await runInit({
      config: flag("--config"),
      webhook: flag("--webhook"),
      dryRun: has("--dry-run"),
      log: (line) => console.log(line),
    });
  } else if (cmd === "pending") {
    const pending = await listPending();
    if (pending.length === 0) {
      console.log("[strix-guard] no pending approval requests");
    } else {
      for (const p of pending) {
        console.log(`${p.requestId}  ${p.capabilityId ?? "?"}  risk=${p.risk ?? "?"}  at=${p.requestedAt ?? "?"}`);
        if (p.argsPreview) console.log(`  args: ${p.argsPreview}`);
      }
      console.log(`\napprove: strix-guard approve <requestId>   deny: strix-guard deny <requestId>`);
    }
  } else if (cmd === "approve" || cmd === "deny") {
    const requestId = argv[1];
    const result = await respond(requestId, {
      approved: cmd === "approve",
      by: flag("--by"),
      reason: flag("--reason"),
    });
    console.log(
      `[strix-guard] ${result.approved ? "APPROVED" : "DENIED"} ${result.requestId} by ${result.approvedBy}`,
    );
  } else {
    console.error(`strix-guard: unknown command '${cmd}'`);
    help();
    process.exit(1);
  }
} catch (err) {
  console.error(err?.message ?? String(err));
  process.exit(1);
}
