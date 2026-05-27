/**
 * Regression test for the QUORUM canonical-drift bug discovered 2026-05-20,
 * closed in v1.10.2.
 *
 * Bug summary (closed in v1.10.2):
 *   v1.10.1 fixed the single-artifact path (`verifyApprovalArtifact({
 *   artifactId })`) to prefer server-provided canonical bytes
 *   (`fetched.canonical.serialized`) over local reconstruction. But the
 *   quorum path (`verifyApprovalQuorum({ decisionId })`) iterates artifacts
 *   from `/api/public/decisions/<id>/approvals` and calls
 *   `verifyApprovalArtifact({ artifactPayload: a, ... })`. Before v1.10.2:
 *
 *     1. The quorum endpoint response per artifact did NOT include
 *        `canonical.serialized` or `canonical.payload`. Only the
 *        single-artifact endpoint did.
 *     2. The `artifactPayload` branch in `verifyApprovalArtifact` had no
 *        way to honor `canonicalSerialized` — it always fell through to
 *        local reconstruction via `buildApprovalCanonicalPayload(artifact)`.
 *     3. The artifact projection in the quorum response omits `actorUserId`
 *        per Gap 5 redaction. `buildApprovalCanonicalPayload` then produces
 *        `String(undefined ?? "")` → `""` for actorUserId, generating bytes
 *        that don't match what the signer signed.
 *
 *   Result: every artifact in every quorum verification returned
 *   HASH_MISMATCH. Cascading: chain continuity also broke because the
 *   wrong recomputedCanonicalHash never matched the server's
 *   proofChainHash. CLI exit code 1 with no actionable detail.
 *
 * Fix in v1.10.2 (two parts):
 *   - Server: `/api/public/decisions/<id>/approvals` now emits a
 *     `canonical: { schemaVersion, payload, serialized }` block per
 *     artifact, mirroring the single-artifact endpoint.
 *   - Client: `verifyApprovalArtifact` honors `input.canonicalSerialized`
 *     and `input.canonicalPayload` on the `artifactPayload` branch;
 *     `verifyApprovalQuorum` plumbs `a.canonical.serialized` /
 *     `a.canonical.payload` through.
 *
 * This test exercises the canonical-byte path WITHOUT network calls. It
 * builds the equivalent of fetchApprovalQuorum's return value, invokes
 * verifyApprovalArtifact on each artifact via the artifactPayload branch
 * (the exact code path verifyApprovalQuorum uses), and asserts:
 *
 *   1. Pre-fix path (no canonical.* on artifact, no canonicalSerialized
 *      passed to verifier) produces HASH_MISMATCH — locks the bug class.
 *   2. Post-fix path (canonical.serialized present on artifact) produces
 *      a recomputed hash that equals the stored canonicalPayloadHash.
 *   3. Passing `canonicalPayload` instead of `canonicalSerialized` also
 *      works (secondary fallback in v1.10.2).
 *
 * Catches a re-introduction of the redacted-projection reconstruction
 * path immediately.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  verifyApprovalArtifact,
  buildApprovalCanonicalPayload,
  approvalCanonicalHash,
} from "../src/index.mjs";

// A single artifact as it appears inside a quorum response. The display
// projection omits `actorUserId` (Gap 5 redaction). canonicalPayloadHash
// reflects what the signer actually computed — over canonical bytes that
// DO include actorUserId.
const ARTIFACT_FROM_QUORUM = {
  id: "cmp4s2g7k000iih04k87nadt4",
  decisionId: "cmp4s2g3r000aih04u1p46jjd",
  approvalId: "cmp4s2g7c000gih04qy2f3nsn",
  capabilityId: "page.doctor",
  approvalMethod: "auto",
  policyVersion: "sha256:082878f4e9412f682885b1c63a9562472abcb81ae88a8754453413b0132a3790",
  environment: "development",
  sequenceNum: 1,
  proofChainHash: null,
  canonicalPayloadHash: "1d2b2f97ea03f93ff028c78992675228cebb8651b40adcc26deee6a21be630a0",
  signature: "iU7V5rOcehoRzxS5lL7t0e3e3WQD-3s1ARQ3iVkRbJYimNtKj8Ah1YlqNXESurTc6Ifgzis9SuFMoY7-juMXDg",
  signingKeyId: "strix-***-2026-05",
  approvedAt: "2026-05-14T00:56:16.777Z",
  mintedAt: "2026-05-14T00:56:16.785Z",
  // NOTE: no actorUserId (Gap 5 redaction)
  // NOTE: no schemaVersion (not in display projection)
};

// What the server now ships (v1.10.2): canonical bytes the signer signed
// over, including actorUserId + schemaVersion.
const ARTIFACT_FROM_QUORUM_WITH_CANONICAL = {
  ...ARTIFACT_FROM_QUORUM,
  canonical: {
    schemaVersion: "1",
    payload: {
      schemaVersion: "1",
      decisionId: "cmp4s2g3r000aih04u1p46jjd",
      approvalId: "cmp4s2g7c000gih04qy2f3nsn",
      capabilityId: "page.doctor",
      actorUserId: "solo-cli",
      approvalMethod: "auto",
      policyVersion: "sha256:082878f4e9412f682885b1c63a9562472abcb81ae88a8754453413b0132a3790",
      environment: "development",
      approvedAt: "2026-05-14T00:56:16.777Z",
    },
    serialized:
      '{"schemaVersion":"1","decisionId":"cmp4s2g3r000aih04u1p46jjd","approvalId":"cmp4s2g7c000gih04qy2f3nsn","capabilityId":"page.doctor","actorUserId":"solo-cli","approvalMethod":"auto","policyVersion":"sha256:082878f4e9412f682885b1c63a9562472abcb81ae88a8754453413b0132a3790","environment":"development","approvedAt":"2026-05-14T00:56:16.777Z"}',
  },
};

describe("quorum canonical drift — v1.10.2 regression pin", () => {
  test("baseline: reconstruction from redacted artifact produces wrong bytes", () => {
    // The pre-1.10.2 quorum loop ended up here. Lock the bug class.
    const wrong = buildApprovalCanonicalPayload(ARTIFACT_FROM_QUORUM);
    const wrongHash = approvalCanonicalHash(wrong);
    assert.notStrictEqual(
      wrongHash,
      ARTIFACT_FROM_QUORUM.canonicalPayloadHash,
      "reconstruction from redacted artifact should NOT match stored hash",
    );
    assert.strictEqual(
      JSON.parse(wrong).actorUserId,
      "",
      "reconstruction from redacted artifact should leave actorUserId empty",
    );
  });

  test("v1.10.2: canonicalSerialized via artifactPayload path verifies hash", async () => {
    // Exact shape verifyApprovalQuorum passes per-artifact in v1.10.2.
    const result = await verifyApprovalArtifact({
      artifactPayload: ARTIFACT_FROM_QUORUM_WITH_CANONICAL,
      canonicalPayloadHash: ARTIFACT_FROM_QUORUM.canonicalPayloadHash,
      canonicalSerialized: ARTIFACT_FROM_QUORUM_WITH_CANONICAL.canonical.serialized,
      canonicalPayload: ARTIFACT_FROM_QUORUM_WITH_CANONICAL.canonical.payload,
      signature: ARTIFACT_FROM_QUORUM.signature,
      signingKeyId: ARTIFACT_FROM_QUORUM.signingKeyId,
      // No publicKey + no jwks: signature step will fail, but hashValid +
      // recomputedCanonicalHash are what this test pins.
      publicKey: undefined,
    });
    assert.strictEqual(
      result.hashValid,
      true,
      "hashValid must be true when canonicalSerialized matches stored hash",
    );
    assert.strictEqual(
      result.recomputedCanonicalHash,
      ARTIFACT_FROM_QUORUM.canonicalPayloadHash,
      "recomputedCanonicalHash must equal the stored canonicalPayloadHash",
    );
  });

  test("v1.10.2 fallback: canonicalPayload (without serialized) also works", async () => {
    // Secondary fallback — if a future API version drops `serialized` but
    // keeps `payload`, JSON.stringify with insertion order produces the
    // same bytes the signer produced.
    const result = await verifyApprovalArtifact({
      artifactPayload: ARTIFACT_FROM_QUORUM_WITH_CANONICAL,
      canonicalPayloadHash: ARTIFACT_FROM_QUORUM.canonicalPayloadHash,
      canonicalPayload: ARTIFACT_FROM_QUORUM_WITH_CANONICAL.canonical.payload,
      signature: ARTIFACT_FROM_QUORUM.signature,
      signingKeyId: ARTIFACT_FROM_QUORUM.signingKeyId,
      publicKey: undefined,
    });
    assert.strictEqual(
      result.hashValid,
      true,
      "hashValid must be true when canonicalPayload reconstructs to the right bytes",
    );
  });

  test("v1.10.2 last resort: no canonical.* passed → falls back to artifact-only reconstruction → hash invalid", async () => {
    // If a caller forgets to plumb canonical.* through, they get the
    // pre-fix behavior (hash check fails on every artifact). This pins
    // the failure mode so a future "silent helpful default" doesn't mask
    // it. We assert on `hashValid` (set before the signature step) rather
    // than the terminal `verificationStatus` so the test doesn't depend
    // on network reachability for the JWKS fetch.
    const result = await verifyApprovalArtifact({
      artifactPayload: ARTIFACT_FROM_QUORUM,
      canonicalPayloadHash: ARTIFACT_FROM_QUORUM.canonicalPayloadHash,
      // No signature / no signingKeyId → early-return UNSIGNED. The hash
      // verdict is still computed in the line above (canonical bytes
      // reconstructed from the redacted artifact), which is the bug class.
      signature: null,
      signingKeyId: null,
    });
    assert.strictEqual(
      result.hashValid,
      false,
      "without canonical.*, redacted-projection reconstruction must fail hash check",
    );
    assert.notStrictEqual(
      result.recomputedCanonicalHash,
      ARTIFACT_FROM_QUORUM.canonicalPayloadHash,
      "recomputedCanonicalHash diverges from stored hash when actorUserId is absent",
    );
  });
});
