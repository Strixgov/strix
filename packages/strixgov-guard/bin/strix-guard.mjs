#!/usr/bin/env node
/**
 * strix-guard — CLI.
 *
 *   strix-guard init [--config <path>] [--audit-config <path>]... [--webhook <url>] [--unsigned-approvals] [--dry-run]
 *   strix-guard uninstall [--config <path>] [--dry-run]
 *   strix-guard approver init [--label <name>] [--force] | approver show
 *   strix-guard pending
 *   strix-guard approve <requestId> [--by <name>] [--reason <text>]
 *   strix-guard deny    <requestId> [--by <name>] [--reason <text>]
 *
 * All human-facing output goes to stderr-style plain lines on stdout —
 * this CLI never speaks the MCP protocol; the proxy does.
 */
import { runInit } from "../src/init.mjs";
import { listPending, respond } from "../src/approvals.mjs";
import { auditCoverage, formatCoverage } from "../src/coverage.mjs";
import { createApproverKey, readApproverPublic, approveSigned } from "../src/approver.mjs";
import { runUninstall } from "../src/uninstall.mjs";
import { ttyIo } from "../src/tty.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);
const multi = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

function help() {
  console.log(`strix-guard — the seatbelt for MCP agents

Usage:
  strix-guard init [--config <path>] [--audit-config <path>]... [--webhook <slack-webhook-url>] [--unsigned-approvals] [--dry-run]
      Detect your MCP client config (Claude Code ./.mcp.json, Claude
      Desktop, Cursor), back it up, and wrap every server with the
      governed Strix proxy. Reads pass; writes block for human approval;
      every action produces a signed receipt. Approvals must be signed
      with your approver key (created on first run if you are in a
      terminal). --unsigned-approvals opts out: approvals become files
      any process running as you can write.

  strix-guard uninstall [--config <path>] [--dry-run]
      Restore each wrapped server's original command from its Guard proxy
      config (the client config is backed up first). Keeps ~/.strix-guard.

  strix-guard coverage [--audit-config <path>]... [--json] [--strict]
      Read-only audit of known MCP client configs: which servers are
      proxied and which are still launched directly. Never modifies a
      config. --strict exits 2 unless no direct/unknown route is found.

  strix-guard pending
      List approval requests currently waiting on a human.

  strix-guard approver init [--label <name>] [--force]
  strix-guard approver show
      Create (or show) the approver key used for signed approvals. The
      private key is encrypted under a passphrase you type in a terminal.
      Then: strix-guard init

  strix-guard approve <requestId> [--by <name>] [--reason <text>]
  strix-guard deny    <requestId> [--by <name>] [--reason <text>]
      Decide a pending request. The blocked call resumes (or is refused)
      the moment the response lands. If an approver key exists, approve
      shows the request, asks you to type "yes", and signs with your
      passphrase; otherwise it writes an unsigned response (proxies that
      require signed approvals, the default, refuse those). Denials are
      never signed.

Guard home: ~/.strix-guard (override: STRIX_GUARD_HOME)
No network telemetry — activation state stays in state.json, local only.`);
}

async function promptCreateApprover(io, { label, force } = {}) {
  console.log("[strix-guard] approvals must be signed; creating your approver key.");
  const a = await io.secret("New approver passphrase (12+ characters): ");
  const b = await io.secret("Repeat passphrase: ");
  if (a !== b) throw new Error("strix-guard: passphrases do not match (nothing written)");
  const pub = await createApproverKey({ passphrase: a, label: label ?? "approver", force: !!force });
  console.log(`[strix-guard] approver key created: "${pub.label}"  key ${pub.kid}`);
  console.log("A forgotten passphrase cannot be recovered; create a new key with `strix-guard approver init --force` and re-run init.");
  return pub;
}

try {
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    help();
    process.exit(cmd ? 0 : 1);
  } else if (cmd === "--version" || cmd === "-v") {
    const { default: pkg } = await import("../package.json", { with: { type: "json" } });
    console.log(`strix-guard ${pkg.version}`);
  } else if (cmd === "init") {
    const io = ttyIo();
    await runInit({
      config: flag("--config"),
      webhook: flag("--webhook"),
      signedApprovals: has("--signed-approvals"),
      unsignedApprovals: has("--unsigned-approvals"),
      createApprover: io.isTty ? () => promptCreateApprover(io, { label: flag("--label") }) : undefined,
      auditExtra: multi("--audit-config"),
      dryRun: has("--dry-run"),
      log: (line) => console.log(line),
    });
  } else if (cmd === "uninstall") {
    await runUninstall({ config: flag("--config"), dryRun: has("--dry-run"), log: (line) => console.log(line) });
  } else if (cmd === "coverage") {
    const report = await auditCoverage({ extraConfigs: multi("--audit-config") });
    if (has("--json")) console.log(JSON.stringify(report, null, 2));
    else for (const l of formatCoverage(report)) console.log(l);
    if (has("--strict") && report.status !== "COVERAGE_ESTABLISHED_FOR_KNOWN_CONFIGS") process.exit(2);
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
  } else if (cmd === "approver") {
    const io = ttyIo();
    if (argv[1] === "show") {
      const pub = await readApproverPublic();
      console.log(pub ? `approver "${pub.label}"  key ${pub.kid}\npublic key ${pub.publicKey}` : "no approver key (run: strix-guard approver init)");
    } else if (argv[1] === "init") {
      if (!io.isTty) throw new Error("strix-guard: approver init needs an interactive terminal (the passphrase is never read from arguments, the environment or a pipe)");
      await promptCreateApprover(io, { label: flag("--label"), force: has("--force") });
      console.log("Next: strix-guard init   (then restart your MCP client)");
    } else {
      throw new Error("usage: strix-guard approver init [--label <name>] [--force] | approver show");
    }
  } else if (cmd === "approve" && (await readApproverPublic())) {
    if (flag("--by")) console.log("[strix-guard] note: --by is ignored for signed approvals; the approver is your key's label");
    const r = await approveSigned(argv[1], { io: ttyIo() });
    console.log(`[strix-guard] APPROVED ${r.requestId} by "${r.label}" [key ${r.kid.slice(0, 8)}] (signed)`);
  } else if (cmd === "approve" || cmd === "deny") {
    const requestId = argv[1];
    if (cmd === "approve") console.error("[strix-guard] no approver key: writing an UNSIGNED approval (proxies that require signed approvals, the default, refuse it). See: strix-guard approver init");
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
