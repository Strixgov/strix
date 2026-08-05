// Verification contract — the public shape `verify()` promises and the
// scenario matrix it must distinguish.
//
// WHY THIS EXISTS. The verifier reported three booleans and one status word.
// That is enough to answer "did this pass?" and not enough to answer "why
// not?", and the gap had a real cost: an unresolvable signing key and a
// tampered payload both came out as "not VERIFIED", and the CLI printed
// "the record may have been tampered with" for both. Only one of those is
// tampering; the other is a verifier that was handed the wrong JWKS. Telling
// an auditor a valid record was tampered with is a worse failure than
// reporting nothing.
//
// Every case below runs against a REAL local HTTP server standing in for the
// public proof + JWKS endpoints, with REAL Ed25519 keys and REAL signatures
// over the REAL canonical payload. Nothing is stubbed at the crypto layer.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";

import {
  verify,
  buildCanonicalPayload,
  VERIFICATION_REASONS,
  CHAIN_REASONS,
} from "../src/index.mjs";

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { publicKey, privateKey, x: raw.toString("base64url") };
}

function jwk(kid, x) {
  return { kty: "OKP", crv: "Ed25519", kid, use: "sig", x };
}

/** A Console-form SE v1 record with every field the canonical builder reads. */
function baseRecord(overrides = {}) {
  return {
    schemaVersion: "1",
    evidenceId: "5686",
    evidenceHash: "ab".repeat(32),
    proofChainHash: "cd".repeat(32),
    capabilityId: "admin.updateMemberRole",
    action: "allow",
    actorId: "user_123",
    actorRole: "owner",
    createdAt: "2026-07-31T12:00:00.000Z",
    signingKeyId: "strix-prod-2026-06",
    environment: "production",
    tenantId: "academy prod",
    regulatoryContext: {
      complianceMode: "eu_ai_act",
      euAiActArticle12: true,
      euAiActArticle14: true,
      euAiActArticle28: true,
    },
    sourceApp: "strix-console",
    ...overrides,
  };
}

function sign(record, privateKey) {
  const canonical = buildCanonicalPayload(record);
  return crypto
    .sign(null, Buffer.from(canonical, "utf8"), privateKey)
    .toString("base64url");
}

/**
 * Stands up the two endpoints `verify()` talks to. `proof` maps evidenceId to
 * a record (or null for 404); `keys` is the JWKS key array.
 */
async function startFakeStrix({ proof = {}, keys = [], jwksStatus = 200 } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/.well-known/strix-jwks.json")) {
      res.writeHead(jwksStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ _meta: { contractVersion: 2 }, keys }));
      return;
    }
    // Mirrors fetchEvidence()'s real target: GET /api/proof/<id>.
    const m = req.url.match(/^\/api\/proof\/([^/?]+)/);
    const id = m ? decodeURIComponent(m[1]) : null;
    const record = id ? proof[id] : null;
    if (!record) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", message: "No record found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(record));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    opts: { proofBase: base, jwksBase: base },
    cleanup: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ─── the matrix ──────────────────────────────────────────────────────────────

test("VERIFIED: a genuinely signed record reports every contract field", async () => {
  const kp = makeKeypair();
  const record = baseRecord();
  record.signature = sign(record, kp.privateKey);

  const ctx = await startFakeStrix({
    proof: { 5686: record },
    keys: [jwk("strix-prod-2026-06", kp.x)],
  });
  try {
    const r = await verify("5686", ctx.opts);
    assert.equal(r.verificationStatus, "VERIFIED");
    assert.equal(r.verificationReason, "SIGNATURE_VALID");
    assert.equal(r.verificationReasonText, VERIFICATION_REASONS.SIGNATURE_VALID);
    assert.equal(r.signatureValid, true);
    assert.equal(r.signaturePresent, true);
    assert.equal(r.signatureAlgorithm, "Ed25519");
    assert.equal(r.recordType, "signed_evidence_v1");
    assert.equal(r.schemaVersion, "1");
    assert.equal(r.error, null);
  } finally {
    await ctx.cleanup();
  }
});

test("chainValid is null with a reason — never a fabricated boolean", async () => {
  const kp = makeKeypair();
  const record = baseRecord();
  record.signature = sign(record, kp.privateKey);

  const ctx = await startFakeStrix({
    proof: { 5686: record },
    keys: [jwk("strix-prod-2026-06", kp.x)],
  });
  try {
    const r = await verify("5686", ctx.opts);
    // Chain linkage is a property of a record PAIR. Single-record verification
    // structurally cannot establish it, so `false` would be a lie and `true`
    // would be worse. null + a reason is the only honest answer.
    assert.equal(r.chainValid, null);
    assert.equal(r.chainReason, CHAIN_REASONS.NOT_CHECKED_SINGLE_RECORD);
  } finally {
    await ctx.cleanup();
  }
});

test("SIGNING_KEY_UNKNOWN is UNVERIFIABLE, never COMPLIANCE_VIOLATION", async () => {
  const signer = makeKeypair();
  const other = makeKeypair();
  const record = baseRecord();
  record.signature = sign(record, signer.privateKey);

  // The JWKS advertises a DIFFERENT kid: this verifier simply has not been
  // given the key. The record may be perfectly valid elsewhere.
  const ctx = await startFakeStrix({
    proof: { 5686: record },
    keys: [jwk("strix-prod-2020-01", other.x)],
  });
  try {
    const r = await verify("5686", ctx.opts);
    assert.equal(r.verificationStatus, "UNVERIFIABLE");
    assert.equal(r.verificationReason, "SIGNING_KEY_UNKNOWN");
    assert.notEqual(r.verificationStatus, "COMPLIANCE_VIOLATION");
    // And it must not be reported as a failed signature check, because no
    // signature check ever ran.
    assert.equal(r.signatureValid, false);
    assert.equal(r.signatureAlgorithm, null);
  } finally {
    await ctx.cleanup();
  }
});

test("SIGNATURE_INVALID: a tampered payload with a resolvable key", async () => {
  const kp = makeKeypair();
  const record = baseRecord();
  record.signature = sign(record, kp.privateKey);
  // Tamper AFTER signing — the classic attack.
  record.action = "deny";

  const ctx = await startFakeStrix({
    proof: { 5686: record },
    keys: [jwk("strix-prod-2026-06", kp.x)],
  });
  try {
    const r = await verify("5686", ctx.opts);
    assert.equal(r.verificationStatus, "COMPLIANCE_VIOLATION");
    assert.equal(r.verificationReason, "SIGNATURE_INVALID");
    assert.equal(r.signatureValid, false);
    // The key DID resolve, so the algorithm is known and reported.
    assert.equal(r.signatureAlgorithm, "Ed25519");
  } finally {
    await ctx.cleanup();
  }
});

test("UNSUPPORTED_ALGORITHM: a non-Ed25519 JWK is never used to verify", async () => {
  const kp = makeKeypair();
  const record = baseRecord();
  record.signature = sign(record, kp.privateKey);

  const ctx = await startFakeStrix({
    proof: { 5686: record },
    keys: [{ kty: "EC", crv: "P-256", kid: "strix-prod-2026-06", use: "sig", x: "AAAA", y: "BBBB" }],
  });
  try {
    const r = await verify("5686", ctx.opts);
    assert.equal(r.verificationStatus, "UNVERIFIABLE");
    assert.equal(r.verificationReason, "UNSUPPORTED_ALGORITHM");
    assert.equal(r.signatureValid, false);
  } finally {
    await ctx.cleanup();
  }
});

test("LEGACY_UNSIGNED: reported honestly, chain marked not-applicable", async () => {
  const record = baseRecord({ signature: null, signingKeyId: null });
  const ctx = await startFakeStrix({ proof: { 41: record }, keys: [] });
  try {
    const r = await verify("41", ctx.opts);
    assert.equal(r.verificationStatus, "LEGACY_UNSIGNED");
    assert.equal(r.verificationReason, "LEGACY_UNSIGNED");
    assert.equal(r.recordType, "legacy_unsigned");
    assert.equal(r.signaturePresent, false);
    assert.equal(r.chainValid, null);
    assert.equal(r.chainReason, CHAIN_REASONS.NOT_APPLICABLE_UNSIGNED);
  } finally {
    await ctx.cleanup();
  }
});

test("key rotation: a record signed by a retired key still verifies while the key is retained", async () => {
  const retired = makeKeypair();
  const active = makeKeypair();

  const oldRecord = baseRecord({ evidenceId: "100", signingKeyId: "strix-prod-2026-05" });
  oldRecord.signature = sign(oldRecord, retired.privateKey);
  const newRecord = baseRecord({ evidenceId: "200", signingKeyId: "strix-prod-2026-06" });
  newRecord.signature = sign(newRecord, active.privateKey);

  // Both keys served — the 2-year retention contract in action.
  const ctx = await startFakeStrix({
    proof: { 100: oldRecord, 200: newRecord },
    keys: [jwk("strix-prod-2026-05", retired.x), jwk("strix-prod-2026-06", active.x)],
  });
  try {
    assert.equal((await verify("100", ctx.opts)).verificationStatus, "VERIFIED");
    assert.equal((await verify("200", ctx.opts)).verificationStatus, "VERIFIED");
  } finally {
    await ctx.cleanup();
  }

  // Drop the retired key: the historical record becomes UNVERIFIABLE, NOT
  // invalid. Retention failure must never read as tampering.
  const ctx2 = await startFakeStrix({
    proof: { 100: oldRecord },
    keys: [jwk("strix-prod-2026-06", active.x)],
  });
  try {
    const r = await verify("100", ctx2.opts);
    assert.equal(r.verificationStatus, "UNVERIFIABLE");
    assert.equal(r.verificationReason, "SIGNING_KEY_UNKNOWN");
  } finally {
    await ctx2.cleanup();
  }
});

test("mixed legacy + signed records verify independently in one JWKS context", async () => {
  const kp = makeKeypair();
  const signed = baseRecord({ evidenceId: "5686" });
  signed.signature = sign(signed, kp.privateKey);
  const legacy = baseRecord({ evidenceId: "12", signature: null, signingKeyId: null });

  const ctx = await startFakeStrix({
    proof: { 5686: signed, 12: legacy },
    keys: [jwk("strix-prod-2026-06", kp.x)],
  });
  try {
    assert.equal((await verify("5686", ctx.opts)).verificationStatus, "VERIFIED");
    assert.equal((await verify("12", ctx.opts)).verificationStatus, "LEGACY_UNSIGNED");
  } finally {
    await ctx.cleanup();
  }
});

test("RECORD_NOT_FOUND and TRANSPORT_ERROR are distinguished, and neither implies invalid", async () => {
  const ctx = await startFakeStrix({ proof: {}, keys: [] });
  let notFound;
  try {
    notFound = await verify("does-not-exist", ctx.opts);
  } finally {
    await ctx.cleanup();
  }
  assert.equal(notFound.verificationStatus, "ERROR");
  assert.equal(notFound.verificationReason, "RECORD_NOT_FOUND");

  // Server is now closed: a genuine transport failure.
  const dead = await verify("5686", ctx.opts);
  assert.equal(dead.verificationStatus, "ERROR");
  assert.equal(dead.verificationReason, "TRANSPORT_ERROR");
  assert.notEqual(dead.verificationReason, "RECORD_NOT_FOUND");
});

test("every emitted reason code is in the published registry", async () => {
  const kp = makeKeypair();
  const record = baseRecord();
  record.signature = sign(record, kp.privateKey);
  const ctx = await startFakeStrix({
    proof: { 5686: record },
    keys: [jwk("strix-prod-2026-06", kp.x)],
  });
  try {
    const r = await verify("5686", ctx.opts);
    // The registry is public contract: a consumer switching on reason codes
    // must be able to enumerate them without reading the implementation.
    assert.ok(Object.prototype.hasOwnProperty.call(VERIFICATION_REASONS, r.verificationReason));
    for (const [code, text] of Object.entries(VERIFICATION_REASONS)) {
      assert.equal(typeof text, "string", `${code} must document itself`);
      assert.ok(text.length > 20, `${code} description is too thin to act on`);
    }
  } finally {
    await ctx.cleanup();
  }
});
