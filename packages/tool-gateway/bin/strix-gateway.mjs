#!/usr/bin/env node
/**
 * strix-gateway — local-first CLI for governed tool execution.
 *
 * Subcommands:
 *
 *   init                       Generate signing key + default policy under
 *                              ~/.strix-gateway (or $STRIX_GATEWAY_HOME).
 *   keys list                  List all kids with status (active|retired).
 *   keys show [<kid>]          Print the public JWK (active kid by default).
 *   keys jwks                  Print the JWKS document — every kid the
 *                              ring has held, suitable for verifiers.
 *   keys rotate [--kid <id>]   Generate a new active key, retire current,
 *                              and write a cross-signed chain snapshot.
 *   policy show                Print the current policy ruleset.
 *   policy set <file>          Replace policy ruleset with the contents of <file>.
 *   receipts list [-n N]       Tail the last N receipts (default 20).
 *   receipts get <id>          Print a single receipt by id (JSON).
 *   snapshots list             List rotation snapshots with previousKid → newKid.
 *   verify [<id>]              Verify a single receipt (or all) using the
 *                              local KeyRing — no network required.
 *   chain                      Walk the proof chain and report breaks.
 *   status                     Quick gateway health summary.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import {
  loadOrCreateKeyRing,
  JsonlStorage,
  Gateway,
  validateRuleset,
  verifyReceipt,
  verifySnapshot,
} from "../src/index.mjs";
import { expandTilde } from "../src/paths.mjs";

// Expand tilde on the user-supplied home so `STRIX_GATEWAY_HOME=~/foo` works.
// KEY_DIR / POLICY_FILE / the storage dir all derive from HOME, so this one
// expansion covers every path the CLI touches.
const HOME = expandTilde(
  process.env.STRIX_GATEWAY_HOME ?? path.join(os.homedir(), ".strix-gateway"),
);
const POLICY_FILE = path.join(HOME, "policy.json");
const KEY_DIR = path.join(HOME, "keys");

function fail(msg, code = 1) {
  process.stderr.write(`strix-gateway: ${msg}\n`);
  process.exit(code);
}

function ok(msg) {
  process.stdout.write(`${msg}\n`);
}

const DEFAULT_POLICY = {
  rules: {
    "filesystem.read": "ALLOW",
    "filesystem.list": "ALLOW",
    "filesystem.write": "APPROVAL_REQUIRED",
    "filesystem.append": "APPROVAL_REQUIRED",
    "filesystem.delete": "DENY",
    "shell.exec": "APPROVAL_REQUIRED",
    "shell.spawn": "APPROVAL_REQUIRED",
  },
  riskOverrides: {
    CRITICAL: "DENY",
  },
  default: "DENY",
};

async function readPolicy() {
  try {
    const raw = await fs.readFile(POLICY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return validateRuleset(parsed);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writePolicy(rules) {
  await fs.mkdir(HOME, { recursive: true, mode: 0o700 });
  await fs.writeFile(POLICY_FILE, JSON.stringify(rules, null, 2), {
    mode: 0o644,
  });
}

async function cmdInit() {
  await fs.mkdir(HOME, { recursive: true, mode: 0o700 });
  const ring = await loadOrCreateKeyRing({ root: KEY_DIR });
  let policy = await readPolicy();
  if (!policy) {
    await writePolicy(DEFAULT_POLICY);
    policy = DEFAULT_POLICY;
  }
  ok(`Initialized strix-gateway home: ${HOME}`);
  ok(`  active kid    : ${ring.active.kid}`);
  ok(`  total kids    : ${ring.listKids().length}`);
  ok(`  policy file   : ${POLICY_FILE}`);
  ok(`  rules         : ${Object.keys(policy.rules).length}`);
  ok(`  default       : ${policy.default ?? "<DENY (fail-closed)>"}`);
}

async function cmdKeys(sub, ...rest) {
  const ring = await loadOrCreateKeyRing({ root: KEY_DIR });
  if (sub === "list" || !sub) {
    for (const kid of ring.listKids()) {
      const e = ring.get(kid);
      const tag = e.kid === ring.active.kid ? "active " : "retired";
      const retiredAt = e.meta.retiredAt ? `  retired=${e.meta.retiredAt}` : "";
      ok(`  ${tag}  ${e.kid}  generated=${e.meta.generatedAt}${retiredAt}`);
    }
    return;
  }
  if (sub === "show") {
    const kid = rest[0] ?? ring.active.kid;
    const e = ring.get(kid);
    if (!e) fail(`unknown kid: ${kid}`, 1);
    ok(JSON.stringify(e.publicKeyJwk, null, 2));
    return;
  }
  if (sub === "jwks") {
    ok(JSON.stringify(ring.jwks(), null, 2));
    return;
  }
  if (sub === "rotate") {
    let kid;
    const ki = rest.indexOf("--kid");
    if (ki >= 0 && rest[ki + 1]) kid = rest[ki + 1];
    const policy = (await readPolicy()) ?? DEFAULT_POLICY;
    const storage = new JsonlStorage({ dir: HOME });
    const last = await storage.lastReceipt();
    if (!last) {
      fail(
        "rotate requires at least one receipt in the chain (the snapshot must commit to a real proofChainHash)",
        1,
      );
    }
    const gateway = new Gateway({
      policy,
      capabilities: {},
      keyRing: ring,
      storage,
    });
    const snap = await gateway.rotateKey({ kid });
    ok(`Rotated key:`);
    ok(`  previous kid  : ${snap.previousKid}`);
    ok(`  new kid       : ${snap.newKid}`);
    ok(`  snapshot id   : ${snap.snapshotId}`);
    ok(`  last receipt  : ${snap.lastReceiptId}`);
    return;
  }
  fail(`unknown 'keys' subcommand: ${sub}`, 2);
}

async function cmdPolicy(sub, arg) {
  if (sub === "show" || !sub) {
    const p = (await readPolicy()) ?? DEFAULT_POLICY;
    ok(JSON.stringify(p, null, 2));
    return;
  }
  if (sub === "set") {
    if (!arg) fail("policy set requires a path to a JSON file", 2);
    const raw = await fs.readFile(arg, "utf8");
    const parsed = JSON.parse(raw);
    validateRuleset(parsed);
    await writePolicy(parsed);
    ok(`policy updated (${Object.keys(parsed.rules).length} rules)`);
    return;
  }
  fail(`unknown 'policy' subcommand: ${sub}`, 2);
}

async function cmdReceipts(sub, ...rest) {
  const storage = new JsonlStorage({ dir: HOME });
  if (sub === "list" || !sub) {
    let n = 20;
    const ni = rest.indexOf("-n");
    if (ni >= 0 && rest[ni + 1]) n = parseInt(rest[ni + 1], 10) || 20;
    const all = await storage.listReceipts();
    const tail = all.slice(-n);
    for (const r of tail) {
      ok(
        `${r.timestamp}  ${r.decision.padEnd(18)}  ${r.risk.padEnd(8)}  ${r.capabilityId.padEnd(28)}  ${r.receiptId}`
      );
    }
    return;
  }
  if (sub === "get") {
    const id = rest[0];
    if (!id) fail("receipts get requires a receipt id", 2);
    const r = await storage.getReceipt(id);
    if (!r) fail(`receipt not found: ${id}`, 1);
    ok(JSON.stringify(r, null, 2));
    return;
  }
  fail(`unknown 'receipts' subcommand: ${sub}`, 2);
}

async function cmdSnapshots(sub) {
  const storage = new JsonlStorage({ dir: HOME });
  const ring = await loadOrCreateKeyRing({ root: KEY_DIR });
  if (sub === "list" || !sub) {
    const all = await storage.listSnapshots();
    if (all.length === 0) {
      ok("(no snapshots — the active kid has signed every receipt)");
      return;
    }
    for (const s of all) {
      const v = verifySnapshot(s, {
        resolvePublicKey: (kid) => ring.publicKeyForKid(kid),
      });
      ok(
        `${s.timestamp}  ${s.previousKid}  →  ${s.newKid}  [${v.status}]  ${s.snapshotId}`
      );
    }
    return;
  }
  fail(`unknown 'snapshots' subcommand: ${sub}`, 2);
}

async function cmdVerify(maybeId) {
  const ring = await loadOrCreateKeyRing({ root: KEY_DIR });
  const storage = new JsonlStorage({ dir: HOME });
  let targets = [];
  if (maybeId) {
    const r = await storage.getReceipt(maybeId);
    if (!r) fail(`receipt not found: ${maybeId}`, 1);
    targets = [r];
  } else {
    targets = await storage.listReceipts();
  }
  let pass = 0;
  let fails = 0;
  for (const r of targets) {
    const publicKey = ring.publicKeyForKid(r.signingKeyId);
    if (!publicKey) {
      ok(`✗ ${r.receiptId}  ERROR (kid not in keyring: ${r.signingKeyId})`);
      fails++;
      continue;
    }
    const result = verifyReceipt(r, publicKey);
    const symbol = result.status === "VERIFIED" ? "✓" : "✗";
    ok(
      `${symbol} ${r.receiptId}  ${result.status}${result.error ? ` (${result.error})` : ""} [kid=${r.signingKeyId}]`
    );
    if (result.status === "VERIFIED") pass++;
    else fails++;
  }
  ok(`\n${pass}/${pass + fails} receipts VERIFIED`);
  if (fails > 0) process.exit(1);
}

async function cmdChain() {
  const ring = await loadOrCreateKeyRing({ root: KEY_DIR });
  const policy = (await readPolicy()) ?? DEFAULT_POLICY;
  const storage = new JsonlStorage({ dir: HOME });
  const gateway = new Gateway({
    policy,
    capabilities: {},
    keyRing: ring,
    storage,
  });
  const result = await gateway.verifyChain();
  if (result.valid) ok("proof chain: OK");
  else fail(`proof chain BROKEN at ${result.brokenAt}`, 1);
}

async function cmdStatus() {
  const ring = await loadOrCreateKeyRing({ root: KEY_DIR });
  const policy = (await readPolicy()) ?? DEFAULT_POLICY;
  const storage = new JsonlStorage({ dir: HOME });
  const all = await storage.listReceipts();
  const snaps = await storage.listSnapshots();
  const counts = { ALLOW: 0, DENY: 0, APPROVAL_REQUIRED: 0 };
  for (const r of all) counts[r.decision] = (counts[r.decision] ?? 0) + 1;
  ok(`strix-gateway`);
  ok(`  home          : ${HOME}`);
  ok(`  active kid    : ${ring.active.kid}`);
  ok(`  total kids    : ${ring.listKids().length}`);
  ok(`  rotations     : ${snaps.length}`);
  ok(`  policy rules  : ${Object.keys(policy.rules ?? {}).length}`);
  ok(`  default       : ${policy.default ?? "DENY"}`);
  ok(`  receipts      : ${all.length}`);
  ok(`    ALLOW       : ${counts.ALLOW}`);
  ok(`    DENY        : ${counts.DENY}`);
  ok(`    APPROVED    : ${counts.APPROVAL_REQUIRED}`);
}

function usage() {
  process.stdout.write(`strix-gateway — governed tool execution

Usage:
  strix-gateway init
  strix-gateway keys [list|show [<kid>]|jwks|rotate [--kid <id>]]
  strix-gateway policy [show|set <file>]
  strix-gateway receipts [list [-n N]|get <id>]
  strix-gateway snapshots [list]
  strix-gateway verify [<receipt-id>]
  strix-gateway chain
  strix-gateway status

Local-first. No network calls. Storage at ${HOME}.
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return usage();
      case "init":
        return await cmdInit();
      case "keys":
        return await cmdKeys(rest[0], ...rest.slice(1));
      case "policy":
        return await cmdPolicy(rest[0], rest[1]);
      case "receipts":
        return await cmdReceipts(rest[0], ...rest.slice(1));
      case "snapshots":
        return await cmdSnapshots(rest[0]);
      case "verify":
        return await cmdVerify(rest[0]);
      case "chain":
        return await cmdChain();
      case "status":
        return await cmdStatus();
      default:
        usage();
        fail(`unknown command: ${cmd}`, 2);
    }
  } catch (err) {
    fail(err instanceof Error ? err.stack || err.message : String(err), 1);
  }
}

main();
