/**
 * Webhook approval channel — the Slack-compatible notification adapter on
 * top of the gateway's file approver.
 *
 * Pins the load-bearing failure semantics:
 *   - a delivered notification carries the Slack `text` + structured
 *     `strix` block, and the decision STILL flows through the response
 *     file (approve + deny);
 *   - an unreachable webhook endpoint never approves and never
 *     auto-denies — the file decision path keeps working;
 *   - bad config (missing/invalid webhookUrl) fails at construction,
 *     not at first call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildWebhookPayload, webhookApprover } from "../src/webhook-approver.mjs";

const CAP = { id: "notion.pages.create", name: "Create page", risk: "MEDIUM", mode: "APPROVAL_REQUIRED" };
const INV = { capabilityId: "notion.pages.create", action: "call", args: { title: "hi" }, actorId: "agent-1" };

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "strix-webhook-approver-"));
}

/** Start a capture server on 127.0.0.1; returns { url, bodies, close }. */
function captureServer() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200).end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        bodies,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Watch requestDir for the request file, then write the response file. */
async function respondWhenAsked(requestDir, response, { pollMs = 25, timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(requestDir).catch(() => []);
    const req = entries.find((e) => e.endsWith(".request.json"));
    if (req) {
      const requestId = req.replace(".request.json", "");
      await fs.writeFile(
        path.join(requestDir, `${requestId}.response.json`),
        JSON.stringify(response),
      );
      return requestId;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("no request file appeared");
}

test("buildWebhookPayload is Slack-compatible and carries the structured strix block", () => {
  const payload = buildWebhookPayload({
    requestId: "abc123",
    serverId: "notion",
    capability: CAP,
    invocation: INV,
  });
  assert.equal(typeof payload.text, "string"); // Slack incoming-webhook contract
  assert.match(payload.text, /approval required/i);
  assert.match(payload.text, /notion\.pages\.create/);
  assert.match(payload.text, /guard approve abc123/);
  assert.match(payload.text, /guard deny abc123/);
  assert.deepEqual(payload.strix, {
    kind: "approval.requested",
    requestId: "abc123",
    serverId: "notion",
    capabilityId: "notion.pages.create",
    risk: "MEDIUM",
    action: "call",
  });
});

test("notifies the webhook and approves via the response file", async () => {
  const hook = await captureServer();
  const requestDir = await tmpDir();
  const events = [];
  try {
    const prompt = webhookApprover({
      webhookUrl: hook.url,
      serverId: "notion",
      requestDir,
      timeoutMs: 5_000,
      pollIntervalMs: 25,
      onAudit: (e) => events.push(e),
    });

    const responder = respondWhenAsked(requestDir, { approved: true, approvedBy: "alice" });
    const result = await prompt(CAP, INV, {});
    await responder;

    assert.equal(result.approved, true);
    assert.equal(result.approvedBy, "alice");

    assert.equal(hook.bodies.length, 1);
    assert.match(hook.bodies[0].text, /notion\.pages\.create/);
    assert.equal(hook.bodies[0].strix.serverId, "notion");
    assert.ok(events.some((e) => e.kind === "approval.webhook.notified"));
  } finally {
    await hook.close();
    await fs.rm(requestDir, { recursive: true, force: true });
  }
});

test("denies via the response file (webhook delivered)", async () => {
  const hook = await captureServer();
  const requestDir = await tmpDir();
  try {
    const prompt = webhookApprover({
      webhookUrl: hook.url,
      requestDir,
      timeoutMs: 5_000,
      pollIntervalMs: 25,
    });
    const responder = respondWhenAsked(requestDir, { approved: false });
    const result = await prompt(CAP, INV, {});
    await responder;
    assert.equal(result.approved, false);
    assert.equal(result.reason, "USER_DENIED");
  } finally {
    await hook.close();
    await fs.rm(requestDir, { recursive: true, force: true });
  }
});

test("unreachable webhook never approves and never auto-denies — file decision still works", async () => {
  const requestDir = await tmpDir();
  const events = [];
  try {
    const prompt = webhookApprover({
      // Nothing listens here — connection refused on first packet.
      webhookUrl: "http://127.0.0.1:1/hook",
      requestDir,
      timeoutMs: 5_000,
      pollIntervalMs: 25,
      onAudit: (e) => events.push(e),
    });
    const responder = respondWhenAsked(requestDir, { approved: true, approvedBy: "bob" });
    const result = await prompt(CAP, INV, {});
    await responder;
    // The human decision carried the day despite the lost notification.
    assert.equal(result.approved, true);
    assert.ok(events.some((e) => e.kind === "approval.webhook.notify_failed"));
  } finally {
    await fs.rm(requestDir, { recursive: true, force: true });
  }
});

test("times out to DENY when nobody responds (decision semantics unchanged)", async () => {
  const hook = await captureServer();
  const requestDir = await tmpDir();
  try {
    const prompt = webhookApprover({
      webhookUrl: hook.url,
      requestDir,
      timeoutMs: 300,
      pollIntervalMs: 25,
    });
    const result = await prompt(CAP, INV, {});
    assert.equal(result.approved, false);
  } finally {
    await hook.close();
    await fs.rm(requestDir, { recursive: true, force: true });
  }
});

test("fails at construction on missing or non-http(s) webhookUrl", () => {
  assert.throws(() => webhookApprover({ requestDir: "." }), /requires approval\.webhookUrl/);
  assert.throws(
    () => webhookApprover({ webhookUrl: "not a url", requestDir: "." }),
    /not a valid URL/,
  );
  assert.throws(
    () => webhookApprover({ webhookUrl: "ftp://example.com/x", requestDir: "." }),
    /must be http\(s\)/,
  );
});
