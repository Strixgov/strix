// trust_mark_revocation_list_v1 (TM-1 rule 10) — sign/verify/resolve + the
// rule-10 integration through verifyTrustMarkGrant.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildTrustMarkRevocationPayload,
  canonicalizeTrustMarkRevocation,
  signTrustMarkRevocationList,
  parseTrustMarkRevocationList,
  verifyTrustMarkRevocationSignature,
  resolveGrantRevocation,
  verifyTrustMarkGrant,
  TM1_REASON,
} from "../src/index.mjs";

const KID = "strix-prod-2026-06";
function authorityKeypair() {
  return crypto.generateKeyPairSync("ed25519");
}

function sampleList(privateKey, grantIds = ["tm-grant-0001", "tm-grant-0002"]) {
  const payload = buildTrustMarkRevocationPayload({
    revoked: grantIds.map((g, i) => ({
      grant_id: g,
      revoked_at: "2026-06-16T00:00:00Z",
      decision_evidence_id: `ev-${i}`,
    })),
    issuedAt: "2026-06-16T00:00:00Z",
    iss: "https://www.strixgov.com",
  });
  return signTrustMarkRevocationList(payload, privateKey, KID);
}

test("build sorts revoked[] by grant_id (deterministic bytes)", () => {
  const { privateKey } = authorityKeypair();
  const doc = sampleList(privateKey, ["tm-grant-zzz", "tm-grant-aaa"]);
  assert.deepEqual(
    doc.payload.revoked.map((e) => e.grant_id),
    ["tm-grant-aaa", "tm-grant-zzz"],
  );
  // canonical is stable + key-sorted
  assert.match(canonicalizeTrustMarkRevocation(doc.payload), /^\{"iss":/); // SCJ sorts: iss < revoked < schema_version
});

test("sign → parse → verify round-trips (hex authority signature)", () => {
  const { privateKey, publicKey } = authorityKeypair();
  const doc = sampleList(privateKey);
  assert.match(doc.signature, /^[0-9a-fA-F]{128}$/);
  const parsed = parseTrustMarkRevocationList(JSON.parse(JSON.stringify(doc)));
  assert.equal(parsed.ok, true);
  assert.equal(verifyTrustMarkRevocationSignature(parsed.value, publicKey), true);
});

test("resolveGrantRevocation is tri-state + fail-closed", () => {
  const { privateKey, publicKey } = authorityKeypair();
  const doc = sampleList(privateKey, ["tm-grant-0001"]);
  const keyOk = () => publicKey;

  assert.equal(resolveGrantRevocation("tm-grant-0001", doc, keyOk), "revoked");
  assert.equal(resolveGrantRevocation("tm-grant-9999", doc, keyOk), "not_revoked");
  // No list → UNAVAILABLE (never silently not_revoked).
  assert.equal(resolveGrantRevocation("tm-grant-0001", null, keyOk), "unavailable");
  // Unknown authority key → UNAVAILABLE.
  assert.equal(resolveGrantRevocation("tm-grant-0001", doc, () => null), "unavailable");
  // Tampered signature → UNAVAILABLE (a tampered list cannot clear OR revoke).
  const tampered = { ...doc, signature: doc.signature.slice(0, -1) + (doc.signature.slice(-1) === "0" ? "1" : "0") };
  assert.equal(resolveGrantRevocation("tm-grant-9999", tampered, keyOk), "unavailable");
  // A grant the wrong-key list "claims" revoked is still UNAVAILABLE (no silent allow either way).
  const otherKey = authorityKeypair().publicKey;
  assert.equal(resolveGrantRevocation("tm-grant-0001", doc, () => otherKey), "unavailable");
});

test("rule 10 integration: a revoked grant → tm1_revoked (not signature-invalid)", () => {
  const grantKey = authorityKeypair().publicKey;
  const grant = {
    payload: {
      capability_id: "TM-1",
      environment: "prod",
      grant_id: "tm-grant-0001",
      heartbeat_key: { jwk: { crv: "Ed25519", kty: "OKP", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }, kid: "hb" },
      iss: "https://www.strixgov.com",
      issued_at: "2026-06-01T00:00:00Z",
      licensee: { legal_name: "X", licensee_id: "lic-x" },
      mark_class: "governed_agent",
      surface_origin: "https://app.example",
      tenant_id: "t-x",
      valid_from: "2026-01-01T00:00:00Z",
      valid_until: "2027-01-01T00:00:00Z",
    },
    signature: "00".repeat(64),
    kid: "strix-prod-2026-06",
  };
  const base = { resolvePublicKey: () => grantKey, verifySignatureFn: () => true, capabilityActive: true, verifiedAt: "2026-06-12T00:00:00Z" };

  assert.equal(verifyTrustMarkGrant(grant, { ...base, revocationStatus: "revoked" }).reason, TM1_REASON.REVOKED);
  assert.equal(verifyTrustMarkGrant(grant, { ...base, revocationStatus: "unavailable" }).reason, TM1_REASON.REVOCATION_CHECK_UNAVAILABLE);
  assert.equal(verifyTrustMarkGrant(grant, { ...base, revocationStatus: "not_revoked" }).valid, true);
  assert.equal(verifyTrustMarkGrant(grant, { ...base, revocationStatus: null }).valid, true); // opt-in: skipped
});

test("parse rejects a non-hex signature + bad schema_version", () => {
  const { privateKey } = authorityKeypair();
  const doc = sampleList(privateKey);
  assert.equal(parseTrustMarkRevocationList({ ...doc, signature: "not-hex" }).ok, false);
  assert.equal(
    parseTrustMarkRevocationList({ ...doc, payload: { ...doc.payload, schema_version: "wrong" } }).ok,
    false,
  );
});
