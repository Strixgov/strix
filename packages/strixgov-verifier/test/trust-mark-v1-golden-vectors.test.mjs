/**
 * TM-1 (trust_mark_grant_v1) cross-language conformance.
 *
 * Locks the @strixgov/verifier TS port against the schema authority's golden
 * corpus (solo-builder-core vectors/trust_mark_grant_v1/, vendored under
 * test/fixtures/). Conformance contract (vectors README §"Conformance contract"):
 *   1. Reproduce every vector's canonical_bytes_hex byte-for-byte (SCJ v1).
 *   2. Verify every positive (TM-1 treated ACTIVE), incl. a real Ed25519 check
 *      for pos-07 against the pinned public key.
 *   3. Produce the named failing_rule + reason for every verify-time negative.
 *   4. Reject every construction-time negative (Mapping-input port: rejection
 *      surfaces at the mapped structural rule).
 *   5. With TM-1 ACTIVE (the shipped default, ADR-029 §6 promotion), the base
 *      positive verifies under the bundled status; an explicit
 *      capabilityActive:false still fails closed at rule 4.
 *
 * Source of truth: solo-builder-core/vectors/trust_mark_grant_v1/. Re-sync the
 * vendored copy when the corpus regenerates.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  verifyTrustMarkGrant,
  ed25519PublicKeyFromRawHex,
  scjCanonicalize,
  TM1_REASON,
} from "../src/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, "fixtures", "trust_mark_grant_v1");
const index = JSON.parse(fs.readFileSync(path.join(CORPUS, "index.json"), "utf8"));

// A throwaway real Ed25519 public key for the non-real vectors, whose signature
// is stubbed `() => true` — mirrors the Python harness injecting a fake
// SignatureVerifier. pos-07 uses the real verifier + the pinned key.
const DUMMY_KEY = crypto.generateKeyPairSync("ed25519").publicKey;

function loadVector(rel) {
  return JSON.parse(fs.readFileSync(path.join(CORPUS, rel), "utf8"));
}

test("corpus manifest is the 21-vector TM-1 set (14-field payload, 0.7.0)", () => {
  assert.equal(index.capability_id, "TM-1");
  assert.equal(index.schema_version, "trust_mark_grant_v1");
  assert.equal(index.vectors.length, 21);
});

for (const meta of index.vectors) {
  test(`TM-1 ${meta.vector_id}`, () => {
    const v = loadVector(meta.relative_path);
    const rec = v.record ?? v.record_dict; // construction negatives use record_dict
    assert.ok(rec && rec.payload, "vector carries a record/record_dict with payload");

    // (1) Canonical byte-parity (SCJ v1 / CJ-1) — the core of the contract.
    const canonicalHex = Buffer.from(scjCanonicalize(rec.payload), "utf8").toString("hex");
    assert.equal(canonicalHex, v.canonical_bytes_hex, "canonical_bytes_hex byte-parity");
    const hash = crypto.createHash("sha256").update(Buffer.from(canonicalHex, "hex")).digest("hex");
    assert.equal(hash, v.payload_hash_sha256, "payload_hash_sha256 parity");

    const vi = v.verification_inputs;
    const isReal = vi.signing_key != null;
    const opts = {
      verifiedAt: vi.verified_at,
      boundGrantId: vi.bound_grant_id ?? undefined,
      boundSurfaceOrigin: vi.bound_surface_origin ?? undefined,
      coverageStatus: vi.coverage_status,
      revocationStatus: vi.revocation_status,
      capabilityActive: true, // corpus verifies with TM-1 ACTIVE (contract pt 2/3)
      ...(isReal
        ? { resolvePublicKey: () => ed25519PublicKeyFromRawHex(vi.signing_key.public_key_hex) }
        : { resolvePublicKey: () => DUMMY_KEY, verifySignatureFn: () => true }),
    };

    const res = verifyTrustMarkGrant(rec, opts);

    if (meta.category === "positive") {
      assert.equal(res.valid, true, `positive must verify (got reason=${res.reason} @ rule=${res.failingRule})`);
    } else if (v.expected.rejects_at_construction) {
      assert.equal(res.valid, false, "construction-time negative must be rejected");
    } else {
      assert.equal(res.valid, false, "verify-time negative must fail");
      assert.equal(res.failingRule, v.expected.failing_rule, "failing_rule matches corpus");
      assert.equal(res.reason, v.expected.reason, "reason matches corpus");
    }
  });
}

// Contract point 5 (post ADR-029 §6 promotion): TM-1 is ACTIVE in the shipped
// default, so the base positive verifies under the bundled status — and rule 4
// still fails closed when a caller explicitly forces the capability inactive
// (the fail-closed logic is preserved, it is just no longer the shipped default).
test("TM-1 ACTIVE is the shipped default — base positive verifies; explicit capabilityActive:false still fails rule 4", () => {
  const v = loadVector("positive/01-governed-agent.json");
  const base = {
    resolvePublicKey: () => DUMMY_KEY,
    verifySignatureFn: () => true,
    verifiedAt: v.verification_inputs.verified_at,
  };

  // Default (capabilityActive omitted → bundled status ACTIVE) → verifies.
  const dflt = verifyTrustMarkGrant(v.record, base);
  assert.equal(dflt.valid, true, `ACTIVE default must verify (got reason=${dflt.reason} @ rule=${dflt.failingRule})`);

  // Explicit opt-out → the rule-4 fail-closed path still fires.
  const off = verifyTrustMarkGrant(v.record, { ...base, capabilityActive: false });
  assert.equal(off.valid, false);
  assert.equal(off.failingRule, "capability");
  assert.equal(off.reason, TM1_REASON.CAPABILITY_NOT_ACTIVE);
});

// Defensive: the real-signature vector verifies, and a single flipped nibble of
// the signature is rejected as tm1_signature_invalid (real Ed25519, no stub).
test("TM-1 pos-07 real signature: genuine verifies, tampered rejected", () => {
  const v = loadVector("positive/07-real-ed25519-signature.json");
  const key = ed25519PublicKeyFromRawHex(v.verification_inputs.signing_key.public_key_hex);
  const base = { resolvePublicKey: () => key, verifiedAt: v.verification_inputs.verified_at, capabilityActive: true };

  const ok = verifyTrustMarkGrant(v.record, base);
  assert.equal(ok.valid, true, "real signature verifies");

  const tampered = JSON.parse(JSON.stringify(v.record));
  const sig = tampered.signature;
  tampered.signature = sig.slice(0, -1) + (sig.slice(-1) === "0" ? "1" : "0");
  const bad = verifyTrustMarkGrant(tampered, base);
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, TM1_REASON.SIGNATURE_INVALID);
});

// Producer ↔ consumer hex loop: a grant signed the way scripts/sign-trust-mark-grant.mjs
// signs it (Ed25519 over SCJ v1 canonical bytes, HEX per ADR-029 §1) verifies here.
// Pins the signature ENCODING — a base64url signature (the pre-ADR-029 mint bug)
// must NOT verify, which is what closes the producer/consumer split.
test("TM-1 producer↔consumer: a freshly hex-signed grant verifies; base64url does not", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const payload = { ...loadVector("positive/01-governed-agent.json").record.payload, grant_id: "tm-grant-roundtrip" };
  const canonical = Buffer.from(scjCanonicalize(payload), "utf8");
  const signatureHex = crypto.sign(null, canonical, privateKey).toString("hex");
  assert.match(signatureHex, /^[0-9a-fA-F]{128}$/, "Ed25519 signature is 128 hex chars");

  const base = { resolvePublicKey: () => publicKey, capabilityActive: true, verifiedAt: "2026-06-12T00:00:00Z" };
  const ok = verifyTrustMarkGrant({ payload, signature: signatureHex, kid: "strix-prod-2026-06", created_at: "2026-06-16T00:00:00Z" }, base);
  assert.equal(ok.valid, true, `freshly hex-signed grant verifies (got ${ok.reason})`);

  const signatureB64 = crypto.sign(null, canonical, privateKey).toString("base64url");
  const wrongEnc = verifyTrustMarkGrant({ payload, signature: signatureB64, kid: "strix-prod-2026-06", created_at: "2026-06-16T00:00:00Z" }, base);
  assert.equal(wrongEnc.valid, false, "a base64url-encoded signature must be rejected — hex is the contract");
  assert.equal(wrongEnc.reason, TM1_REASON.SIGNATURE_INVALID);
});
