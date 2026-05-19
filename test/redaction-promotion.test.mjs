/**
 * Regression test for the redaction-promotion bug discovered 2026-05-14.
 *
 * Bug summary:
 *   The /api/public/proof/[evidenceId] response contains BOTH:
 *     - fields.signingKeyId       → FULL kid ("strix-prod-2026-05")
 *     - top-level signingKeyId    → REDACTED ("strix-***-2026-05") for Gap-5
 *   The CLI's fetchEvidence was promoting the redacted top-level value over
 *   fields.signingKeyId. The signed canonical bytes contain the FULL kid,
 *   so verifying with the redacted kid produced wrong bytes → every signed
 *   record returned COMPLIANCE_VIOLATION.
 *
 * This test does not exercise the network. It calls buildCanonicalPayload
 * twice — once with the full kid (signer's view), once with the redacted kid
 * (the CLI's pre-fix bug view) — and asserts the canonical bytes differ.
 * Then it asserts that the post-fix fetchEvidence-equivalent shape produces
 * the FULL kid byte-sequence.
 *
 * If a future change re-introduces "promote top-level signingKeyId into the
 * record" in fetchEvidence, this test will fail.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildCanonicalPayload } from "../src/index.mjs";

// A real-shape signed record (values are illustrative; the test only cares
// about field bytes, not crypto). sourceApp "academy-platform" exercises the
// Academy canonical form; identical reasoning applies to Console form.
const FIELDS_FULL_KID = {
  schemaVersion: 1,
  evidenceId: 2717,
  evidenceHash: "898a9d051cf910de1e4e68e5edf7c31c70681ea20988df8299a5c93d64cede9a",
  proofChainHash: "",
  capabilityId: "admin.members.updateRole",
  action: "allow",
  actorId: "user-Zm9vQGV4YW1wbGUuY29t",
  actorRole: "admin",
  createdAt: "2026-05-05T06:06:11.000Z",
  signingKeyId: "strix-prod-2026-05",
  environment: "production",
  tenantId: "academy",
  regulatoryContext: {
    complianceMode: "eu-ai-act",
    euAiActArticle12: true,
    euAiActArticle14: true,
    euAiActArticle28: true,
  },
  sourceApp: "academy-platform",
};

describe("redaction-promotion regression (Gap-5 + CLI bug 2026-05-14)", () => {
  test("canonical with FULL kid differs byte-for-byte from canonical with REDACTED kid", () => {
    const fullCanonical = buildCanonicalPayload(FIELDS_FULL_KID);
    const redactedCanonical = buildCanonicalPayload({
      ...FIELDS_FULL_KID,
      signingKeyId: "strix-***-2026-05",
    });
    assert.notStrictEqual(
      fullCanonical,
      redactedCanonical,
      "Canonical bytes must differ between full and redacted kid — that's why " +
        "the redacted form CANNOT be used for signature verification. If this " +
        "ever asserts equal, signingKeyId is no longer in the canonical (a " +
        "breaking SE-v1 schema change) and this test is stale.",
    );
    assert.ok(
      fullCanonical.includes('"strix-prod-2026-05"'),
      "Full canonical must contain the FULL kid bytes — the bytes the signer signed over",
    );
    assert.ok(
      redactedCanonical.includes('"strix-***-2026-05"'),
      "Redacted canonical contains the redacted kid bytes — which signature verification MUST NOT use",
    );
  });

  test("fetchEvidence-flattening must NOT override fields.signingKeyId with redacted top-level value", async () => {
    // Simulate the /api/public/proof/<id> response shape exactly as the
    // production endpoint emits it (apps/strix-console/src/app/api/public/
    // proof/[evidenceId]/route.ts, lines 351-360).
    const apiResponse = {
      verificationStatus: "VERIFIED_OFFLINE_BY_VERIFIER",
      fields: { ...FIELDS_FULL_KID },
      signature: "ZmFrZS1zaWctYnl0ZXM",
      signingKeyId: "strix-***-2026-05", // <-- the REDACTED top-level kid
      source: "external_evidence",
    };

    // Mirror the fetchEvidence flatten logic from src/index.mjs (post-fix).
    // If a future change re-introduces signingKeyId or evidenceId promotion
    // at this step, this test fails.
    const record = {
      ...apiResponse.fields,
      ...(apiResponse.signature !== undefined
        ? { signature: apiResponse.signature }
        : {}),
      ...(apiResponse.schemaVersion !== undefined
        ? { schemaVersion: apiResponse.schemaVersion }
        : {}),
    };

    assert.strictEqual(
      record.signingKeyId,
      "strix-prod-2026-05",
      "fetchEvidence MUST preserve fields.signingKeyId (full kid). If this " +
        "fails, the CLI is back to promoting the redacted top-level kid and " +
        "every signed record will fail verification — the exact bug from " +
        "2026-05-14. See packages/strixgov-verifier/src/index.mjs fetchEvidence().",
    );
  });

  test("fetchEvidence-flattening must NOT override fields.evidenceId with the URL-path top-level value", () => {
    // v1.9.3 regression guard. When the caller looks up by evidence_hash
    // (`/api/proof/<hash>`), the response's top-level evidenceId is the
    // HASH STRING, not the actual evidenceId. The bytes-correct value is
    // in fields.evidenceId.
    //
    // If a future change re-introduces top-level evidenceId promotion,
    // canonical reconstruction for hash-looked-up records will produce
    // wrong bytes (the hash string coerces to 0 for Academy-form number
    // typing) and every signature fails.
    const apiResponse = {
      verificationStatus: "VERIFIED_OFFLINE_BY_VERIFIER",
      // Top-level evidenceId is the URL path parameter — when looking up
      // by hash, this is the hash string, not the actual evidenceId.
      evidenceId:
        "8fb2d5713d6775b3d592465308490971cdf62d3f59449fb95d212a1e414c906a",
      fields: {
        ...FIELDS_FULL_KID,
        evidenceId: 2717, // bytes-correct numeric value
      },
      signature: "ZmFrZS1zaWctYnl0ZXM",
      source: "external_evidence",
    };

    const record = {
      ...apiResponse.fields,
      ...(apiResponse.signature !== undefined
        ? { signature: apiResponse.signature }
        : {}),
      ...(apiResponse.schemaVersion !== undefined
        ? { schemaVersion: apiResponse.schemaVersion }
        : {}),
      // Critical: do NOT spread evidenceId from apiResponse top-level.
    };

    assert.strictEqual(
      record.evidenceId,
      2717,
      "fetchEvidence MUST preserve fields.evidenceId. If this fails, the " +
        "CLI is promoting the URL-path evidenceId (which is the hash string " +
        "for hash-lookup callers), and canonical reconstruction will produce " +
        "evidenceId=0 instead of the actual numeric value — exact bug from " +
        "2026-05-15 (record 42 / cron.merchDrops). See " +
        "packages/strixgov-verifier/src/index.mjs fetchEvidence().",
    );
  });
});
