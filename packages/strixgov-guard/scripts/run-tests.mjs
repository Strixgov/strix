#!/usr/bin/env node
/**
 * `npm test` entry point for @strixgov/guard, in a source checkout or an
 * installed copy. Runs the files explicitly (no shell glob, so it works on
 * Windows) and fails closed: no test files, an unreadable summary, zero tests,
 * or fewer than MIN_TESTS exits non-zero. Node counts an empty test file as one
 * passing test, so "more than zero" is not enough.
 */
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const testDir = fileURLToPath(new URL("../test", import.meta.url));
const MIN_TESTS = 45; // 54 at 0.2.0

const fail = (msg) => {
  process.stderr.write(`\n  @strixgov/guard: ${msg}\n\n`);
  process.exit(1);
};

const files = existsSync(testDir) ? readdirSync(testDir).filter((f) => f.endsWith(".test.mjs")) : [];
if (files.length === 0) fail("no test files found; zero tests run must not read as a pass.");

const run = spawnSync(process.execPath, ["--test", ...files.map((f) => `test/${f}`)], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
if (tests < MIN_TESTS || passed === 0) fail(`test runner executed ${tests} tests (${passed} passed); expected at least ${MIN_TESTS}.`);
