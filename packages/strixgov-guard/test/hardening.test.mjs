/**
 * Hardening pins from the 0.1.3 review. Each test fails against the 0.1.3
 * behaviour it replaces. Synthetic configs only; nothing is launched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInit, packForServer, isAlreadyWrapped, PROXY_VERSION } from "../src/init.mjs";
import { auditCoverage } from "../src/coverage.mjs";
import { guardPaths } from "../src/paths.mjs";

async function dirs() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strix-guard-hard-"));
  return { dir, home: path.join(dir, "home"), env: { STRIX_GUARD_HOME: path.join(dir, "home") } };
}

test("a server that merely mentions the proxy name is not 'already wrapped'", () => {
  assert.equal(isAlreadyWrapped({ command: "node", args: ["s.js", "--note", "@strixgov/mcp-proxy"] }), false);
  assert.equal(isAlreadyWrapped({ command: "node", args: ["/x/@strixgov/mcp-proxy/real.js"] }), false);
  assert.equal(isAlreadyWrapped({ command: "node", args: ["@strixgov/mcp-proxy-evil", "--config", "c"] }), false);
  assert.equal(isAlreadyWrapped({ command: "npx", args: ["@strixgov/mcp-proxy", "--config"] }), false, "--config needs a value");
});

test("genuine wrapped entries are still recognised, pinned or not", () => {
  assert.equal(isAlreadyWrapped({ command: "npx", args: ["-y", `@strixgov/mcp-proxy@${PROXY_VERSION}`, "--config", "/h/s.json"] }), true);
  assert.equal(isAlreadyWrapped({ command: "npx", args: ["-y", "@strixgov/mcp-proxy", "--config", "/h/s.json"] }), true, "entries written by older Guard");
  assert.equal(isAlreadyWrapped({ command: "strix-mcp-proxy", args: ["--config", "c"] }), true);
});

test("init wraps (does not skip) a direct server whose argument mentions the proxy", async () => {
  const { dir, env } = await dirs();
  const cfg = path.join(dir, ".mcp.json");
  await fs.writeFile(cfg, JSON.stringify({ mcpServers: { spoof: { command: "node", args: ["s.js", "--note", "@strixgov/mcp-proxy"] } } }));
  const r = await runInit({ unsignedApprovals: true, config: cfg, env, log: () => {} });
  assert.equal(r.wrapped, 1);
  assert.equal(r.plan[0].action, "wrap");
});

test("the audit reports a spoofed entry as DIRECT, not PROXIED", async () => {
  const { dir } = await dirs();
  const cfg = path.join(dir, ".mcp.json");
  await fs.writeFile(cfg, JSON.stringify({ mcpServers: { spoof: { command: "node", args: ["s.js", "--note", "@strixgov/mcp-proxy"] } } }));
  const r = await auditCoverage({ configs: [{ path: cfg, kind: "explicit" }] });
  assert.equal(r.entries[0].route, "DIRECT");
  assert.equal(r.status, "COVERAGE_INCOMPLETE");
});

test("an entry that launches the proxy but names no readable proxy config is not established", async () => {
  const { dir } = await dirs();
  const cfg = path.join(dir, ".mcp.json");
  await fs.writeFile(cfg, JSON.stringify({ mcpServers: { ghost: { command: "npx", args: ["-y", "@strixgov/mcp-proxy", "--config", path.join(dir, "missing.json")] } } }));
  const r = await auditCoverage({ configs: [{ path: cfg, kind: "explicit" }] });
  assert.equal(r.entries[0].route, "UNKNOWN");
  assert.ok(r.findings.some((f) => f.code === "ROUTE_NOT_ESTABLISHED" && f.serverId === "ghost"));
  assert.notEqual(r.status, "COVERAGE_ESTABLISHED_FOR_KNOWN_CONFIGS");
});

test("words inside a file path do not select a capability pack", () => {
  assert.equal(packForServer("custom", { command: "node", args: ["/opt/github-mirror/server.js"] }), null);
  assert.equal(packForServer("custom", { command: "node", args: ["C:\\tools\\slack-export\\run.js"] }), null);
});

test("a real package specifier still selects its pack", () => {
  assert.equal(packForServer("t", { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }), "@strixgov/capabilities-mcp-common/github");
  assert.equal(packForServer("t", { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] }), "@strixgov/capabilities-mcp-common/notion");
});

test("the backup is private, in the guard home, and not left beside the config", async () => {
  const { dir, home, env } = await dirs();
  const projectDir = path.join(dir, "project");
  await fs.mkdir(projectDir);
  const cfg = path.join(projectDir, ".mcp.json");
  await fs.writeFile(cfg, JSON.stringify({ mcpServers: { db: { command: "node", args: ["db.js"], env: { DB_PASSWORD: "synthetic-secret-123" } } } }));
  await runInit({ unsignedApprovals: true, config: cfg, env, log: () => {} });
  const beside = (await fs.readdir(projectDir)).filter((f) => f.includes(".bak-strix-guard-"));
  assert.deepEqual(beside, [], "no backup beside the project config");
  const { backupsDir } = guardPaths(home);
  const [name] = await fs.readdir(backupsDir);
  assert.ok(name, "backup in the guard home");
  assert.ok((await fs.readFile(path.join(backupsDir, name), "utf8")).includes("synthetic-secret-123"), "backup is the original");
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(backupsDir, name))).mode & 0o777, 0o600);
  }
});

test("generated entries pin the proxy version", async () => {
  const { dir, env } = await dirs();
  const cfg = path.join(dir, ".mcp.json");
  await fs.writeFile(cfg, JSON.stringify({ mcpServers: { a: { command: "node", args: ["a.js"] } } }));
  await runInit({ unsignedApprovals: true, config: cfg, env, log: () => {} });
  const args = JSON.parse(await fs.readFile(cfg, "utf8")).mcpServers.a.args;
  assert.ok(args.includes(`@strixgov/mcp-proxy@${PROXY_VERSION}`), JSON.stringify(args));
  assert.ok(!args.includes("@strixgov/mcp-proxy"), "no unpinned spec");
});

test("PROXY_VERSION matches the proxy in this repository (checked when both are present)", { skip: !existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../strixgov-mcp-proxy/package.json")) && "proxy package not alongside (installed copy)" }, () => {
  const proxy = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../strixgov-mcp-proxy/package.json"), "utf8"));
  assert.equal(PROXY_VERSION, proxy.version, "raise PROXY_VERSION deliberately when the proxy is released and tested with Guard");
});

test("init --unsigned-approvals tells the operator that approvals are not authenticated", async () => {
  const { dir, home, env } = await dirs();
  const cfg = path.join(dir, ".mcp.json");
  await fs.writeFile(cfg, JSON.stringify({ mcpServers: { a: { command: "node", args: ["a.js"] } } }));
  const lines = [];
  await runInit({ unsignedApprovals: true, config: cfg, env, log: (l) => lines.push(l) });
  const text = lines.join("\n");
  assert.match(text, /WARNING: unsigned approvals/);
  assert.match(text, /Any process running as your OS user/);
  assert.ok(text.includes(guardPaths(home).approvalsDir));
});
