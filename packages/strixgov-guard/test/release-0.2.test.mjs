// 0.2.0 behaviour: signed approvals by default, the Windows launch entry, and uninstall.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInit, proxyLaunchEntry, isAlreadyWrapped, resolveApprovalMode, PROXY_VERSION } from "../src/init.mjs";
import { runUninstall } from "../src/uninstall.mjs";
import { createApproverKey } from "../src/approver.mjs";
import { guardPaths } from "../src/paths.mjs";
import { auditCoverage } from "../src/coverage.mjs";

const PASS = "correct horse battery staple";

async function env() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "guard-02-"));
  const home = path.join(dir, "home");
  return { dir, home, env: { ...process.env, STRIX_GUARD_HOME: home } };
}
async function config(dir, servers) {
  const p = path.join(dir, ".mcp.json");
  await fs.writeFile(p, JSON.stringify({ mcpServers: servers, otherSetting: { keep: true } }, null, 2));
  return p;
}

test("signed approvals are the default: init with no approver key refuses and writes nothing", async () => {
  const e = await env();
  const cfg = await config(e.dir, { a: { command: "node", args: ["a.js"] } });
  const before = await fs.readFile(cfg, "utf8");
  await assert.rejects(() => runInit({ config: cfg, env: e.env, log: () => {} }), /signed approvals are the default[\s\S]*approver init[\s\S]*--unsigned-approvals/);
  assert.equal(await fs.readFile(cfg, "utf8"), before, "client config untouched");
  await assert.rejects(fs.access(guardPaths(e.home).serversDir), "no proxy configs written");
});

test("default init with an approver key requires signatures without any flag", async () => {
  const e = await env();
  const cfg = await config(e.dir, { a: { command: "node", args: ["a.js"] } });
  const pub = await createApproverKey({ passphrase: PASS, label: "alice", env: e.env });
  const r = await runInit({ config: cfg, env: e.env, log: () => {}, auditConfigs: [] });
  assert.equal(r.approvals, "signed");
  const proxyCfg = JSON.parse(await fs.readFile(path.join(guardPaths(e.home).serversDir, "a.json"), "utf8"));
  assert.equal(proxyCfg.approval.requireSignedResponse, true);
  assert.equal(proxyCfg.approval.approverKeys[0].kid, pub.kid);
  const audit = await auditCoverage({ configs: [{ path: cfg, kind: "explicit" }] });
  assert.equal(audit.entries[0].approvals, "SIGNED");
});

test("createApprover is called when signed mode has no key, and its key is used", async () => {
  const e = await env();
  const cfg = await config(e.dir, { a: { command: "node", args: ["a.js"] } });
  let calls = 0;
  const createApprover = async () => { calls++; return createApproverKey({ passphrase: PASS, label: "bob", env: e.env }); };
  await runInit({ config: cfg, env: e.env, createApprover, log: () => {}, auditConfigs: [] });
  assert.equal(calls, 1);
  const proxyCfg = JSON.parse(await fs.readFile(path.join(guardPaths(e.home).serversDir, "a.json"), "utf8"));
  assert.equal(proxyCfg.approval.approverKeys[0].label, "bob");
});

test("--unsigned-approvals is an explicit opt-out and says so", async () => {
  const e = await env();
  const cfg = await config(e.dir, { a: { command: "node", args: ["a.js"] } });
  const lines = [];
  const r = await runInit({ config: cfg, env: e.env, unsignedApprovals: true, log: (l) => lines.push(l), auditConfigs: [] });
  assert.equal(r.approvals, "unsigned");
  const proxyCfg = JSON.parse(await fs.readFile(path.join(guardPaths(e.home).serversDir, "a.json"), "utf8"));
  assert.notEqual(proxyCfg.approval.requireSignedResponse, true);
  assert.ok(lines.some((l) => /^WARNING: unsigned approvals/.test(l)), lines.join("\n"));
});

test("both flags together are refused; dry run needs no key", async () => {
  assert.throws(() => resolveApprovalMode({ signedApprovals: true, unsignedApprovals: true }), /cannot both be set/);
  assert.equal(resolveApprovalMode({}), "signed");
  assert.equal(resolveApprovalMode({ signedApprovals: true }), "signed");
  const e = await env();
  const cfg = await config(e.dir, { a: { command: "node", args: ["a.js"] } });
  const r = await runInit({ config: cfg, env: e.env, dryRun: true, log: () => {} });
  assert.equal(r.dryRun, true);
  assert.equal(r.approvals, "signed");
});

test("Windows launch entry goes through cmd /c and is recognised as wrapped", () => {
  const w = proxyLaunchEntry("C:\\Users\\u\\.strix-guard\\servers\\a.json", "win32");
  assert.deepEqual(w, { command: "cmd", args: ["/c", "npx", "-y", `@strixgov/mcp-proxy@${PROXY_VERSION}`, "--config", "C:\\Users\\u\\.strix-guard\\servers\\a.json"] });
  assert.equal(isAlreadyWrapped(w), true);
  const p = proxyLaunchEntry("/h/s/a.json", "linux");
  assert.equal(p.command, "npx");
  assert.equal(isAlreadyWrapped(p), true);
});

test("init on win32 writes the cmd /c entry, and the coverage audit counts it as proxied", async () => {
  const e = await env();
  const cfg = await config(e.dir, { a: { command: "node", args: ["a.js"] } });
  await runInit({ config: cfg, env: e.env, unsignedApprovals: true, platform: "win32", log: () => {}, auditConfigs: [] });
  const entry = JSON.parse(await fs.readFile(cfg, "utf8")).mcpServers.a;
  assert.equal(entry.command, "cmd");
  assert.deepEqual(entry.args.slice(0, 3), ["/c", "npx", "-y"]);
  const audit = await auditCoverage({ configs: [{ path: cfg, kind: "explicit" }] });
  assert.equal(audit.entries[0].route, "PROXIED", JSON.stringify(audit.entries[0]));
});

test("uninstall restores each wrapped server from its proxy config and keeps everything else", async () => {
  const e = await env();
  const original = { db: { command: "node", args: ["db.js"], env: { TOKEN: "synthetic" } }, other: { command: "python", args: ["x.py"] } };
  const cfg = await config(e.dir, original);
  await runInit({ config: cfg, env: e.env, unsignedApprovals: true, log: () => {}, auditConfigs: [] });
  // An edit made after init must survive uninstall.
  const wrapped = JSON.parse(await fs.readFile(cfg, "utf8"));
  wrapped.mcpServers.added = { command: "node", args: ["new.js"] };
  await fs.writeFile(cfg, JSON.stringify(wrapped));
  const r = await runUninstall({ config: cfg, env: e.env, log: () => {} });
  assert.equal(r.restored, 2);
  const after = JSON.parse(await fs.readFile(cfg, "utf8"));
  assert.deepEqual(after.mcpServers.db, original.db);
  assert.deepEqual(after.mcpServers.other, original.other);
  assert.deepEqual(after.mcpServers.added, { command: "node", args: ["new.js"] });
  assert.deepEqual(after.otherSetting, { keep: true });
  const backups = await fs.readdir(guardPaths(e.home).backupsDir);
  assert.ok(backups.some((b) => b.includes("bak-strix-guard-uninstall")), backups.join(","));
  await fs.access(guardPaths(e.home).receiptsDir); // guard home kept
});

test("uninstall leaves proxy entries it does not own, and reports a missing proxy config instead of guessing", async () => {
  const e = await env();
  const cfg = await config(e.dir, { a: { command: "node", args: ["a.js"] } });
  await runInit({ config: cfg, env: e.env, unsignedApprovals: true, log: () => {}, auditConfigs: [] });
  const c = JSON.parse(await fs.readFile(cfg, "utf8"));
  c.mcpServers.foreign = { command: "npx", args: ["-y", "@strixgov/mcp-proxy", "--config", path.join(e.dir, "elsewhere.json")] };
  await fs.writeFile(cfg, JSON.stringify(c));
  await fs.rm(path.join(guardPaths(e.home).serversDir, "a.json"));
  const before = await fs.readFile(cfg, "utf8");
  const r = await runUninstall({ config: cfg, env: e.env, log: () => {} });
  assert.equal(r.restored, 0);
  assert.deepEqual(r.plan.map((p) => [p.serverId, p.action]).sort(), [["a", "skip"], ["foreign", "skip"]]);
  assert.equal(await fs.readFile(cfg, "utf8"), before, "nothing rewritten when nothing restores");
});

test("uninstall dry run changes nothing", async () => {
  const e = await env();
  const cfg = await config(e.dir, { a: { command: "node", args: ["a.js"] } });
  await runInit({ config: cfg, env: e.env, unsignedApprovals: true, log: () => {}, auditConfigs: [] });
  const before = await fs.readFile(cfg, "utf8");
  const r = await runUninstall({ config: cfg, env: e.env, dryRun: true, log: () => {} });
  assert.equal(r.restored, 0);
  assert.equal(r.plan[0].action, "restore");
  assert.equal(await fs.readFile(cfg, "utf8"), before);
});

test("re-running init re-points entries an older Guard wrote at the new pinned proxy, keeping their proxy config", async () => {
  const e = await env();
  const cfg = await config(e.dir, { a: { command: "node", args: ["a.js"] } });
  await runInit({ config: cfg, env: e.env, unsignedApprovals: true, log: () => {}, auditConfigs: [] });
  const proxyCfgPath = path.join(guardPaths(e.home).serversDir, "a.json");
  const proxyCfgBefore = await fs.readFile(proxyCfgPath, "utf8");
  // Simulate an entry written by Guard 0.1.4, which pinned proxy 0.2.3.
  const c = JSON.parse(await fs.readFile(cfg, "utf8"));
  c.mcpServers.a = { command: "npx", args: ["-y", "@strixgov/mcp-proxy@0.2.3", "--config", proxyCfgPath] };
  c.mcpServers.foreign = { command: "npx", args: ["-y", "@strixgov/mcp-proxy@0.1.0", "--config", path.join(e.dir, "theirs.json")] };
  await fs.writeFile(cfg, JSON.stringify(c));
  const r = await runInit({ config: cfg, env: e.env, unsignedApprovals: true, log: () => {}, auditConfigs: [] });
  assert.equal(r.upgraded, 1);
  const after = JSON.parse(await fs.readFile(cfg, "utf8")).mcpServers;
  assert.deepEqual(after.a.args, ["-y", `@strixgov/mcp-proxy@${PROXY_VERSION}`, "--config", proxyCfgPath]);
  assert.deepEqual(after.foreign, c.mcpServers.foreign, "an entry pointing outside the Guard home is not changed");
  assert.equal(await fs.readFile(proxyCfgPath, "utf8"), proxyCfgBefore, "proxy config untouched");
  const again = await runInit({ config: cfg, env: e.env, unsignedApprovals: true, log: () => {}, auditConfigs: [] });
  assert.equal(again.upgraded, 0, "idempotent");
});
