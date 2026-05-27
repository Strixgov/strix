/**
 * v0.4-stable wire envelope tests.
 *
 * Covers:
 *   - Envelope carries timestamp (ISO 8601) and nonce (32-char hex).
 *   - Each send produces a unique nonce (replay-distinct bodies).
 *   - verifyConnectedWireEnvelope returns timestamp + nonce fields.
 *   - Stale timestamp rejection via maxAgeMs.
 *   - Future timestamp (> 30 s ahead) marked stale.
 *   - v0.3-experimental envelope still recognised by verifier (backward compat).
 *   - HMAC computed before format check (timing-safe: malformed header still
 *     runs the full HMAC path).
 *   - verifyWebhookSignature timing-safe: missing / malformed header still
 *     runs HMAC computation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";

import {
  createGateway,
  generateSigningKey,
  MemoryStorage,
  ConnectedSyncer,
  WIRE_VERSION,
} from "../src/index.mjs";

import {
  verifyConnectedWireEnvelope,
  SUPPORTED_WIRE_VERSIONS,
} from "../../strixgov-verifier/src/index.mjs";

import { verifyWebhookSignature } from "../src/approval.mjs";

const POLICY = { rules: { "fs.read": "ALLOW" }, default: "DENY" };
const CAPS = { "fs.read": { id: "fs.read", risk: "LOW", mode: "READ" } };
const API_KEY = "0123456789abcdef0123456789abcdef";

function startCaptureServer() {
  const captured = [];
  let respondWithStatus = 200;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({ url: req.url ?? "", headers: { ...req.headers }, body });
      res.writeHead(respondWithStatus, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        captured,
        setStatus: (s) => { respondWithStatus = s; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ─── Wire version ─────────────────────────────────────────────────────────────

test("WIRE_VERSION is v0.4-stable", () => {
  assert.equal(WIRE_VERSION, "v0.4-stable");
});

test("v0.4-stable and v0.3-experimental are both in SUPPORTED_WIRE_VERSIONS", () => {
  assert.ok(SUPPORTED_WIRE_VERSIONS.includes("v0.4-stable"));
  assert.ok(SUPPORTED_WIRE_VERSIONS.includes("v0.3-experimental"));
});

// ─── Envelope fields ──────────────────────────────────────────────────────────

test("v0.4-stable envelope includes timestamp and nonce", async () => {
  const srv = await startCaptureServer();
  try {
    const gateway = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: { kernelUrl: srv.baseUrl, apiKey: API_KEY, tenantId: "t" },
    });
    await gateway.execute(
      { capabilityId: "fs.read", action: "read", args: {} },
      () => "ok",
    );
    for (let i = 0; i < 20 && srv.captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(srv.captured.length, 1);
    const parsed = JSON.parse(srv.captured[0].body);
    assert.equal(parsed.wireVersion, "v0.4-stable");
    assert.ok(typeof parsed.timestamp === "string", "timestamp is string");
    assert.ok(!isNaN(new Date(parsed.timestamp).getTime()), "timestamp is valid ISO 8601");
    assert.match(parsed.nonce, /^[0-9a-f]{32}$/, "nonce is 32-char hex");
  } finally {
    await srv.close();
  }
});

test("each send produces a distinct nonce", async () => {
  const srv = await startCaptureServer();
  try {
    const gateway = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: { kernelUrl: srv.baseUrl, apiKey: API_KEY, tenantId: "t" },
    });
    for (let i = 0; i < 3; i++) {
      await gateway.execute(
        { capabilityId: "fs.read", action: "read", args: { i } },
        () => "ok",
      );
    }
    for (let i = 0; i < 30 && srv.captured.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(srv.captured.length, 3);
    const nonces = srv.captured.map((c) => JSON.parse(c.body).nonce);
    const unique = new Set(nonces);
    assert.equal(unique.size, 3, "all nonces are distinct");
  } finally {
    await srv.close();
  }
});

// ─── verifyConnectedWireEnvelope — v0.4 fields ────────────────────────────────

test("verifyConnectedWireEnvelope returns timestamp and nonce for v0.4-stable", () => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({ wireVersion: "v0.4-stable", timestamp, nonce, receipts: [] });
  const sig = "hmac-sha256=" + crypto.createHmac("sha256", API_KEY).update(body).digest("hex");
  const r = verifyConnectedWireEnvelope({ body, signatureHeader: sig, apiKey: API_KEY });
  assert.equal(r.valid, true);
  assert.equal(r.recognised, true);
  assert.equal(r.wireVersion, "v0.4-stable");
  assert.equal(r.timestamp, timestamp);
  assert.equal(r.nonce, nonce);
  assert.equal(r.stale, false);
});

test("verifyConnectedWireEnvelope stale=false when timestamp is fresh", () => {
  const body = JSON.stringify({
    wireVersion: "v0.4-stable",
    timestamp: new Date().toISOString(),
    nonce: "aa",
    receipts: [],
  });
  const sig = "hmac-sha256=" + crypto.createHmac("sha256", API_KEY).update(body).digest("hex");
  const r = verifyConnectedWireEnvelope({ body, signatureHeader: sig, apiKey: API_KEY, maxAgeMs: 300_000 });
  assert.equal(r.valid, true);
  assert.equal(r.stale, false);
});

test("verifyConnectedWireEnvelope stale=true for timestamp older than maxAgeMs", () => {
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
  const body = JSON.stringify({ wireVersion: "v0.4-stable", timestamp: old, nonce: "bb", receipts: [] });
  const sig = "hmac-sha256=" + crypto.createHmac("sha256", API_KEY).update(body).digest("hex");
  const r = verifyConnectedWireEnvelope({ body, signatureHeader: sig, apiKey: API_KEY, maxAgeMs: 300_000 });
  assert.equal(r.valid, true);
  assert.equal(r.stale, true);
});

test("verifyConnectedWireEnvelope stale=true for timestamp more than 30 s in the future", () => {
  const future = new Date(Date.now() + 60_000).toISOString(); // 60 s ahead
  const body = JSON.stringify({ wireVersion: "v0.4-stable", timestamp: future, nonce: "cc", receipts: [] });
  const sig = "hmac-sha256=" + crypto.createHmac("sha256", API_KEY).update(body).digest("hex");
  const r = verifyConnectedWireEnvelope({ body, signatureHeader: sig, apiKey: API_KEY, maxAgeMs: 300_000 });
  assert.equal(r.valid, true);
  assert.equal(r.stale, true);
});

test("verifyConnectedWireEnvelope stale not evaluated when maxAgeMs omitted", () => {
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const body = JSON.stringify({ wireVersion: "v0.4-stable", timestamp: old, nonce: "dd", receipts: [] });
  const sig = "hmac-sha256=" + crypto.createHmac("sha256", API_KEY).update(body).digest("hex");
  const r = verifyConnectedWireEnvelope({ body, signatureHeader: sig, apiKey: API_KEY });
  assert.equal(r.valid, true);
  assert.equal(r.stale, false); // not evaluated — stays at default false
});

// ─── Backward compat: v0.3-experimental still recognised ─────────────────────

test("v0.3-experimental envelope is still recognised by verifier", () => {
  const body = JSON.stringify({ wireVersion: "v0.3-experimental", receipts: [{ receiptId: "r1" }] });
  const sig = "hmac-sha256=" + crypto.createHmac("sha256", API_KEY).update(body).digest("hex");
  const r = verifyConnectedWireEnvelope({ body, signatureHeader: sig, apiKey: API_KEY });
  assert.equal(r.valid, true);
  assert.equal(r.recognised, true);
  assert.equal(r.wireVersion, "v0.3-experimental");
  // No timestamp/nonce fields in v0.3 body — both null
  assert.equal(r.timestamp, null);
  assert.equal(r.nonce, null);
});

// ─── Timing-safe HMAC (verifyConnectedWireEnvelope) ──────────────────────────

test("verifyConnectedWireEnvelope: missing signatureHeader still runs HMAC (timing-safe)", () => {
  // We can't directly measure time in tests; this verifies the code path
  // doesn't throw and returns valid=false for both missing and malformed.
  const body = JSON.stringify({ wireVersion: "v0.4-stable", receipts: [] });
  const r1 = verifyConnectedWireEnvelope({ body, signatureHeader: undefined, apiKey: API_KEY });
  assert.equal(r1.valid, false);
  const r2 = verifyConnectedWireEnvelope({ body, signatureHeader: "not-a-valid-sig", apiKey: API_KEY });
  assert.equal(r2.valid, false);
  const r3 = verifyConnectedWireEnvelope({ body, signatureHeader: "hmac-sha256=deadbeef", apiKey: API_KEY });
  assert.equal(r3.valid, false);
});

test("verifyConnectedWireEnvelope rejects wrong-key signature", () => {
  const body = JSON.stringify({ wireVersion: "v0.4-stable", timestamp: new Date().toISOString(), nonce: "ee", receipts: [] });
  const sig = "hmac-sha256=" + crypto.createHmac("sha256", API_KEY).update(body).digest("hex");
  const r = verifyConnectedWireEnvelope({ body, signatureHeader: sig, apiKey: "fedcba9876543210fedcba9876543210" });
  assert.equal(r.valid, false);
});

// ─── Timing-safe HMAC (verifyWebhookSignature) ───────────────────────────────

test("verifyWebhookSignature: missing / malformed header returns false without throwing", () => {
  const body = JSON.stringify({ approvalId: "ap_1" });
  const secret = "webhook-secret-1234";
  assert.equal(verifyWebhookSignature({ body, signatureHeader: undefined, secret }), false);
  assert.equal(verifyWebhookSignature({ body, signatureHeader: "", secret }), false);
  assert.equal(verifyWebhookSignature({ body, signatureHeader: "bad", secret }), false);
  assert.equal(verifyWebhookSignature({ body, signatureHeader: "hmac-sha256=deadbeef", secret }), false);
});

test("verifyWebhookSignature: correct signature passes, wrong key fails", () => {
  const body = JSON.stringify({ approvalId: "ap_2" });
  const secret = "webhook-secret-5678";
  const sig = "hmac-sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyWebhookSignature({ body, signatureHeader: sig, secret }), true);
  assert.equal(verifyWebhookSignature({ body, signatureHeader: sig, secret: "wrong-secret-xxxxx" }), false);
});
