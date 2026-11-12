#!/usr/bin/env node
/**
 * `npm test` entry point for @strixgov/tool-gateway.
 *
 * Runs in a source checkout and in an installed copy of the published tarball.
 * The tarball ships the suites that need no sibling monorepo package; the
 * parity suites that import sibling sources stay in the repository only.
 *
 * Fails closed: zero test files, zero tests, an unreadable summary, or fewer
 * tests than MIN_TESTS exits non-zero. "No tests ran" must never read as a pass
 * (0.5.0 and 0.5.1 shipped no tests, so `npm test` exited 0 with 0 tests).
 */
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const testDir = fileURLToPath(new URL("../test", import.meta.url));
// Node counts an empty test file as one passing test, so "> 0" is not enough.
// The shipped suites hold 115 tests at 0.5.2.
const MIN_TESTS = 100;

const fail = (msg) => {
  process.stderr.write(`\n  @strixgov/tool-gateway: ${msg}\n\n`);
  process.exit(1);
};

const files = existsSync(testDir) ? readdirSync(testDir).filter((f) => f.endsWith(".test.mjs")).sort() : [];
if (files.length === 0) fail("no test files found in test/. Exiting non-zero: zero tests run must not read as a pass.");

const run = spawnSync(process.execPath, ["--test", ...files.map((f) => `test/${f}`)], {
  cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
if (run.status !== 0) process.exit(run.status ?? 1);

const text = `${run.stdout}\n${run.stderr}`;
const count = (label) => {
  const m = text.match(new RegExp(`(?:ℹ|#)\\s+${label}\\s+(\\d+)`));
  return m ? Number(m[1]) : null;
};
const tests = count("tests");
const passed = count("pass");
if (tests === null || passed === null) fail("could not read the test runner's summary; refusing to report success.");
if (tests === 0 || passed === 0) fail(`test runner executed ${tests} tests (${passed} passed). Exiting non-zero.`);
if (tests < MIN_TESTS) fail(`test runner executed only ${tests} tests; expected at least ${MIN_TESTS}. A truncated suite must not read as a pass.`);
