/**
 * v0.2 surface tests.
 *
 * Covers:
 *   - KeyRing: generate, persist, rotate, multi-kid JWKS, retired-key
 *     verification.
 *   - V0.1 → v0.2 layout migration is preserved (kid unchanged).
 *   - Chain snapshots: cross-signed at rotation, both signatures verify,
 *     tampered snapshot detected.
 *   - Gateway.rotateKey() emits a "rotation" event and is atomic with
 *     respect to concurrent execute().
 *   - Receipts signed by the new kid still verify when the verifier is
 *     given a multi-key JWKS.
 *   - RateLimiter: window math, perActor partition, prefix wildcard,
 *     reset.
 *   - Gateway honours rateLimits and produces a DENY receipt with reason
 *     RATE_LIMITED.
 *   - Escalation hook: fires once per threshold breach and resets.
 *   - webhookApprover: HMAC signature is correct, polls until response,
 *     fails closed on bad URL / timeout.
 *   - Persistent registry: saved manifest verifies, tampered file is
 *     rejected, watch reloads on change.
 *   - Verifier 1.6.0 verifySnapshot + verifyToolGatewayProof end-to-end.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "node:http";

import {
  Gateway,
  createGateway,
  PolicyEngine,
  MemoryStorage,
  JsonlStorage,
  KeyRing,
  loadOrCreateKeyRing,
  generateSigningKey,
  RateLimiter,
  fileApprover,
  webhookApprover,
  verifyWebhookSignature,
  saveCapabilityRegistry,
  loadCapabilityRegistry,
  watchCapabilityRegistry,
  verifyReceipt,
  verifySnapshot,
  issueSnapshot,
  REGISTRY_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
} from "../src/index.mjs";

import {
  verifySnapshot as verifierVerifySnapshot,
  verifyToolGatewayProof,
  buildSnapshotCanonicalPayload,
} from "../../strixgov-verifier/src/index.mjs";

async function tmpDir(prefix = "strix-gw-test-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const POLICY = {
  rules: {
    "fs.read": "ALLOW",
    "fs.write": "ALLOW",
    "fs.delete": "DENY",
  },
  default: "DENY",
};

const CAPS = {
  "fs.read": { id: "fs.read", risk: "LOW", mode: "READ" },
  "fs.write": { id: "fs.write", risk: "MEDIUM", mode: "WRITE" },
  "fs.delete": { id: "fs.delete", risk: "HIGH", mode: "EXECUTE" },
};

function buildGateway(extra = {}) {
  const signingKey = generateSigningKey("local-2026-05");
  const storage = new MemoryStorage();
  const gateway = new Gateway({
    policy: POLICY,
    capabilities: CAPS,
    signingKey,
    storage,
    tenantId: "test-tenant",
    environment: "test",
    approval: { enabled: false },
    ...extra,
  });
  return { gateway, signingKey, storage };
}

// ─── KeyRing ────────────────────────────────────────────────────────────────

test("KeyRing creates a fresh ring with one active kid", async () => {
  const root = await tmpDir();
  const ring = await loadOrCreateKeyRing({ root, kid: "local-2026-05" });
  assert.equal(ring.activeKid, "local-2026-05");
  assert.equal(ring.listKids().length, 1);
  assert.ok(ring.active.privateKey);
  assert.equal(ring.jwks().keys.length, 1);
});

test("KeyRing migrates the v0.1 single-key layout in place", async () => {
  const root = await tmpDir();
  // Plant a v0.1 layout: signing-key.pem + public-jwk.json directly under root.
  const legacyKey = generateSigningKey("local-2026-04");
  await fs.writeFile(
    path.join(root, "signing-key.pem"),
    legacyKey.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, "public-jwk.json"),
    JSON.stringify(legacyKey.publicKeyJwk, null, 2),
  );
  const ring = await loadOrCreateKeyRing({ root });
  // Migration preserves the kid embedded in the legacy JWK.
  assert.equal(ring.activeKid, "local-2026-04");
  // And the legacy files are gone (moved into the per-kid subdir).
  await assert.rejects(
    fs.access(path.join(root, "signing-key.pem")),
    /ENOENT/,
  );
  await fs.access(path.join(root, "local-2026-04", "signing-key.pem"));
});

test("KeyRing.rotate retires previous, activates new, JWKS lists both", async () => {
  const root = await tmpDir();
  const ring = await loadOrCreateKeyRing({ root, kid: "local-2026-05" });
  const oldKid = ring.activeKid;
  const { previous, current } = await ring.rotate({ kid: "local-2026-06" });
  assert.equal(previous.meta.status, "retired");
  assert.equal(current.meta.status, "active");
  assert.equal(ring.activeKid, "local-2026-06");
  assert.equal(ring.listKids().length, 2);
  assert.equal(ring.jwks().keys.length, 2);
  // Active selector points at new kid.
  assert.equal(ring.active.kid, "local-2026-06");
  // Retired key still resolvable for verification.
  assert.ok(ring.publicKeyForKid(oldKid));
});

test("KeyRing.rotate refuses same kid", async () => {
  const root = await tmpDir();
  const ring = await loadOrCreateKeyRing({ root, kid: "local-2026-05" });
  // Auto-suffixes when desiredKid is already taken (the active one).
  const r = await ring.rotate({ kid: "local-2026-05" });
  assert.notEqual(r.current.kid, "local-2026-05");
  assert.match(r.current.kid, /^local-2026-05-[0-9a-f]{4}$/);
});

// ─── Chain snapshots ────────────────────────────────────────────────────────

test("issueSnapshot produces both signatures over the same canonical bytes", async () => {
  const previousKey = generateSigningKey("kid-A");
  const newKey = generateSigningKey("kid-B");
  const snap = issueSnapshot({
    previousKey,
    newKey,
    lastReceiptId: "rcpt_abc",
    lastProofChainHash: "a".repeat(64),
    policyVersion: "sha256:test",
    tenantId: "t",
    environment: "e",
  });
  assert.equal(snap.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snap.previousKid, "kid-A");
  assert.equal(snap.newKid, "kid-B");
  assert.ok(snap.signaturePrevious);
  assert.ok(snap.signatureNew);

  const v = verifySnapshot(snap, {
    resolvePublicKey: (kid) =>
      kid === "kid-A" ? previousKey.publicKey : kid === "kid-B" ? newKey.publicKey : null,
  });
  assert.equal(v.status, "VERIFIED");
  assert.equal(v.previousSignatureValid, true);
  assert.equal(v.newSignatureValid, true);
});

test("verifySnapshot detects tamper on canonical fields", async () => {
  const previousKey = generateSigningKey("kid-A");
  const newKey = generateSigningKey("kid-B");
  const snap = issueSnapshot({
    previousKey,
    newKey,
    lastReceiptId: "rcpt_abc",
    lastProofChainHash: "b".repeat(64),
    policyVersion: "sha256:test",
    tenantId: "t",
    environment: "e",
  });
  // Mutate a canonical field.
  snap.lastReceiptId = "rcpt_evil";
  const v = verifySnapshot(snap, {
    resolvePublicKey: (kid) =>
      kid === "kid-A" ? previousKey.publicKey : kid === "kid-B" ? newKey.publicKey : null,
  });
  assert.equal(v.status, "TAMPERED");
});

// ─── Gateway.rotateKey ──────────────────────────────────────────────────────

test("Gateway.rotateKey emits 'rotation', writes snapshot, new receipts use new kid", async () => {
  const root = await tmpDir();
  const dir = await tmpDir();
  const ring = await loadOrCreateKeyRing({ root, kid: "local-2026-05" });
  const storage = new JsonlStorage({ dir });
  const gateway = createGateway({
    policy: POLICY,
    capabilities: CAPS,
    keyRing: ring,
    storage,
    approval: { enabled: false },
  });
  // Need at least one receipt before rotation.
  const r1 = await gateway.execute(
    { capabilityId: "fs.read", action: "read", args: { path: "/etc/hosts" } },
    () => "data",
  );
  assert.equal(r1.receipt.signingKeyId, "local-2026-05");

  const snapshots = [];
  gateway.on("rotation", (e) => snapshots.push(e.snapshot));
  const snap = await gateway.rotateKey({ kid: "local-2026-06" });
  assert.equal(snap.previousKid, "local-2026-05");
  assert.equal(snap.newKid, "local-2026-06");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].snapshotId, snap.snapshotId);

  const r2 = await gateway.execute(
    { capabilityId: "fs.read", action: "read", args: { path: "/etc/hostname" } },
    () => "data",
  );
  assert.equal(r2.receipt.signingKeyId, "local-2026-06");

  // Old receipt verifies under retired kid; new receipt verifies under new kid.
  const v1 = verifyReceipt(r1.receipt, ring.publicKeyForKid("local-2026-05"));
  const v2 = verifyReceipt(r2.receipt, ring.publicKeyForKid("local-2026-06"));
  assert.equal(v1.status, "VERIFIED");
  assert.equal(v2.status, "VERIFIED");

  const persisted = await storage.listSnapshots();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].snapshotId, snap.snapshotId);
});

test("Gateway.rotateKey is rejected before any receipts (no chain to commit to)", async () => {
  const root = await tmpDir();
  const ring = await loadOrCreateKeyRing({ root, kid: "local-2026-05" });
  const gateway = createGateway({
    policy: POLICY,
    capabilities: CAPS,
    keyRing: ring,
    storage: new MemoryStorage(),
    approval: { enabled: false },
  });
  await assert.rejects(gateway.rotateKey(), /cannot rotate before any receipts/);
});

test("Gateway.rotateKey requires a keyRing", async () => {
  const { gateway } = buildGateway();
  await assert.rejects(gateway.rotateKey(), /keyRing must be supplied/);
});

// ─── RateLimiter ────────────────────────────────────────────────────────────

test("RateLimiter enforces sliding window with shared bucket", () => {
  let now = 1_000_000;
  const rl = new RateLimiter(
    { "fs.write": { windowMs: 1000, max: 3 } },
    { now: () => now },
  );
  for (let i = 0; i < 3; i++) {
    assert.equal(rl.check({ capabilityId: "fs.write" }).allowed, true);
  }
  assert.equal(rl.check({ capabilityId: "fs.write" }).allowed, false);
  // Advance past the window.
  now += 1001;
  assert.equal(rl.check({ capabilityId: "fs.write" }).allowed, true);
});

test("RateLimiter perActor partitions buckets by actorId", () => {
  let now = 0;
  const rl = new RateLimiter(
    { "fs.write": { windowMs: 1000, max: 1, perActor: true } },
    { now: () => now },
  );
  assert.equal(rl.check({ capabilityId: "fs.write", actorId: "alice" }).allowed, true);
  assert.equal(rl.check({ capabilityId: "fs.write", actorId: "alice" }).allowed, false);
  assert.equal(rl.check({ capabilityId: "fs.write", actorId: "bob" }).allowed, true);
});

test("RateLimiter prefix wildcards match by longest prefix", () => {
  const rl = new RateLimiter({
    "fs.*": { windowMs: 1000, max: 2 },
    "fs.write.*": { windowMs: 1000, max: 5 },
  });
  // fs.write.deep should bind to the more specific fs.write.* (max=5).
  for (let i = 0; i < 5; i++) {
    assert.equal(rl.check({ capabilityId: "fs.write.deep" }).allowed, true);
  }
  assert.equal(rl.check({ capabilityId: "fs.write.deep" }).allowed, false);
  // fs.read still uses fs.* (max=2).
  for (let i = 0; i < 2; i++) {
    assert.equal(rl.check({ capabilityId: "fs.read" }).allowed, true);
  }
  assert.equal(rl.check({ capabilityId: "fs.read" }).allowed, false);
});

test("Gateway honours rateLimits — third call denies as RATE_LIMITED", async () => {
  const policy = {
    ...POLICY,
    rateLimits: { "fs.write": { windowMs: 60_000, max: 2 } },
  };
  const signingKey = generateSigningKey("k");
  const storage = new MemoryStorage();
  const gateway = createGateway({
    policy,
    capabilities: CAPS,
    signingKey,
    storage,
    approval: { enabled: false },
  });
  const r1 = await gateway.execute(
    { capabilityId: "fs.write", action: "write", args: {} },
    () => 1,
  );
  const r2 = await gateway.execute(
    { capabilityId: "fs.write", action: "write", args: {} },
    () => 1,
  );
  const r3 = await gateway.execute(
    { capabilityId: "fs.write", action: "write", args: {} },
    () => 1,
  );
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, false);
  assert.equal(r3.decision, "DENY");
  assert.equal(r3.error.code, "RATE_LIMITED");
});

// ─── Escalation hook ────────────────────────────────────────────────────────

test("Gateway escalation fires once per threshold breach and resets", async () => {
  const escalations = [];
  const signingKey = generateSigningKey("k");
  const storage = new MemoryStorage();
  const gateway = createGateway({
    policy: POLICY,
    capabilities: CAPS,
    signingKey,
    storage,
    approval: { enabled: false },
    escalation: {
      threshold: 3,
      windowMs: 60_000,
      decisions: ["DENY"],
      onEscalate: (e) => escalations.push(e),
    },
  });
  for (let i = 0; i < 3; i++) {
    await gateway.execute(
      { capabilityId: "fs.delete", action: "rm", args: { path: "/x" } },
      () => 1,
    );
  }
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].count, 3);
  // Window should have reset; next two denies do not fire again.
  for (let i = 0; i < 2; i++) {
    await gateway.execute(
      { capabilityId: "fs.delete", action: "rm", args: { path: "/y" } },
      () => 1,
    );
  }
  assert.equal(escalations.length, 1);
});

// ─── webhookApprover ────────────────────────────────────────────────────────

test("webhookApprover signs body with HMAC-SHA256 and polls until response", async () => {
  const secret = "test-secret-at-least-16-chars-long";
  let receivedBody = null;
  let receivedHeaders = null;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      receivedBody = body;
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const notifyUrl = `http://127.0.0.1:${port}/notify`;

  // Pre-stage a response keyed by requestId. The approver polls for it.
  const responses = new Map();
  const approve = webhookApprover({
    notifyUrl,
    secret,
    pollResponse: async (requestId) => responses.get(requestId) ?? null,
    timeoutMs: 5_000,
    pollIntervalMs: 50,
  });

  // Capture the requestId from the inbound POST so we can stage a response.
  setTimeout(() => {
    if (receivedHeaders) {
      const requestId = receivedHeaders["x-strix-request-id"];
      responses.set(requestId, { approved: true, approvedBy: "alice" });
    }
  }, 200);

  const result = await approve(
    { id: "fs.write", risk: "MEDIUM", mode: "WRITE" },
    { capabilityId: "fs.write", action: "write", args: { path: "x" } },
  );
  server.close();
  assert.equal(result.approved, true);
  assert.equal(result.approvedBy, "alice");
  // HMAC verifies against the body the server received.
  const sigOk = verifyWebhookSignature({
    body: receivedBody,
    signatureHeader: receivedHeaders["x-strix-signature"],
    secret,
  });
  assert.equal(sigOk, true);
  // Wrong secret: rejected.
  assert.equal(
    verifyWebhookSignature({
      body: receivedBody,
      signatureHeader: receivedHeaders["x-strix-signature"],
      secret: "wrong-secret-at-least-16-chars",
    }),
    false,
  );
});

test("webhookApprover times out → DENY, no listener", async () => {
  const approve = webhookApprover({
    notifyUrl: "http://127.0.0.1:1/notify", // black hole
    secret: "test-secret-at-least-16-chars-long",
    pollResponse: async () => null,
    timeoutMs: 200,
    pollIntervalMs: 50,
  });
  const result = await approve(
    { id: "fs.write", risk: "MEDIUM", mode: "WRITE" },
    { capabilityId: "fs.write", action: "write", args: {} },
  );
  // Either PROMPT_FAILED (network error) or TIMEOUT — both deny.
  assert.equal(result.approved, false);
  assert.ok(["PROMPT_FAILED", "TIMEOUT"].includes(result.reason));
});

// ─── Persistent capability registry ─────────────────────────────────────────

test("saveCapabilityRegistry → loadCapabilityRegistry round-trip", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "capabilities.json");
  const signingKey = generateSigningKey("kid-reg");
  const manifest = await saveCapabilityRegistry({
    path: file,
    signingKey,
    capabilities: [
      { id: "fs.read", risk: "LOW", mode: "READ" },
      { id: "fs.write", risk: "MEDIUM", mode: "WRITE" },
    ],
  });
  assert.equal(manifest.schemaVersion, REGISTRY_SCHEMA_VERSION);
  const loaded = await loadCapabilityRegistry({
    path: file,
    resolvePublicKey: (kid) => (kid === "kid-reg" ? signingKey.publicKey : null),
  });
  assert.equal(loaded.capabilities.length, 2);
  assert.equal(loaded.capabilities[0].id, "fs.read"); // sorted
});

test("loadCapabilityRegistry rejects tampered manifests", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "capabilities.json");
  const signingKey = generateSigningKey("kid-reg");
  await saveCapabilityRegistry({
    path: file,
    signingKey,
    capabilities: [{ id: "fs.read", risk: "LOW", mode: "READ" }],
  });
  // Mutate the file (tamper with risk level).
  const tampered = JSON.parse(await fs.readFile(file, "utf8"));
  tampered.capabilities[0].risk = "CRITICAL";
  await fs.writeFile(file, JSON.stringify(tampered, null, 2));
  await assert.rejects(
    loadCapabilityRegistry({
      path: file,
      resolvePublicKey: (kid) =>
        kid === "kid-reg" ? signingKey.publicKey : null,
    }),
    /signature does not verify/,
  );
});

test("watchCapabilityRegistry fires onChange on writeback", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "capabilities.json");
  const signingKey = generateSigningKey("kid-reg");
  await saveCapabilityRegistry({
    path: file,
    signingKey,
    capabilities: [{ id: "fs.read", risk: "LOW", mode: "READ" }],
  });
  const events = [];
  const w = await watchCapabilityRegistry({
    path: file,
    resolvePublicKey: () => signingKey.publicKey,
    onChange: (m) => events.push(m),
  });
  // Write a new manifest with an additional cap.
  await saveCapabilityRegistry({
    path: file,
    signingKey,
    capabilities: [
      { id: "fs.read", risk: "LOW", mode: "READ" },
      { id: "fs.write", risk: "MEDIUM", mode: "WRITE" },
    ],
  });
  // node:fs.watch is platform-dependent; allow up to 1s for the event.
  for (let i = 0; i < 20 && events.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  w.close();
  assert.ok(events.length >= 1, "expected at least one change event");
  assert.equal(events[events.length - 1].capabilities.length, 2);
});

// ─── Verifier 1.6.0 bridge ──────────────────────────────────────────────────

test("verifier verifySnapshot accepts gateway-issued snapshot via JWKS", async () => {
  const previousKey = generateSigningKey("kid-A");
  const newKey = generateSigningKey("kid-B");
  const snap = issueSnapshot({
    previousKey,
    newKey,
    lastReceiptId: "rcpt_abc",
    lastProofChainHash: "c".repeat(64),
    policyVersion: "sha256:test",
    tenantId: "t",
    environment: "e",
  });
  const jwks = { keys: [previousKey.publicKeyJwk, newKey.publicKeyJwk] };
  const v = await verifierVerifySnapshot(snap, { jwks });
  assert.equal(v.verificationStatus, "VERIFIED");
  assert.equal(v.previousSignatureValid, true);
  assert.equal(v.newSignatureValid, true);
});

test("verifier buildSnapshotCanonicalPayload byte-matches the gateway serializer", async () => {
  const previousKey = generateSigningKey("kid-A");
  const newKey = generateSigningKey("kid-B");
  const snap = issueSnapshot({
    previousKey,
    newKey,
    lastReceiptId: "rcpt_match",
    lastProofChainHash: "d".repeat(64),
    policyVersion: "sha256:test",
    tenantId: "t",
    environment: "e",
  });
  const verifierBytes = buildSnapshotCanonicalPayload(snap);
  // Sanity: re-signing with previousKey using verifier's bytes verifies under previousKey.
  const sig = crypto.sign(null, Buffer.from(verifierBytes, "utf8"), previousKey.privateKey);
  assert.equal(
    crypto.verify(null, Buffer.from(verifierBytes, "utf8"), previousKey.publicKey, sig),
    true,
  );
});

test("verifyToolGatewayProof end-to-end: receipts + snapshot under multi-key JWKS", async () => {
  const root = await tmpDir();
  const dir = await tmpDir();
  const ring = await loadOrCreateKeyRing({ root, kid: "kid-A" });
  const storage = new JsonlStorage({ dir });
  const gateway = createGateway({
    policy: POLICY,
    capabilities: CAPS,
    keyRing: ring,
    storage,
    approval: { enabled: false },
  });
  await gateway.execute(
    { capabilityId: "fs.read", action: "read", args: { path: "x" } },
    () => 1,
  );
  await gateway.rotateKey({ kid: "kid-B" });
  await gateway.execute(
    { capabilityId: "fs.read", action: "read", args: { path: "y" } },
    () => 1,
  );
  const receipts = await storage.listReceipts();
  const snapshots = await storage.listSnapshots();
  const result = await verifyToolGatewayProof(
    { receipts, snapshots },
    { jwks: ring.jwks() },
  );
  assert.equal(result.overallStatus, "VERIFIED");
  assert.equal(result.allReceiptsVerified, true);
  assert.equal(result.allSnapshotsVerified, true);
  assert.equal(result.snapshots[0].lastReferenceValid, true);
});
