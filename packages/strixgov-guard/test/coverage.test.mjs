/**
 * Guard Coverage Audit — governed vs direct routes, synthetic configs only.
 * Nothing here executes an MCP server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditCoverage } from "../src/coverage.mjs";
import { runInit } from "../src/init.mjs";

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strix-guard-cov-"));
  const fsServer = { command: "node", args: ["./fake-fs-server.js"] };
  const a = path.join(dir, "a.json");
  const b = path.join(dir, "b.json");
  await fs.writeFile(a, JSON.stringify({ mcpServers: { files: fsServer } }));
  await fs.writeFile(b, JSON.stringify({ mcpServers: { files: fsServer } }));
  return { dir, a, b, env: { STRIX_GUARD_HOME: path.join(dir, "home") } };
}
const cfgs = (...ps) => ps.map((p) => ({ path: p, kind: "explicit" }));

test("init wraps one config, leaves sibling direct entry unchanged, and warns", async () => {
  const { a, b, env } = await setup();
  const before = await fs.readFile(b, "utf8");
  const lines = [];
  const r = await runInit({ unsignedApprovals: true, config: a, env, log: (l) => lines.push(l), auditConfigs: cfgs(a, b) });
  assert.equal(await fs.readFile(b, "utf8"), before, "sibling config must not be modified");
  assert.equal(r.coverage.status, "COVERAGE_INCOMPLETE");
  const f = r.coverage.findings.find((x) => x.code === "DIRECT_ROUTE_PRESENT");
  assert.equal(f.configPath, b);
  assert.equal(f.alsoProxiedIn[0], a);
  assert.match(lines.join("\n"), /WARNING: coverage incomplete/);
  assert.match(lines.join("\n"), new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const saved = JSON.parse(await fs.readFile(path.join(env.STRIX_GUARD_HOME, "coverage.json"), "utf8"));
  assert.equal(saved.status, "COVERAGE_INCOMPLETE");
});

test("all routes proxied: established for known configs, never 'complete'", async () => {
  const { a, b, env } = await setup();
  await runInit({ unsignedApprovals: true, config: a, env, log: () => {}, auditConfigs: cfgs(a) });
  await runInit({ unsignedApprovals: true, config: b, env, log: () => {}, auditConfigs: cfgs(a, b) });
  const r = await auditCoverage({ configs: cfgs(a, b) });
  assert.equal(r.status, "COVERAGE_ESTABLISHED_FOR_KNOWN_CONFIGS");
  assert.match(r.limits, /cannot prove no other execution path/);
  assert.doesNotMatch(JSON.stringify(r), /COMPLETE(?!_)|fully protected/);
});

test("unreadable or malformed config is NOT_ESTABLISHED, never covered", async () => {
  const { dir, a } = await setup();
  const bad = path.join(dir, "bad.json");
  await fs.writeFile(bad, "{not json");
  const r = await auditCoverage({ configs: cfgs(a, bad) });
  assert.equal(r.status, "COVERAGE_INCOMPLETE");
  assert.ok(r.findings.some((f) => f.code === "CONFIG_NOT_ESTABLISHED" && f.configPath === bad));
});

test("remote/command-less entry is ROUTE_NOT_ESTABLISHED", async () => {
  const { dir } = await setup();
  const p = path.join(dir, "remote.json");
  await fs.writeFile(p, JSON.stringify({ mcpServers: { r: { url: "https://x.invalid/mcp" } } }));
  const r = await auditCoverage({ configs: cfgs(p) });
  assert.ok(r.findings.some((f) => f.code === "ROUTE_NOT_ESTABLISHED"));
});

test("absent configs are skipped without error and audit is read-only", async () => {
  const { dir, a } = await setup();
  const before = await fs.readFile(a, "utf8");
  const r = await auditCoverage({ configs: cfgs(path.join(dir, "missing.json"), a) });
  assert.equal(r.configsChecked[0].status, "ABSENT");
  assert.equal(await fs.readFile(a, "utf8"), before);
});

// Regression: operator-supplied explicit configs outside the known locations
// (the independent sandbox layout — two explicit files in a temp dir).
test("explicit wrapped config + explicit sibling outside known locations: sibling is found only when named", async () => {
  const { a, b, env } = await setup();
  const lines = [];
  const r = await runInit({ unsignedApprovals: true, config: a, env, log: (l) => lines.push(l), auditExtra: [b], auditConfigs: [] });
  assert.equal(r.coverage.status, "COVERAGE_INCOMPLETE");
  const f = r.coverage.findings.find((x) => x.code === "DIRECT_ROUTE_PRESENT");
  assert.equal(f.configPath, b);
  assert.equal(f.alsoProxiedIn[0], a, "the wrapped config is audited as proxied");
  assert.match(lines.join("\n"), /WARNING: coverage incomplete/);
});

test("explicit config outside known locations and no sibling named: scope limited, never reassuring", async () => {
  const { a, env } = await setup();
  const lines = [];
  const r = await runInit({ unsignedApprovals: true, config: a, env, log: (l) => lines.push(l), auditConfigs: [] });
  assert.equal(r.coverage.status, "COVERAGE_SCOPE_LIMITED");
  assert.ok(r.coverage.findings.some((f) => f.code === "SIBLINGS_NOT_EXAMINED"));
  const out = lines.join("\n");
  assert.match(out, /NOT established/);
  assert.match(out, /--audit-config/);
  assert.doesNotMatch(out, /No direct routes found/);
});

test("wrapped config is audited even when it is the only config", async () => {
  const { a, env } = await setup();
  const r = await runInit({ unsignedApprovals: true, config: a, env, log: () => {}, auditExtra: [a], auditConfigs: [] });
  assert.equal(r.coverage.entries.filter((e) => e.configPath === a).length, 1, "deduplicated");
  assert.equal(r.coverage.entries[0].route, "PROXIED");
});

test("nothing readable is never 'established' (no vacuous clean)", async () => {
  const { dir } = await setup();
  const r = await auditCoverage({ configs: cfgs(path.join(dir, "nope.json")) });
  assert.equal(r.status, "COVERAGE_SCOPE_LIMITED");
});
