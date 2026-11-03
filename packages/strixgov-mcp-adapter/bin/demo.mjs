#!/usr/bin/env node

/**
 * @strixgov/mcp-adapter — canonical first-touch demo.
 *
 * Runs three governed MCP calls, persists signed authorization receipts and
 * linked post-execution outcomes, verifies the authorization chain with the
 * independent verifier, and prints a literal offline verification command.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateSigningKey } from "@strixgov/tool-gateway";
import { governMCPServer } from "../src/index.mjs";

const SERVER_ID = "demo-github";
const ACTOR_ID = "agent-demo";
const EXPECTED_RECEIPTS = 3;
const STORAGE_DIR = path.join(
  os.tmpdir(),
  `strix-mcp-adapter-demo-${process.pid}-${Date.now()}`,
);
const RECEIPTS_FILE = path.join(STORAGE_DIR, "receipts.jsonl");
const OUTCOMES_FILE = path.join(STORAGE_DIR, "execution-outcomes.jsonl");
const JWKS_FILE = path.join(STORAGE_DIR, "public-jwks.json");

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
    "mcp.demo-github.merge_pull_request": "APPROVAL_REQUIRED",
  },
  riskOverrides: { LOW: "ALLOW" },
  default: "DENY",
};

const HUMAN_DENY_REASON = {
  DEFAULT: "DENIED_BY_DEFAULT (no rule matched, fail-closed)",
  NO_MATCH_FAIL_CLOSED: "DENIED_BY_DEFAULT (no capability registered)",
  EXACT_RULE: "DENIED_BY_RULE (explicit rule in policy)",
  PREFIX_RULE: "DENIED_BY_PREFIX_RULE",
  RISK_OVERRIDE: "DENIED_BY_RISK_TIER",
  UNKNOWN_CAPABILITY: "DENIED (unknown capability)",
  MALFORMED_INVOCATION: "DENIED (malformed invocation)",
};

function printHelp() {
  console.log(`
@strixgov/mcp-adapter — governance for every MCP tool call

Usage:
  npx @strixgov/mcp-adapter demo              Run the canonical demo
  npx @strixgov/mcp-adapter init <name>       Scaffold a governed-server file
  npx @strixgov/mcp-adapter help              Show this help

The demo drives ALLOW, approved, and DENY paths, writes signed authorization
receipts plus post-execution outcomes, and verifies the authorization chain with
@strixgov/verifier.
`);
}

const argv = process.argv.slice(2);
const sub = argv[0];

if (sub === "help" || sub === "--help" || sub === "-h") {
  printHelp();
  process.exit(0);
}

if (sub === "init") {
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
  console.error("Try: npx @strixgov/mcp-adapter demo");
  process.exit(2);
}

const startedAt = Date.now();
const signingKey = generateSigningKey(`strix-${SERVER_ID}`);
const tools = {
  get_file_contents: async ({ owner, repo, path: filePath }) => ({
    owner,
    repo,
    path: filePath,
    content: "# Strix\nGovernance at the action boundary.\n",
    sha: "abc1234",
  }),
  merge_pull_request: async ({ pull_number, merge_method }) => ({
    pull_number,
    merged: true,
    merge_method,
    sha: "merge9999",
  }),
};

const governed = governMCPServer(tools, {
  serverId: SERVER_ID,
  capabilities: CAPABILITIES,
  policy: POLICY,
  storagePath: STORAGE_DIR,
  // Durable storage is never paired with an implicit ephemeral key. The demo
  // supplies an explicit throwaway key and writes its public JWKS beside the
  // records, making the printed offline verifier command reproducible.
  signingKey,
  approval: {
    enabled: true,
    prompt: async () => ({
      approved: true,
      approvedBy: "demo-approver",
      reason: "USER_APPROVED",
    }),
  },
});

const receipts = [];
const outcomes = [];
governed.gateway.on("receipt", (receipt) => receipts.push(receipt));
governed.gateway.on("outcome", (outcome) => outcomes.push(outcome));

console.log("\n@strixgov/mcp-adapter — governance demo");
console.log("────────────────────────────────────────────────────────────────");

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
await callAndPrint("delete_repository", {
  owner: "strixgov",
  repo: "demo",
});

console.log(`\nThree Ed25519-signed receipts emitted (${receipts.length})`);
for (const receipt of receipts) {
  console.log(
    `  ${receipt.decision.padEnd(5)} ${receipt.capabilityId} receipt=${receipt.receiptId}`,
  );
}
console.log(
  `  execution outcomes: ${outcomes.length} ` +
    `(DENY has no outcome because its handler was not invoked)`,
);

const verifier = await import("@strixgov/verifier");
const jwks = { keys: [signingKey.publicKeyJwk] };
const chain = await verifier.verifyReceiptChain(receipts, { jwks });
const signedOk = chain.receipts.filter(
  (receipt) => receipt.verificationStatus === "VERIFIED",
).length;

console.log(`\nchain valid   ${chain.chainValid ? "yes" : "no"}`);
console.log(`signatures    ${signedOk}/${chain.count} VERIFIED`);

const allGood =
  chain.chainValid &&
  signedOk === EXPECTED_RECEIPTS &&
  chain.count === EXPECTED_RECEIPTS &&
  outcomes.length === 2;

if (!allGood) {
  console.error("\n✗ VERIFICATION FAILED");
  process.exit(1);
}

await fs.writeFile(
  JWKS_FILE,
  JSON.stringify(jwks, null, 2) + "\n",
  { mode: 0o600 },
);

const elapsed = Math.max(0.1, (Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  `\n✓ VERIFIED  ${EXPECTED_RECEIPTS} receipts, ` +
    `${EXPECTED_RECEIPTS} valid signatures, chain intact (${elapsed}s)`,
);
console.log("  authorization receipts:");
console.log(`    ${RECEIPTS_FILE}`);
console.log("  signed execution outcomes:");
console.log(`    ${OUTCOMES_FILE}`);
console.log("  public JWKS:");
console.log(`    ${JWKS_FILE}`);
console.log(
  `  npx @strixgov/verifier chain ${RECEIPTS_FILE} --jwks ${JWKS_FILE}`,
);

async function callAndPrint(name, args) {
  try {
    const result = await governed.callTool(name, args, { actorId: ACTOR_ID });
    console.log(`ALLOW ${name} result=${JSON.stringify(result).slice(0, 72)}`);
  } catch (err) {
    const code = err?.code ?? "ERROR";
    console.log(`DENY  ${name} reason=${HUMAN_DENY_REASON[code] ?? code}`);
  }
}
