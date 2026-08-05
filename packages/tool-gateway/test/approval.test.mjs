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
import { PassThrough } from "node:stream";
import { fileApprover, terminalApprove } from "../src/approval.mjs";

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

// ─── terminalApprove: headless detection ─────────────────────────────────
//
// Regression pins for the guard that used to compare `isTTY === false`.
// Node marks a TTY with `isTTY === true` and leaves the property `undefined`
// on pipes/files/sockets, so that comparison never fired and terminalApprove
// wrote a prompt banner into whatever stdout happened to be. For this
// gateway's primary consumer — @strixgov/mcp-proxy, an MCP server whose
// JSON-RPC channel IS stdout — that corrupts the protocol stream.

/**
 * A recording stdout backed by a REAL stream. readline.createInterface
 * attaches listeners, so a hand-rolled object literal is not enough — and a
 * mock loose enough to satisfy readline would stop resembling the thing this
 * test is about.
 */
function recordingStdout(isTTY) {
  const s = new PassThrough();
  const chunks = [];
  s.on("data", (c) => chunks.push(String(c)));
  s.isTTY = isTTY;
  s.written = () => chunks.join("");
  return s;
}

/** A stdin double backed by a real stream, with TTY-ness stamped on. */
function fakeStdin(isTTY) {
  const s = new PassThrough();
  s.isTTY = isTTY;
  return s;
}

test("terminalApprove fails closed on a non-TTY WITHOUT writing to stdout", async () => {
  // The load-bearing half is the second assertion: a headless deny that still
  // emitted bytes would corrupt an MCP stdio stream just as badly as an allow.
  const stdout = recordingStdout(undefined); // pipes report undefined, not false
  const result = await terminalApprove(cap, inv, {
    stdin: fakeStdin(undefined),
    stdout,
    timeoutMs: 50,
  });
  assert.equal(result.approved, false);
  assert.equal(result.reason, "PROMPT_FAILED");
  assert.equal(stdout.written(), "", "must not write a single byte to a non-TTY stdout");
});

test("terminalApprove fails closed when only one end is a TTY", async () => {
  // An MCP proxy spawned with a TTY stdin but piped stdout is exactly the
  // shape that must not print: the pipe is the protocol channel.
  const stdout = recordingStdout(undefined);
  const result = await terminalApprove(cap, inv, {
    stdin: fakeStdin(true),
    stdout,
    timeoutMs: 50,
  });
  assert.equal(result.approved, false);
  assert.equal(result.reason, "PROMPT_FAILED");
  assert.equal(stdout.written(), "");
});

test("terminalApprove still prompts when both ends are real TTYs", async () => {
  // Proves the fix narrowed the guard rather than disabling the feature:
  // with two genuine TTYs the banner is written and the timeout path runs.
  const stdout = recordingStdout(true);
  // terminalApprove unref()s its timeout timer so it never holds a real
  // server open. Nothing else here keeps the loop alive, so without a ref'd
  // keepalive the process would exit and node:test would cancel this case
  // before the 40ms deny fires.
  const keepalive = setInterval(() => {}, 10);
  let result;
  try {
    result = await terminalApprove(cap, inv, {
      stdin: fakeStdin(true),
      stdout,
      timeoutMs: 40,
    });
  } finally {
    clearInterval(keepalive);
  }
  assert.equal(result.approved, false);
  assert.equal(result.reason, "TIMEOUT");
  assert.match(stdout.written(), /Approve|approval/i, "the prompt banner must reach a real TTY");
});
