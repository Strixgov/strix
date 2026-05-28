#!/usr/bin/env node

/**
 * @strixgov/mcp-adapter — `demo` CLI.
 *
 * The canonical first-touch experience:
 *
 *   npx @strixgov/mcp-adapter demo
 *
 * One command. No clone, no install, no env vars. Spins up an
 * in-process stub MCP server, makes three governed tool calls
 * covering the three policy outcomes (ALLOW / APPROVAL_REQUIRED /
 * DENY), prints three Ed25519-signed receipts, then hands the chain
 * to `@strixgov/verifier` — an independent package with zero Strix
 * dependencies — and prints VERIFIED.
 *
 * The whole loop runs in well under 20 seconds and is the asciinema
 * shipped in every sales call.
 *
 * Why the demo proves something real:
 *
 *   1. The signing key, the policy engine, and the receipt format
 *      are the *exact same code paths* every production deployment
 *      runs. There is no demo-only signing shortcut.
 *   2. The verifier round-trip uses the public JWKS contract — any
 *      third party with `@strixgov/verifier` can run the same check
 *      against the same receipts and get the same answer.
 *   3. The DENY call still produces a signed receipt. Strix proves
 *      the attempt happened even when the action was blocked.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { governMCPServer } from "../src/index.mjs";

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVER_ID = "demo-github";
const ACTOR_ID = "agent-demo";

// Persist receipts to a unique temp dir so the final printed
// `npx @strixgov/verifier chain <path>` command is literal — copy/paste
// and it just works. Prior to this, the demo ran with MemoryStorage and
// the printed verifier hint pointed at a `./receipts.jsonl` that never
// existed, sending every first-time user into an ENOENT.
const STORAGE_DIR = path.join(
  os.tmpdir(),
  `strix-mcp-adapter-demo-${process.pid}-${Date.now()}`,
);
const RECEIPTS_FILE = path.join(STORAGE_DIR, "receipts.jsonl");
const JWKS_FILE = path.join(STORAGE_DIR, "public-jwks.json");

// Companion-pack-style capabilities for the three in-pack tools.
// Mirrors the shape of @strixgov/capabilities-mcp-common/github so the
// flow is byte-identical to the real GitHub adapter wrap. `delete_repository`
// is deliberately OUT of the pack — the heuristic + fail-closed default
// blocks it, proving the audit story.
const CAPABILITIES = [
  {
    id: "mcp.demo-github.get_file_contents",
    name: "get_file_contents",
    risk: "LOW",
    mode: "READ",
  },
  {
    id: "mcp.demo-github.merge_pull_request",
    name: "merge_pull_request",
    risk: "CRITICAL",
    mode: "WRITE",
  },
];

const POLICY = {
  rules: {
    // Marquee story — the irreversible CRITICAL action is held for
    // approval, not outright denied. The actor identity (`actorId`) is
    // hashed into `invocationHash`, which is one of the 14 fields the
    // Ed25519 signature covers — so the *actor* is cryptographically
    // bound to the receipt. The approver identity is recorded on the
    // receipt as metadata at sign time (`approvedBy`, alongside the
    // signed canonical payload). Binding the approver INTO the signed
    // bytes is a receipt schema v3 lift, tracked separately.
    "mcp.demo-github.merge_pull_request": "APPROVAL_REQUIRED",
  },
  riskOverrides: {
    LOW: "ALLOW",
  },
  // Anything else — including the out-of-pack `delete_repository` that
  // the heuristic classifies CRITICAL — fails closed.
  default: "DENY",
};

// The demo asserts a fixed receipt count both in code (the success guard)
// and in the regression test. Keep them in lockstep — extending the demo
// to N calls means bumping this constant AND the test regex together.
const EXPECTED_RECEIPTS = 3;

// Audit-legible relabels for the gateway's policy-reason codes (defined
// in `@strixgov/tool-gateway/src/policy.mjs`). The bare codes are
// correct but unfriendly on a screen share — "DEFAULT" reads as a
// config value, not a verdict.
const HUMAN_DENY_REASON = {
  DEFAULT: "DENIED_BY_DEFAULT (no rule matched, fail-closed)",
  NO_MATCH_FAIL_CLOSED: "DENIED_BY_DEFAULT (no capability registered)",
  EXACT_RULE: "DENIED_BY_RULE (explicit rule in policy)",
  PREFIX_RULE: "DENIED_BY_PREFIX_RULE",
  RISK_OVERRIDE: "DENIED_BY_RISK_TIER",
  UNKNOWN_CAPABILITY: "DENIED (unknown capability)",
  MALFORMED_INVOCATION: "DENIED (malformed invocation)",
};

// ─── Pretty-printing ──────────────────────────────────────────────────────────

const USE_COLOR =
  process.stdout.isTTY && process.env.NO_COLOR === undefined;

const c = USE_COLOR
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      magenta: (s) => `\x1b[35m${s}\x1b[0m`,
    }
  : {
      dim: (s) => s,
      bold: (s) => s,
      green: (s) => s,
      red: (s) => s,
      yellow: (s) => s,
      cyan: (s) => s,
      magenta: (s) => s,
    };

const RULE = c.dim("─".repeat(64));

function step(label) {
  console.log();
  console.log(c.bold(label));
  console.log(RULE);
}

function decisionTag(decision) {
  if (decision === "ALLOW") return c.green("ALLOW");
  if (decision === "DENY") return c.red(" DENY");
  return c.yellow(decision.padStart(5));
}

// ─── Stub MCP server ──────────────────────────────────────────────────────────

// In-process tool handlers — the shape `governMCPServer` accepts directly.
// Mirrors the on-the-wire surface of @modelcontextprotocol/server-github.
// No network, no spawned process, no token. The handlers exist to prove
// the ALLOW path actually runs the underlying tool body when policy permits.
function buildStubTools() {
  return {
    get_file_contents: async ({ owner, repo, path }) => ({
      owner,
      repo,
      path,
      content: "# Strix\nGovernance at the action boundary.\n",
      sha: "abc1234",
    }),
    merge_pull_request: async ({ owner, repo, pull_number, merge_method }) => ({
      owner,
      repo,
      pull_number,
      merged: true,
      merge_method,
      sha: "merge9999",
    }),
    // NOTE: deliberately no `delete_repository` handler. The demo proves
    // the heuristic + default-DENY blocks unknown tools before any handler
    // would run.
  };
}

// ─── Help / argv ──────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
@strixgov/mcp-adapter — governance for every MCP tool call

Usage:
  npx @strixgov/mcp-adapter demo              Run the canonical 20-second demo
  npx @strixgov/mcp-adapter init <name>       Scaffold a governed-server file
  npx @strixgov/mcp-adapter help              Show this help

\`demo\` spins up an in-process stub MCP server, drives three governed
tool calls (ALLOW / APPROVAL_REQUIRED / DENY), prints three Ed25519-
signed receipts, then verifies the chain with @strixgov/verifier — an
independent package with zero Strix dependencies — and prints VERIFIED.

\`init\` writes a runnable governed-server .mjs file into the current
directory. Auto-detects known companion packs (notion, github, slack,
linear, filesystem, postgres, email). Generated file runs immediately
in stub mode — 3 signed receipts, zero edits. Five TODO(strix) blocks
mark the integration points. Run \`init --help\` for flags.

After the demo, integrate into your own MCP server:

  import { governMCPServer } from "@strixgov/mcp-adapter";

  const governed = governMCPServer(myTools, {
    serverId: "github",
    capabilities: githubCapabilities,
    policy: { default: "DENY" },
  });

See: https://www.npmjs.com/package/@strixgov/mcp-adapter
`);
}

const argv = process.argv.slice(2);
const sub = argv[0];

if (sub === "help" || sub === "--help" || sub === "-h") {
  printHelp();
  process.exit(0);
}

if (sub === "init") {
  // Dispatch to the init scaffolder. Imported lazily so the demo flow
  // doesn't pay the parse cost on the hot path.
  const { runInit, formatInitSuccess, INIT_USAGE } = await import(
    "../src/cli-init.mjs"
  );
  const initArgs = argv.slice(1);
  if (initArgs[0] === "--help" || initArgs[0] === "-h") {
    process.stdout.write(INIT_USAGE + "\n");
    process.exit(0);
  }
  try {
    const result = runInit(initArgs);
    process.stdout.write(formatInitSuccess(result));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}

if (sub && sub !== "demo") {
  console.error(`Unknown subcommand: ${sub}`);
  console.error(`Try: npx @strixgov/mcp-adapter demo`);
  console.error(`     npx @strixgov/mcp-adapter init <server-name>`);
  process.exit(2);
}

// ─── Demo flow ────────────────────────────────────────────────────────────────

const startedAt = Date.now();

console.log();
console.log(c.bold("@strixgov/mcp-adapter — governance demo"));
console.log(c.dim("    one command · no env vars · runs in under 20 seconds"));

// 1. Spin up the stub MCP server + wrap with Strix.
step("1. Spin up a fake MCP server and wrap it with Strix");

const tools = buildStubTools();
console.log(
  c.dim("   stub server  ") +
    `serverId=${SERVER_ID}, tools=[get_file_contents, merge_pull_request]`,
);

const governed = governMCPServer(tools, {
  serverId: SERVER_ID,
  capabilities: CAPABILITIES,
  policy: POLICY,
  // `storagePath` is a DIRECTORY — JsonlStorage writes
  // `<storagePath>/receipts.jsonl` inside it. Passing a path that ends in
  // `.jsonl` would create a directory of that name containing a file
  // *also* called `receipts.jsonl`. The README's API table calls this
  // out; the demo wires it the correct way as the canonical example.
  storagePath: STORAGE_DIR,
  approval: {
    enabled: true,
    // Auto-approve for the demo. In production this is a human-in-the-loop
    // prompt, a webhook to an approval workflow, or a policy-as-code rule.
    //
    // NOTE — the approver identity is recorded on the receipt as metadata
    // at sign time (read by `issueReceipt` as `approval.approvedBy`). At
    // receipt schema v2 it is NOT included in the 14-field canonical
    // payload the Ed25519 signature covers; binding the approver INTO the
    // signed bytes is a v3 schema bump tracked separately. The actor
    // identity passed via `callTool(..., { actorId })` IS bound into the
    // signed payload via `invocationHash`.
    prompt: async (cap) => {
      console.log(
        c.dim("   approval gate ") +
          `auto-approving ${cap.id} as ${c.magenta("demo-approver")}`,
      );
      return { approved: true, approvedBy: "demo-approver" };
    },
  },
});

console.log(
  c.dim("   signing key  ") +
    `kid=${governed.signingKey.kid} ${c.dim("(Ed25519, in-memory)")}`,
);

// Collect every receipt as it's emitted — both the ALLOW that ran and the
// DENY that did not. Strix produces a signed receipt for every attempt.
const receipts = [];
governed.gateway.on("receipt", (r) => receipts.push(r));

// 2. Drive three tool calls. The decision matrix is the whole story.
step("2. Make three governed tool calls");

await callAndPrint("get_file_contents", {
  owner: "strixgov",
  repo: "demo",
  path: "README.md",
});

await callAndPrint("merge_pull_request", {
  owner: "strixgov",
  repo: "demo",
  pull_number: 42,
  merge_method: "squash",
});

// Out-of-pack tool — heuristic classifies CRITICAL EXECUTE, policy default
// DENYs. The handler is not registered; the demo proves Strix blocks at
// the gate, before the missing-handler path would even be reached.
await callAndPrint("delete_repository", { owner: "strixgov", repo: "demo" });

// 3. Print every receipt with its signature.
step(`3. Three Ed25519-signed receipts emitted (${receipts.length})`);

for (const r of receipts) {
  const sigPreview = r.signature
    ? r.signature.slice(0, 16) + "…"
    : c.red("<missing>");
  console.log(
    `   ${decisionTag(r.decision)}  ` +
      `${r.capabilityId.padEnd(40)} ` +
      c.dim(`sig=${sigPreview}`),
  );
  console.log(
    c.dim(
      `         receiptId=${r.receiptId}  kid=${r.signingKeyId}  actor=${r.actorId || "—"}`,
    ),
  );
}

// 4. Hand the chain to the public verifier — independent package, no Strix
//    deps of its own. This is the load-bearing claim: "Strix is not on the
//    trust path of receipt verification".
step("4. Verify the chain with @strixgov/verifier (independent package)");

let verifier;
try {
  verifier = await import("@strixgov/verifier");
} catch (err) {
  console.error(
    c.red("   ✗ @strixgov/verifier not resolvable — install it with:"),
  );
  console.error(c.red("       npm install @strixgov/verifier"));
  console.error(c.dim(`     (${err.message})`));
  process.exit(2);
}

// Build the JWKS the verifier needs from the gateway's signing key. In a
// real deployment the gateway publishes this at /.well-known/strix-jwks.json
// (via `npx strix-gateway keys jwks`); here we hand it in directly.
const jwks = { keys: [governed.signingKey.publicKeyJwk] };

const chain = await verifier.verifyReceiptChain(receipts, { jwks });

const signedOk = chain.receipts.filter(
  (r) => r.verificationStatus === "VERIFIED",
).length;
const linkOk = chain.chainValid;

console.log(c.dim("   verifier      ") + `@strixgov/verifier (Ed25519 + SHA-256, public JWKS)`);
console.log(
  c.dim("   chain valid   ") +
    (linkOk ? c.green("yes") : c.red(`no (broken at ${chain.brokenAt})`)),
);
console.log(
  c.dim("   signatures    ") +
    `${signedOk}/${chain.count} VERIFIED`,
);

// 5. The asciinema-worthy line.
console.log();
console.log(RULE);

const elapsedMs = Date.now() - startedAt;
// Floor the displayed time at 0.1s — the in-process loop genuinely
// completes in single-digit milliseconds, but "(0.0s)" reads as a
// broken timer on the asciinema screenshot.
const elapsedSec = Math.max(0.1, elapsedMs / 1000).toFixed(1);

const allGood =
  linkOk &&
  signedOk === chain.count &&
  chain.count === EXPECTED_RECEIPTS;

if (allGood) {
  // Write the JWKS to disk so the printed verifier command is literal —
  // the demo's signing key is in-memory and not published anywhere a
  // verifier could fetch it from, so `--jwks` is required for offline
  // verification. By the time we reach this branch every `appendReceipt`
  // has been awaited (the gateway emits `receipt` only after the disk
  // write resolves), so the JSONL file is guaranteed to contain all
  // three lines.
  await fs.writeFile(
    JWKS_FILE,
    JSON.stringify({ keys: [governed.signingKey.publicKeyJwk] }, null, 2) +
      "\n",
    { mode: 0o600 },
  );

  console.log(
    `   ${c.bold(c.green("✓ VERIFIED"))}  ` +
      `${EXPECTED_RECEIPTS} receipts, ${EXPECTED_RECEIPTS} valid signatures, chain intact ` +
      c.dim(`(${elapsedSec}s)`),
  );
  console.log();
  console.log(
    c.dim(
      "   Same primitive your auditor would run. No Strix tooling required:",
    ),
  );
  console.log(c.dim(`     # receipts persisted to:`));
  console.log(c.dim(`     #   ${RECEIPTS_FILE}`));
  console.log(c.dim(`     # signing key JWKS:`));
  console.log(c.dim(`     #   ${JWKS_FILE}`));
  console.log(
    c.dim(
      `     npx @strixgov/verifier chain ${RECEIPTS_FILE} --jwks ${JWKS_FILE}`,
    ),
  );
  console.log();
  process.exit(0);
}

// One or more receipts failed — surface why, then exit non-zero. The demo
// has to be honest: if a future code change breaks verification, the demo
// must fail loudly, not silently print VERIFIED.
console.log(
  `   ${c.bold(c.red("✗ VERIFICATION FAILED"))}  ` +
    c.dim(`(${elapsedSec}s)`),
);
for (const r of chain.receipts) {
  if (r.verificationStatus !== "VERIFIED") {
    console.log(
      c.red(
        `     ${r.receiptId ?? "—"}: ${r.verificationStatus}` +
          (r.error ? ` — ${r.error}` : ""),
      ),
    );
  }
}
console.log();
process.exit(1);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function callAndPrint(name, args) {
  const argPreview = JSON.stringify(args);
  const printArgs =
    argPreview.length > 56 ? argPreview.slice(0, 53) + "..." : argPreview;
  try {
    const result = await governed.callTool(name, args, { actorId: ACTOR_ID });
    const resultPreview = JSON.stringify(result).slice(0, 56);
    console.log(
      `   ${c.green("→")} ${name.padEnd(22)} ` +
        c.dim(printArgs.padEnd(58)) +
        ` ${c.green("ALLOW")}`,
    );
    console.log(c.dim(`         result: ${resultPreview}`));
  } catch (err) {
    // The gateway's denial path attaches err.code (the policy reason —
    // EXACT_RULE / RISK_OVERRIDE / DEFAULT / NO_MATCH_FAIL_CLOSED / etc.)
    // and err.receipt (the signed denial receipt). Relabel the bare
    // policy reasons into something audit-legible — `DEFAULT` alone
    // reads as a config value on a screen share, not a verdict.
    const code = err && err.code ? err.code : "ERROR";
    const reason = HUMAN_DENY_REASON[code] ?? code;
    console.log(
      `   ${c.red("→")} ${name.padEnd(22)} ` +
        c.dim(printArgs.padEnd(58)) +
        ` ${c.red(" DENY")}`,
    );
    console.log(c.dim(`         reason: ${reason}`));
  }
}
