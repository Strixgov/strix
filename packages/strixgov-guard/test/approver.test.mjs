/**
 * Signed approvals: the Guard side. Synthetic only; the terminal is injected.
 * The proxy-side verifier is the real tool-gateway fileApprover when the
 * monorepo is present (skipped in an installed copy).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createApproverKey, readApproverPublic, loadApproverPrivateKey, approveSigned, approverPaths,
  approvalPreimage, describeRequest, sha256Hex, MIN_PASSPHRASE_LENGTH,
} from "../src/approver.mjs";
import { runInit } from "../src/init.mjs";
import { auditCoverage } from "../src/coverage.mjs";
import { guardPaths } from "../src/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const gwPath = path.resolve(here, "../../tool-gateway/src/approval.mjs");
const haveGateway = existsSync(gwPath);
const PASS = "correct horse battery staple";

async function env() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strix-guard-appr-"));
  const home = path.join(dir, "home");
  await fs.mkdir(path.join(home, "approvals"), { recursive: true });
  return { dir, home, env: { STRIX_GUARD_HOME: home } };
}
const io = ({ tty = true, yes = true, pass = PASS } = {}) => ({ isTty: tty, print: () => {}, confirm: async () => yes, secret: async () => pass });
const cap = { id: "filesystem.write", name: "write_file", risk: "HIGH", mode: "WRITE" };
const inv = { capabilityId: "filesystem.write", action: "write_file", args: { path: "/synthetic/x" }, actorId: "agent" };

async function waitRequest(dir) {
  for (let i = 0; i < 200; i++) {
    const f = (await fs.readdir(dir)).find((n) => n.endsWith(".request.json"));
    if (f) return f.replace(".request.json", "");
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no request");
}

test("approver key: short passphrases refused; the key file holds no plaintext key; no silent overwrite", async () => {
  const e = await env();
  await assert.rejects(() => createApproverKey({ passphrase: "short", env: e.env }), new RegExp(`${MIN_PASSPHRASE_LENGTH}`));
  const pub = await createApproverKey({ passphrase: PASS, label: "alice", env: e.env });
  const p = approverPaths(e.env);
  const text = await fs.readFile(p.keyPath, "utf8");
  assert.ok(!text.includes("PRIVATE") && !text.includes(PASS));
  if (process.platform !== "win32") assert.equal((await fs.stat(p.keyPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readApproverPublic(e.env), pub);
  await assert.rejects(() => createApproverKey({ passphrase: PASS, env: e.env }), /already exists/);
});

test("approver key: only the right passphrase decrypts it", async () => {
  const e = await env();
  await createApproverKey({ passphrase: PASS, env: e.env });
  assert.ok(await loadApproverPrivateKey({ passphrase: PASS, env: e.env }));
  await assert.rejects(() => loadApproverPrivateKey({ passphrase: "wrong passphrase here", env: e.env }), /wrong passphrase/);
});

test("approveSigned refuses without a terminal, without a yes, or with the wrong passphrase, and writes nothing", async () => {
  const e = await env();
  await createApproverKey({ passphrase: PASS, env: e.env });
  const id = "a".repeat(32);
  const approvals = guardPaths(e.home).approvalsDir;
  await fs.writeFile(path.join(approvals, `${id}.request.json`), JSON.stringify({ requestedAt: "t", capability: cap, invocation: inv }));
  const respFile = path.join(approvals, `${id}.response.json`);
  await assert.rejects(() => approveSigned(id, { io: io({ tty: false }), env: e.env }), /interactive terminal/);
  await assert.rejects(() => approveSigned(id, { io: io({ yes: false }), env: e.env }), /not approved/);
  await assert.rejects(() => approveSigned(id, { io: io({ pass: "wrong passphrase here" }), env: e.env }), /wrong passphrase/);
  assert.equal(existsSync(respFile), false, "no response file on any refusal");
});

test("approveSigned refuses a request it cannot display", async () => {
  const e = await env();
  await createApproverKey({ passphrase: PASS, env: e.env });
  const id = "b".repeat(32);
  await fs.writeFile(path.join(guardPaths(e.home).approvalsDir, `${id}.request.json`), "{not json");
  await assert.rejects(() => approveSigned(id, { io: io(), env: e.env }), /cannot display/);
  assert.equal(describeRequest("{not json").ok, false);
});

test("the real gateway approver accepts a response signed by Guard, and the identity is the key's label", { skip: !haveGateway && "tool-gateway not alongside (installed copy)" }, async () => {
  const { fileApprover } = await import(gwPath);
  const e = await env();
  const pub = await createApproverKey({ passphrase: PASS, label: "alice", env: e.env });
  const approvals = guardPaths(e.home).approvalsDir;
  const prompt = fileApprover({ requestDir: approvals, timeoutMs: 5000, pollIntervalMs: 20, requireSignedResponse: true, approverKeys: [{ publicKey: pub.publicKey, kid: pub.kid, label: pub.label }] });
  const pending = prompt(cap, inv);
  const id = await waitRequest(approvals);
  await approveSigned(id, { io: io(), env: e.env });
  const r = await pending;
  assert.equal(r.approved, true);
  assert.equal(r.approvedBy, `alice [key ${pub.kid.slice(0, 8)}]`);
});

test("the agent swapping the request file's content after the proxy wrote it makes the approval fail", { skip: !haveGateway && "tool-gateway not alongside (installed copy)" }, async () => {
  const { fileApprover } = await import(gwPath);
  const e = await env();
  const pub = await createApproverKey({ passphrase: PASS, env: e.env });
  const approvals = guardPaths(e.home).approvalsDir;
  const prompt = fileApprover({ requestDir: approvals, timeoutMs: 5000, pollIntervalMs: 20, requireSignedResponse: true, approverKeys: [{ publicKey: pub.publicKey, label: "alice" }] });
  const pending = prompt(cap, inv);
  const id = await waitRequest(approvals);
  // The agent rewrites the request so the human sees benign arguments.
  await fs.writeFile(path.join(approvals, `${id}.request.json`), JSON.stringify({ requestedAt: "t", capability: cap, invocation: { ...inv, args: { path: "/synthetic/harmless" } } }));
  await approveSigned(id, { io: io(), env: e.env });
  assert.deepEqual(await pending, { approved: false, reason: "APPROVAL_SIGNATURE_INVALID" });
});

test("Guard's signing preimage is byte-identical to the gateway's", { skip: !haveGateway && "tool-gateway not alongside (installed copy)" }, async () => {
  const gw = await import(path.resolve(here, "../../tool-gateway/src/approval-signing.mjs"));
  const args = { requestId: "c".repeat(32), requestSha256: sha256Hex("x"), approved: true, decidedAt: "2026-11-07T00:00:00.000Z", kid: "0123456789abcdef" };
  assert.equal(approvalPreimage(args), gw.approvalPreimage(args));
});

test("init --signed-approvals needs an approver key, then makes every proxy config require signatures", async () => {
  const e = await env();
  const cfg = path.join(e.dir, ".mcp.json");
  await fs.writeFile(cfg, JSON.stringify({ mcpServers: { a: { command: "node", args: ["a.js"] } } }));
  await assert.rejects(() => runInit({ config: cfg, env: e.env, signedApprovals: true, log: () => {} }), /approver init/);
  const pub = await createApproverKey({ passphrase: PASS, label: "alice", env: e.env });
  await runInit({ config: cfg, env: e.env, signedApprovals: true, log: () => {} });
  const proxyCfg = JSON.parse(await fs.readFile(path.join(guardPaths(e.home).serversDir, "a.json"), "utf8"));
  assert.equal(proxyCfg.approval.requireSignedResponse, true);
  assert.deepEqual(proxyCfg.approval.approverKeys, [{ publicKey: pub.publicKey, kid: pub.kid, label: "alice" }]);
});

test("init --signed-approvals upgrades servers wrapped earlier without it, and the audit reports which are signed", async () => {
  const e = await env();
  const cfg = path.join(e.dir, ".mcp.json");
  await fs.writeFile(cfg, JSON.stringify({ mcpServers: { old: { command: "node", args: ["old.js"] } } }));
  await runInit({ config: cfg, env: e.env, unsignedApprovals: true, log: () => {} });
  let r = await auditCoverage({ configs: [{ path: cfg, kind: "explicit" }] });
  assert.equal(r.entries[0].approvals, "UNAUTHENTICATED_FILE");
  await createApproverKey({ passphrase: PASS, env: e.env });
  await runInit({ config: cfg, env: e.env, signedApprovals: true, log: () => {} });
  r = await auditCoverage({ configs: [{ path: cfg, kind: "explicit" }] });
  assert.equal(r.entries[0].approvals, "SIGNED");
});
