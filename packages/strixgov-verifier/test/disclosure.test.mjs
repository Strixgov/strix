/**
 * Disclosure-bundle verification — cross-implementation conformance.
 *
 * The constants below are the PRODUCER's locked golden vectors
 * (solo-builder-core/tests/run-commitment-v1.test.ts). This suite replays
 * them through the verifier's zero-shared-code re-implementation; any drift
 * between the two Merkle/canonicalization implementations fails here first
 * (the conformance-program discipline). Locked values are never updated to
 * make a failing test pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  DISCLOSURE_REASONS,
  rootFromInclusionPath,
  verifyDisclosureBundle,
} from "../src/disclosure.mjs";

// TEST-ONLY key (seed = 32×0x07) — same as the producer goldens, never a prod key.
const TEST_PKCS8_B64 = "MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
const testPub = createPublicKey(
  createPrivateKey({ key: Buffer.from(TEST_PKCS8_B64, "base64"), format: "der", type: "pkcs8" }),
);
const jwk = { ...testPub.export({ format: "jwk" }), kid: "strix-test-golden-v1" };
const JWKS = { keys: [jwk] };

const LEAVES = [
  "a".repeat(64),
  "b".repeat(64),
  "0123456789abcdef".repeat(4),
  "f".repeat(64),
  "1".repeat(64),
];
const GOLDEN_ROOT = "e27fecfa9e5c4402196268b705d42a1f99b17b71cd54787ddda458bbe0183e24";
const GOLDEN_SIG =
  "gQyj+MGvTfd570yUPLH0hMeI95v9Ytm62xdGA2ugrG9c+7eNuCVkiO0D+am8Wu5rvk/1sbkZ+ULhUilDW6VuBA==";
const GOLDEN_PATH_2 = [
  "5e16d316ecd5773e50c3b02737d424192b02f25b4245822079181c557aafda7d",
  "03938e2c8f758e6cae443d499b41c899c373eb0c0198bae61796a069f2b05904",
  "4635e1fa62a599a7880a8d14a56f720a1d40f6e5448ab5a5e39bedc8bd87fa8e",
];

function goldenBundle() {
  return {
    bundleVersion: 1,
    commitment: {
      payload: {
        schemaVersion: 1,
        commitmentId: "rc_golden_0001",
        runId: "run_golden_0001",
        runKind: "swarm_run",
        tenantId: "tenant-golden",
        environment: "test",
        leafCount: 5,
        rootHash: GOLDEN_ROOT,
        leafHashAlgorithm: "sha256-rfc6962",
        committedAt: "2026-07-22T00:00:00Z",
      },
      signature: GOLDEN_SIG,
      signatureAlgorithm: "Ed25519",
      signingKeyId: "strix-test-golden-v1",
    },
    disclosed: [
      {
        leafIndex: 2,
        leafHash: LEAVES[2],
        inclusionPath: [...GOLDEN_PATH_2],
        record: { evidenceHash: LEAVES[2], action: "refund.issue", amount: 42 },
        contentAddressField: "evidenceHash",
      },
    ],
  };
}

const recordOk = () => "VERIFIED";

test("cross-impl conformance: own merkle walk re-derives the producer's locked root", () => {
  assert.equal(rootFromInclusionPath(LEAVES[2], 2, 5, GOLDEN_PATH_2), GOLDEN_ROOT);
});

test("golden bundle verifies; completeness is structurally NOT_PROVEN (SD-1)", () => {
  const res = verifyDisclosureBundle(goldenBundle(), { jwks: JWKS, recordVerifier: recordOk });
  assert.equal(res.verdict, "VERIFIED");
  assert.equal(res.completeness, "NOT_PROVEN");
  assert.deepEqual(res.perRecord, [
    { leafIndex: 2, verdict: "VERIFIED", reason: DISCLOSURE_REASONS.OK },
  ]);
});

test("SD-5: no JWKS → UNVERIFIABLE (never INVALID)", () => {
  const res = verifyDisclosureBundle(goldenBundle(), { recordVerifier: recordOk });
  assert.equal(res.verdict, "UNVERIFIABLE");
  assert.ok(res.reasons.includes(DISCLOSURE_REASONS.KEY_UNRESOLVED));
});

test("tampered commitment payload → INVALID signature", () => {
  const b = goldenBundle();
  b.commitment.payload.tenantId = "tenant-swapped";
  const res = verifyDisclosureBundle(b, { jwks: JWKS, recordVerifier: recordOk });
  assert.equal(res.verdict, "INVALID");
  assert.ok(res.reasons.includes(DISCLOSURE_REASONS.SIGNATURE_INVALID));
});

test("grafted inclusion path → INVALID ROOT_MISMATCH", () => {
  const b = goldenBundle();
  b.disclosed[0].inclusionPath[0] = "9".repeat(64);
  const res = verifyDisclosureBundle(b, { jwks: JWKS, recordVerifier: recordOk });
  assert.equal(res.verdict, "INVALID");
  assert.equal(res.perRecord[0].reason, DISCLOSURE_REASONS.ROOT_MISMATCH);
});

test("swapped record → INVALID LEAF_RECORD_MISMATCH", () => {
  const b = goldenBundle();
  b.disclosed[0].record.evidenceHash = "d".repeat(64);
  const res = verifyDisclosureBundle(b, { jwks: JWKS, recordVerifier: recordOk });
  assert.equal(res.verdict, "INVALID");
  assert.equal(res.perRecord[0].reason, DISCLOSURE_REASONS.LEAF_RECORD_MISMATCH);
});

test("SD-4: planted verified fields are ignored; validity is re-derived", () => {
  const b = goldenBundle();
  b.verified = true;
  b.commitment.verified = true;
  b.disclosed[0].record.verified = true;
  b.disclosed[0].inclusionPath.reverse();
  const res = verifyDisclosureBundle(b, { jwks: JWKS, recordVerifier: recordOk });
  assert.equal(res.verdict, "INVALID");
});

test("unrecognized record without an override caps at UNVERIFIABLE, never assumed valid", () => {
  const res = verifyDisclosureBundle(goldenBundle(), { jwks: JWKS });
  assert.equal(res.verdict, "UNVERIFIABLE");
  assert.equal(res.perRecord[0].reason, DISCLOSURE_REASONS.RECORD_UNRECOGNIZED);
});

test("malformed envelope fails closed: SCHEMA_INVALID", () => {
  const res = verifyDisclosureBundle({ bundleVersion: 2 }, { jwks: JWKS });
  assert.equal(res.verdict, "INVALID");
  assert.deepEqual(res.reasons, [DISCLOSURE_REASONS.SCHEMA_INVALID]);
});
