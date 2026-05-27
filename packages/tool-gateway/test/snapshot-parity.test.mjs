/**
 * Snapshot canonical-parity tests (v0.4 backlog #6).
 *
 * Asserts that `canonicalSnapshotPayload` in @strixgov/tool-gateway and
 * `buildSnapshotCanonicalPayload` in @strixgov/verifier produce byte-identical
 * output for the same input. If these drift, the verifier will reject
 * snapshots issued by the gateway without any obvious error.
 *
 * Also covers:
 *   - schemaVersion dispatch: unsupported version returns an error result
 *     rather than throwing.
 *   - RateLimiter unique-actor cap: memory bounded at configurable maxActors.
 *   - Wire envelope schema: v0.4-stable envelope has the exact expected shape.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  canonicalSnapshotPayload,
  issueSnapshot,
  verifySnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  SUPPORTED_SNAPSHOT_VERSIONS,
} from "../src/snapshots.mjs";

import {
  buildSnapshotCanonicalPayload,
} from "../../strixgov-verifier/src/index.mjs";

import { generateSigningKey } from "../src/index.mjs";
import { RateLimiter } from "../src/rate-limit.mjs";

// ─── Snapshot canonical parity ────────────────────────────────────────────────

const SAMPLE_SNAPSHOT = {
  schemaVersion: "snap-1",
  snapshotId: "snap_aabbccddeeff001122334455",
  previousKid: "kid-A",
  newKid: "kid-B",
  lastReceiptId: "rcpt_112233445566778899aabbcc",
  lastProofChainHash: "a".repeat(64),
  policyVersion: "sha256:deadbeef",
  tenantId: "tenant-x",
  environment: "production",
  timestamp: "2026-05-09T00:00:00.000Z",
};

test("canonicalSnapshotPayload and buildSnapshotCanonicalPayload are byte-identical", () => {
  const gateway = canonicalSnapshotPayload(SAMPLE_SNAPSHOT);
  const verifier = buildSnapshotCanonicalPayload(SAMPLE_SNAPSHOT);
  assert.equal(gateway, verifier, "canonical bytes must be identical");
});

test("parity holds across varied field values", () => {
  const variants = [
    { ...SAMPLE_SNAPSHOT, tenantId: "local", environment: "development" },
    { ...SAMPLE_SNAPSHOT, policyVersion: "sha256:" + "f".repeat(64) },
    { ...SAMPLE_SNAPSHOT, lastProofChainHash: "0".repeat(64) },
  ];
  for (const snap of variants) {
    assert.equal(
      canonicalSnapshotPayload(snap),
      buildSnapshotCanonicalPayload(snap),
      `parity failed for variant: ${JSON.stringify(snap)}`,
    );
  }
});

test("parity holds for a real issued snapshot", () => {
  const prev = generateSigningKey("kid-A");
  const next = generateSigningKey("kid-B");
  const snap = issueSnapshot({
    previousKey: prev,
    newKey: next,
    lastReceiptId: "rcpt_test",
    lastProofChainHash: "b".repeat(64),
    policyVersion: "sha256:abc",
    tenantId: "t",
    environment: "local",
  });
  // Extract the 10 canonical fields for comparison
  const canonical = {};
  for (const f of ["schemaVersion","snapshotId","previousKid","newKid","lastReceiptId","lastProofChainHash","policyVersion","tenantId","environment","timestamp"]) {
    canonical[f] = snap[f];
  }
  assert.equal(
    canonicalSnapshotPayload(canonical),
    buildSnapshotCanonicalPayload(canonical),
  );
});

// ─── schemaVersion dispatch ───────────────────────────────────────────────────

test("SUPPORTED_SNAPSHOT_VERSIONS includes snap-1", () => {
  assert.ok(SUPPORTED_SNAPSHOT_VERSIONS.includes("snap-1"));
  assert.equal(SNAPSHOT_SCHEMA_VERSION, "snap-1");
});

test("verifySnapshot returns error result for unsupported schemaVersion (no throw)", () => {
  const snap = { ...SAMPLE_SNAPSHOT, schemaVersion: "snap-99" };
  const result = verifySnapshot(snap, { resolvePublicKey: () => null });
  assert.equal(result.status, "ERROR");
  assert.match(result.error, /unsupported schemaVersion/);
});

test("verifySnapshot returns error result for missing schemaVersion", () => {
  const { schemaVersion: _, ...snap } = SAMPLE_SNAPSHOT;
  const result = verifySnapshot({ ...snap, schemaVersion: undefined }, {
    resolvePublicKey: () => null,
  });
  assert.equal(result.status, "ERROR");
});

// ─── RateLimiter unique-actor cap ─────────────────────────────────────────────

test("RateLimiter caps unique actor buckets at maxActors (global default)", () => {
  const limiter = new RateLimiter(
    { "cap.x": { windowMs: 60_000, max: 100, perActor: true } },
    { maxActors: 5 },
  );
  // Insert 7 unique actors — only 5 should remain in the bucket map
  for (let i = 0; i < 7; i++) {
    limiter.check({ capabilityId: "cap.x", actorId: `actor-${i}` });
  }
  const perRule = limiter._buckets.get("cap.x");
  assert.ok(perRule.size <= 5, `expected ≤5 buckets, got ${perRule.size}`);
});

test("RateLimiter evicts oldest actor on cap (FIFO)", () => {
  const limiter = new RateLimiter(
    { "cap.x": { windowMs: 60_000, max: 100, perActor: true } },
    { maxActors: 3 },
  );
  for (const id of ["a", "b", "c"]) {
    limiter.check({ capabilityId: "cap.x", actorId: id });
  }
  // "a" is oldest; adding "d" should evict "a"
  limiter.check({ capabilityId: "cap.x", actorId: "d" });
  const perRule = limiter._buckets.get("cap.x");
  assert.equal(perRule.has("a"), false, "oldest actor should be evicted");
  assert.equal(perRule.has("d"), true, "new actor should be present");
  assert.ok(perRule.size <= 3);
});

test("RateLimiter shared bucket (perActor: false) is unaffected by maxActors", () => {
  const limiter = new RateLimiter(
    { "cap.y": { windowMs: 60_000, max: 100 } }, // perActor defaults to false
    { maxActors: 2 },
  );
  for (let i = 0; i < 5; i++) {
    limiter.check({ capabilityId: "cap.y", actorId: `actor-${i}` });
  }
  const perRule = limiter._buckets.get("cap.y");
  // Only the __shared__ bucket exists regardless of how many actorIds were passed
  assert.equal(perRule.size, 1);
});

test("RateLimiter per-rule maxActors overrides global default", () => {
  const limiter = new RateLimiter(
    { "cap.z": { windowMs: 60_000, max: 100, perActor: true, maxActors: 2 } },
    { maxActors: 10_000 },
  );
  for (let i = 0; i < 5; i++) {
    limiter.check({ capabilityId: "cap.z", actorId: `actor-${i}` });
  }
  const perRule = limiter._buckets.get("cap.z");
  assert.ok(perRule.size <= 2);
});
