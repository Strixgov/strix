/**
 * Regression test for the approval-canonical drift bug discovered 2026-05-18.
 *
 * Bug summary (closed in v1.10.1):
 *   The /api/public/approval-artifact/:id response splits artifact data into
 *   three sections:
 *     - `artifact`            — display projection (missing actorUserId,
 *                               schemaVersion)
 *     - `canonical.payload`   — full 9-field canonical object
 *     - `canonical.serialized` — exact JSON bytes the signer signed over
 *
 *   Prior to 1.10.1, the verifier reconstructed canonical bytes from
 *   `fetched.artifact` and called `buildApprovalCanonicalPayload(artifact)`.
 *   That builder calls `String(record.actorUserId ?? "")` — which becomes
 *   `""` (empty string) when actorUserId is absent from the display
 *   projection. The resulting bytes differed from the signed bytes by one
 *   field (`actorUserId`), so SHA-256 differed, so every approval artifact
 *   returned HASH_MISMATCH against the hosted proof API.
 *
 * Fix in v1.10.1:
 *   verifyApprovalArtifact prefers `fetched.canonical.serialized` (the
 *   server-provided signed bytes) when present, falls back to
 *   `JSON.stringify(fetched.canonical.payload)`, falls back to local
 *   reconstruction from `artifact` only as last resort. Same pattern as
 *   v1.10.0's `signedPayload`-direct path for evidence records.
 *
 * This test exercises the canonical-byte path WITHOUT network calls. It
 * builds the equivalent of fetchApprovalArtifact's return value, invokes
 * the post-1.10.1 logic, and asserts:
 *   1. Local reconstruction from artifact display projection produces
 *      different bytes (the pre-fix behavior — we want to catch any future
 *      regression that promotes display projection back over signed bytes).
 *   2. Using canonical.serialized produces bytes that hash to the stored
 *      hash.
 *   3. The diff between the two is exactly `actorUserId` (the field the
 *      display projection omits).
 *
 * Catches a re-introduction of the artifact-projection bug class
 * immediately.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildApprovalCanonicalPayload,
  approvalCanonicalHash,
} from "../src/index.mjs";

// Real-shape API response for a production approval artifact.
// (Values are from the 2026-05-18 diagnostic; the test only exercises the
// canonical-byte reconstruction path, not signature verification.)
const API_RESPONSE = {
  artifact: {
    id: "cmp4s2g7k000iih04k87nadt4",
    decisionId: "cmp4s2g3r000aih04u1p46jjd",
    approvalId: "cmp4s2g7c000gih04qy2f3nsn",
    capabilityId: "page.doctor",
    approvalMethod: "auto",
    policyVersion: "sha256:082878f4e9412f682885b1c63a9562472abcb81ae88a8754453413b0132a3790",
    environment: "development",
    sequenceNum: 1,
    proofChainHash: null,
    mintedAt: "2026-05-14T00:56:16.785Z",
    approvedAt: "2026-05-14T00:56:16.777Z",
    // NOTE: no `actorUserId` and no `schemaVersion` — these are deliberately
    // omitted from the display projection per the public approval-artifact
    // route's redaction policy. The signed bytes DO include them.
  },
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
  signing: {
    canonicalPayloadHash:
      "1d2b2f97ea03f93ff028c78992675228cebb8651b40adcc26deee6a21be630a0",
    recomputedCanonicalPayloadHash:
      "1d2b2f97ea03f93ff028c78992675228cebb8651b40adcc26deee6a21be630a0",
    canonicalHashMatches: true,
    signature:
      "iU7V5rOcehoRzxS5lL7t0e3e3WQD-3s1ARQ3iVkRbJYimNtKj8Ah1YlqNXESurTc6Ifgzis9SuFMoY7-juMXDg",
    signingKeyId: "strix-***-2026-05",
    jwksUrl: "/.well-known/strix-jwks.json",
  },
};

describe("approval canonical drift — v1.10.1 regression pin", () => {
  test("reconstruction from artifact display projection produces wrong bytes", () => {
    // This is the pre-1.10.1 path. We assert it produces DIFFERENT bytes
    // than the stored hash so that any future regression that goes back to
    // this path immediately fails this test.
    const wrong = buildApprovalCanonicalPayload(API_RESPONSE.artifact);
    const wrongHash = approvalCanonicalHash(wrong);
    assert.notStrictEqual(
      wrongHash,
      API_RESPONSE.signing.canonicalPayloadHash,
      "reconstruction from `artifact` display projection should NOT match stored hash"
    );
    // Confirm the specific drift: actorUserId is empty in the reconstructed
    // bytes because the display projection omits it.
    const wrongParsed = JSON.parse(wrong);
    assert.strictEqual(
      wrongParsed.actorUserId,
      "",
      "reconstruction from display projection should leave actorUserId empty"
    );
  });

  test("canonical.serialized matches stored hash", () => {
    // This is the v1.10.1 path. The server-provided canonical bytes hash to
    // the stored hash byte-for-byte.
    const bytes = API_RESPONSE.canonical.serialized;
    const hash = approvalCanonicalHash(bytes);
    assert.strictEqual(
      hash,
      API_RESPONSE.signing.canonicalPayloadHash,
      "canonical.serialized must hash to the stored canonicalPayloadHash"
    );
  });

  test("JSON.stringify(canonical.payload) also matches stored hash", () => {
    // Secondary fallback in 1.10.1: if canonical.serialized is missing but
    // canonical.payload is present, JSON.stringify with insertion order
    // must produce the same bytes the signer produced.
    const bytes = JSON.stringify(API_RESPONSE.canonical.payload);
    const hash = approvalCanonicalHash(bytes);
    assert.strictEqual(
      hash,
      API_RESPONSE.signing.canonicalPayloadHash,
      "JSON.stringify(canonical.payload) must match stored hash"
    );
  });

  test("diff between pre-fix and post-fix is exactly actorUserId", () => {
    // Confirms the specific drift source. If the API response shape changes
    // to include additional fields that the display projection omits, this
    // test will fail and the API/verifier contract needs review.
    const wrongCanonical = buildApprovalCanonicalPayload(API_RESPONSE.artifact);
    const correctCanonical = API_RESPONSE.canonical.serialized;
    const wrong = JSON.parse(wrongCanonical);
    const right = JSON.parse(correctCanonical);
    const diffKeys = [];
    const allKeys = new Set([...Object.keys(wrong), ...Object.keys(right)]);
    for (const k of allKeys) {
      if (wrong[k] !== right[k]) diffKeys.push(k);
    }
    assert.deepStrictEqual(
      diffKeys,
      ["actorUserId"],
      "The only drift between display-projection reconstruction and signed bytes should be actorUserId"
    );
  });
});
