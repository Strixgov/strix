/**
 * CLI sanity tests.
 *
 * Doesn't run the full MCP loop (covered by proxy-end-to-end), just
 * confirms the CLI parses args correctly, surfaces --help / --version,
 * and refuses to start without enough configuration.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "..", "bin", "strix-mcp-proxy.mjs");

function runCli(args, opts = {}) {
  return spawnSync("node", [BIN, ...args], { encoding: "utf8", timeout: 10_000, ...opts });
}

test("--help prints usage and exits 0", () => {
  const out = runCli(["--help"]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /strix-mcp-proxy/);
  assert.match(out.stdout, /CONFIG-FILE MODE/);
  assert.match(out.stdout, /FLAG MODE/);
});

test("--version prints the package version and exits 0", () => {
  const out = runCli(["--version"]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^strix-mcp-proxy \d+\.\d+\.\d+/);
});

test("no args: refuses to start with a clear error", () => {
  const out = runCli([], { input: "" });
  assert.notEqual(out.status, 0, "must exit non-zero without enough config");
  assert.match(out.stderr, /missing --config or --upstream-command/);
});

test("missing --config file: clear error", () => {
  const out = runCli(["--config", "/nonexistent/strix-proxy-cli-test.json"], { input: "" });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /could not read/);
});
