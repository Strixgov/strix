/**
 * CLI smoke — `bin/demo.mjs` is the canonical first-touch experience
 * (`npx @strixgov/mcp-adapter demo`). It MUST stay green end-to-end:
 * a future refactor that breaks the demo's verifier round-trip turns
 * every sales-call asciinema, every new-user first run, into a public
 * failure.
 *
 * What this test pins:
 *
 *   1. Exit code 0 on the happy path.
 *   2. The output contains "VERIFIED" — the asciinema-worthy string.
 *   3. Exactly three signed receipts are emitted.
 *   4. All three policy outcomes are represented (ALLOW for the read,
 *      ALLOW for the approved merge, DENY for the out-of-pack delete).
 *   5. Help / unknown-subcommand paths return their documented exit codes.
 *
 * If any of these break, the demo is not safe to ship to a prospect.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "bin", "demo.mjs");

// Strip ANSI escape sequences so the assertions don't depend on the
// terminal renderer the test process happens to have. The CLI already
// guards on isTTY, but pipe-friendly assertions are cleaner regardless.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function runCli(args = []) {
  const out = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: out.status,
    stdout: stripAnsi(out.stdout ?? ""),
    stderr: stripAnsi(out.stderr ?? ""),
  };
}

test("`demo` exits 0 and prints VERIFIED with three signed receipts", { timeout: 30_000 }, () => {
  const out = runCli(["demo"]);
  assert.equal(
    out.status,
    0,
    `demo exited ${out.status}\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`,
  );

  // Asciinema-worthy line — the whole pitch hinges on this being printed.
  assert.match(
    out.stdout,
    /VERIFIED/,
    "demo must print 'VERIFIED' on the happy path",
  );

  // Section header asserts three receipts were emitted. Mirrors the
  // line in bin/demo.mjs — if that count format ever changes, this
  // assertion is the canary.
  assert.match(
    out.stdout,
    /Three Ed25519-signed receipts emitted \(3\)/,
    "demo must emit exactly three signed receipts",
  );

  // All three policy outcomes must show up in the call-summary section.
  // The read path and the auto-approved merge both surface as ALLOW;
  // the out-of-pack delete surfaces as DENY.
  const allowCount = (out.stdout.match(/ALLOW/g) || []).length;
  assert.ok(
    allowCount >= 2,
    `expected ≥2 ALLOW lines, got ${allowCount}\n${out.stdout}`,
  );
  assert.match(out.stdout, /DENY/, "demo must surface a DENY outcome");

  // Chain-validity + signature-count lines are the audit-grade summary.
  assert.match(out.stdout, /chain valid\s+yes/);
  assert.match(out.stdout, /signatures\s+3\/3 VERIFIED/);

  // The demo MUST print the literal verifier command, with paths that
  // exist on disk. The pre-fix demo printed `./receipts.jsonl` even
  // though the file never existed (MemoryStorage); every first-time
  // user hit ENOENT when they pasted the command. The fix wires
  // `storagePath` to a temp dir and writes the JWKS alongside.
  const cmdMatch = out.stdout.match(
    /npx @strixgov\/verifier chain (\S+) --jwks (\S+)/,
  );
  assert.ok(
    cmdMatch,
    `demo must print a literal 'verifier chain <path> --jwks <path>' command. stdout:\n${out.stdout}`,
  );
  const [, receiptsPath, jwksPath] = cmdMatch;

  assert.ok(
    fs.existsSync(receiptsPath),
    `receipts file printed by the demo must exist on disk: ${receiptsPath}`,
  );
  assert.ok(
    fs.existsSync(jwksPath),
    `jwks file printed by the demo must exist on disk: ${jwksPath}`,
  );

  // The JSONL file must carry exactly one line per emitted receipt.
  const lines = fs
    .readFileSync(receiptsPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  assert.equal(
    lines.length,
    3,
    `expected 3 JSONL receipt lines in ${receiptsPath}, got ${lines.length}`,
  );

  // The JWKS must contain at least one key with the demo's kid.
  const jwks = JSON.parse(fs.readFileSync(jwksPath, "utf8"));
  assert.ok(Array.isArray(jwks.keys) && jwks.keys.length >= 1);
  assert.ok(
    jwks.keys.some((k) => k.kid === "strix-demo-github"),
    `JWKS must include the demo signing key (kid=strix-demo-github)`,
  );
});

test("`demo` is the default subcommand (no-arg invocation runs the demo)", { timeout: 30_000 }, () => {
  const out = runCli([]);
  assert.equal(out.status, 0, `no-arg demo exited ${out.status}`);
  assert.match(out.stdout, /VERIFIED/);
});

test("`help` prints usage and exits 0", () => {
  for (const flag of ["help", "--help", "-h"]) {
    const out = runCli([flag]);
    assert.equal(out.status, 0, `${flag} exited ${out.status}`);
    assert.match(out.stdout, /Usage:/);
    assert.match(out.stdout, /npx @strixgov\/mcp-adapter demo/);
  }
});

test("unknown subcommand exits 2 with a hint", () => {
  const out = runCli(["not-a-real-command"]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /Unknown subcommand/);
  assert.match(out.stderr, /demo/);
});
