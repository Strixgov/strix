/**
 * fileApprover — first-class headless / CI primitive.
 *
 * Round-trips: agent writes request → "operator" writes response →
 * approver returns the result. Tests cover happy path (approve / deny),
 * timeout, malformed response, and request/response cleanup.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileApprover } from "../src/approval.mjs";

const cap = {
  id: "filesystem.write",
  name: "filesystem.write",
  risk: "HIGH",
  mode: "WRITE",
};
const inv = {
  capabilityId: "filesystem.write",
  action: "fs.writeFile",
  args: { path: "/tmp/x" },
  actorId: "agent-claude",
};

async function freshDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "strix-fileapprover-"));
}

test("fileApprover happy path — operator approves", async () => {
  const dir = await freshDir();
  const approve = fileApprover({
    requestDir: dir,
    timeoutMs: 5_000,
    pollIntervalMs: 25,
    onRequestWritten: async (reqPath, requestId) => {
      // Out-of-band operator writes a response after seeing the request.
      const respPath = path.join(dir, `${requestId}.response.json`);
      await fs.writeFile(
        respPath,
        JSON.stringify({ approved: true, approvedBy: "alice" }),
      );
    },
  });
  const result = await approve(cap, inv);
  assert.equal(result.approved, true);
  assert.equal(result.reason, "USER_APPROVED");
  assert.equal(result.approvedBy, "alice");

  // Both files must be cleaned up on a clean return.
  const files = await fs.readdir(dir);
  assert.deepEqual(files, []);
  await fs.rm(dir, { recursive: true });
});

test("fileApprover happy path — operator denies", async () => {
  const dir = await freshDir();
  const approve = fileApprover({
    requestDir: dir,
    timeoutMs: 5_000,
    pollIntervalMs: 25,
    onRequestWritten: async (_reqPath, requestId) => {
      const respPath = path.join(dir, `${requestId}.response.json`);
      await fs.writeFile(
        respPath,
        JSON.stringify({ approved: false, reason: "policy violation" }),
      );
    },
  });
  const result = await approve(cap, inv);
  assert.equal(result.approved, false);
  assert.equal(result.reason, "USER_DENIED");
  await fs.rm(dir, { recursive: true });
});

test("fileApprover times out → fail-closed DENY", async () => {
  const dir = await freshDir();
  const approve = fileApprover({
    requestDir: dir,
    timeoutMs: 200,
    pollIntervalMs: 50,
    // no onRequestWritten — nobody answers
  });
  const result = await approve(cap, inv);
  assert.equal(result.approved, false);
  assert.equal(result.reason, "TIMEOUT");
  // Request file is cleaned up even on timeout.
  const files = await fs.readdir(dir);
  assert.deepEqual(files, []);
  await fs.rm(dir, { recursive: true });
});

test("fileApprover treats malformed JSON response as PROMPT_FAILED", async () => {
  const dir = await freshDir();
  const approve = fileApprover({
    requestDir: dir,
    timeoutMs: 5_000,
    pollIntervalMs: 25,
    onRequestWritten: async (_reqPath, requestId) => {
      const respPath = path.join(dir, `${requestId}.response.json`);
      await fs.writeFile(respPath, "not-json{{{");
    },
  });
  const result = await approve(cap, inv);
  assert.equal(result.approved, false);
  assert.equal(result.reason, "PROMPT_FAILED");
  await fs.rm(dir, { recursive: true });
});

test("fileApprover treats `approved` of any non-true value as DENY (default-deny)", async () => {
  const dir = await freshDir();
  const approve = fileApprover({
    requestDir: dir,
    timeoutMs: 5_000,
    pollIntervalMs: 25,
    onRequestWritten: async (_reqPath, requestId) => {
      const respPath = path.join(dir, `${requestId}.response.json`);
      // truthy but not strictly true
      await fs.writeFile(respPath, JSON.stringify({ approved: "yes" }));
    },
  });
  const result = await approve(cap, inv);
  assert.equal(result.approved, false);
  assert.equal(result.reason, "USER_DENIED");
  await fs.rm(dir, { recursive: true });
});

test("fileApprover writes a request file with the capability + invocation visible to operators", async () => {
  const dir = await freshDir();
  /** @type {object|null} */
  let captured = null;
  const approve = fileApprover({
    requestDir: dir,
    timeoutMs: 5_000,
    pollIntervalMs: 25,
    onRequestWritten: async (reqPath, requestId) => {
      const raw = await fs.readFile(reqPath, "utf8");
      captured = JSON.parse(raw);
      const respPath = path.join(dir, `${requestId}.response.json`);
      await fs.writeFile(respPath, JSON.stringify({ approved: true }));
    },
  });
  await approve(cap, inv);
  assert.ok(captured);
  assert.equal(captured.capability.id, "filesystem.write");
  assert.equal(captured.capability.risk, "HIGH");
  assert.equal(captured.invocation.action, "fs.writeFile");
  assert.equal(captured.invocation.actorId, "agent-claude");
  assert.deepEqual(captured.invocation.args, { path: "/tmp/x" });
  assert.match(captured.requestId, /^[0-9a-f]{32}$/);
  await fs.rm(dir, { recursive: true });
});
