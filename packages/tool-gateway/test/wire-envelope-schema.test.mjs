/**
 * Connected-wire envelope schema tests (v0.4 backlog #7).
 *
 * Validates that every POST emitted by ConnectedSyncer for v0.4-stable
 * has exactly the expected shape — no missing fields, no extra fields —
 * and that the HMAC covers the exact bytes sent.
 *
 * Also covers:
 *   - onSyncError deferred via queueMicrotask (#5): observer callback
 *     does not run synchronously inside the call that produced the error.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";

import {
  createGateway,
  generateSigningKey,
  MemoryStorage,
  WIRE_VERSION,
} from "../src/index.mjs";

const POLICY = { rules: { "cap.a": "ALLOW" }, default: "DENY" };
const CAPS = { "cap.a": { id: "cap.a", risk: "LOW", mode: "READ" } };
const API_KEY = "0123456789abcdef0123456789abcdef";

// Expected top-level keys for a receipt envelope (ordered in body doesn't
// matter — we check presence/absence of keys).
const RECEIPT_ENVELOPE_KEYS = new Set([
  "wireVersion",
  "timestamp",
  "nonce",
  "receipts",
]);

const SNAPSHOT_ENVELOPE_KEYS = new Set([
  "wireVersion",
  "timestamp",
  "nonce",
  "snapshots",
]);

function startCaptureServer() {
  const captured = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({ url: req.url ?? "", headers: { ...req.headers }, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        captured,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ─── Envelope shape ───────────────────────────────────────────────────────────

test("v0.4-stable receipt envelope has exactly the required keys", async () => {
  const srv = await startCaptureServer();
  try {
    const gw = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: { kernelUrl: srv.baseUrl, apiKey: API_KEY, tenantId: "t" },
    });
    await gw.execute({ capabilityId: "cap.a", action: "read", args: {} }, () => "ok");
    for (let i = 0; i < 20 && srv.captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(srv.captured.length, 1);
    const parsed = JSON.parse(srv.captured[0].body);
    const keys = new Set(Object.keys(parsed));
    for (const k of RECEIPT_ENVELOPE_KEYS) {
      assert.ok(keys.has(k), `missing key: ${k}`);
    }
    // No unexpected keys
    for (const k of keys) {
      assert.ok(RECEIPT_ENVELOPE_KEYS.has(k), `unexpected key in envelope: ${k}`);
    }
  } finally {
    await srv.close();
  }
});

test("wireVersion field is exactly 'v0.4-stable'", async () => {
  const srv = await startCaptureServer();
  try {
    const gw = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: { kernelUrl: srv.baseUrl, apiKey: API_KEY, tenantId: "t" },
    });
    await gw.execute({ capabilityId: "cap.a", action: "read", args: {} }, () => "ok");
    for (let i = 0; i < 20 && srv.captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const parsed = JSON.parse(srv.captured[0].body);
    assert.equal(parsed.wireVersion, "v0.4-stable");
    assert.equal(srv.captured[0].headers["x-strix-wire-version"], "v0.4-stable");
  } finally {
    await srv.close();
  }
});

test("receipts field is an array with exactly one receipt", async () => {
  const srv = await startCaptureServer();
  try {
    const gw = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: { kernelUrl: srv.baseUrl, apiKey: API_KEY, tenantId: "t" },
    });
    await gw.execute({ capabilityId: "cap.a", action: "read", args: {} }, () => "ok");
    for (let i = 0; i < 20 && srv.captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const parsed = JSON.parse(srv.captured[0].body);
    assert.ok(Array.isArray(parsed.receipts), "receipts must be an array");
    assert.equal(parsed.receipts.length, 1);
  } finally {
    await srv.close();
  }
});

test("HMAC header covers the exact body bytes", async () => {
  const srv = await startCaptureServer();
  try {
    const gw = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: { kernelUrl: srv.baseUrl, apiKey: API_KEY, tenantId: "t" },
    });
    await gw.execute({ capabilityId: "cap.a", action: "read", args: {} }, () => "ok");
    for (let i = 0; i < 20 && srv.captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const { body, headers } = srv.captured[0];
    const expected = "hmac-sha256=" + crypto.createHmac("sha256", API_KEY).update(body).digest("hex");
    assert.equal(headers["x-strix-signature"], expected);
  } finally {
    await srv.close();
  }
});

// ─── onSyncError deferred via queueMicrotask (#5) ─────────────────────────────

test("onSyncError does not fire synchronously inside _enqueue", async () => {
  const callOrder = [];
  const gw = createGateway({
    policy: POLICY,
    capabilities: CAPS,
    signingKey: generateSigningKey("k"),
    storage: new MemoryStorage(),
    approval: { enabled: false },
    connectedMode: {
      kernelUrl: "http://127.0.0.1:1", // unreachable
      apiKey: API_KEY,
      tenantId: "t",
    },
  });
  gw.on("sync-error", () => callOrder.push("sync-error"));

  // Execute and mark "after-execute" immediately after the await
  await gw.execute({ capabilityId: "cap.a", action: "read", args: {} }, () => "ok");
  callOrder.push("after-execute");

  // At this point sync-error should NOT have fired yet (it's deferred).
  // The fire-and-forget POST is still in flight — but even when it fails
  // and _enqueue runs, the callback is deferred to a microtask.
  // Wait a tick to let the network attempt + microtask queue flush.
  for (let i = 0; i < 20 && !callOrder.includes("sync-error"); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.ok(callOrder.includes("sync-error"), "sync-error must eventually fire");
  // "after-execute" must appear BEFORE "sync-error" in the order
  assert.ok(
    callOrder.indexOf("after-execute") < callOrder.indexOf("sync-error"),
    `expected after-execute before sync-error, got: ${callOrder.join(", ")}`,
  );
});
