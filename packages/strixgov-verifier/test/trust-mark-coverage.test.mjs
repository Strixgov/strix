/**
 * TM-1 — independent rule-9 coverage + 0.6.0↔0.7.0 schema tolerance.
 *
 * Locks the contract-0.7.0 additions to the @strixgov/verifier TS port:
 *   - resolveTrustMarkCoverageFromGrant re-derives coverage from a real signed
 *     heartbeat using the grant's SIGNED comparands (kernel_policy_hash +
 *     coverage_window_seconds) and SIGNED heartbeat key — covered / not_covered
 *     (policy drift, stale, future, grant mismatch, bad sig) / unavailable
 *     (unreachable, malformed). All real Ed25519 + an injected fetch (no network).
 *   - verifyTrustMarkGrant accepts a 14-field (0.7.0) grant AND, transitionally,
 *     a 12-field (legacy 0.6.0) grant; rejects a half-populated comparand pair and
 *     a malformed comparand at the schema rule.
 *
 * Ephemeral keys only; no network; no DB.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  resolveTrustMarkCoverageFromGrant,
  verifyTrustMarkGrant,
  scjCanonicalize,
  TM1_REASON,
  TM1_RULE,
  COVERAGE_STATUS,
} from "../src/index.mjs";

// ── ephemeral key material ──
const AUTHORITY = crypto.generateKeyPairSync("ed25519");
const HEARTBEAT = crypto.generateKeyPairSync("ed25519");
const HB_PUB_B64URL = HEARTBEAT.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
const POLICY = "sha256:" + "1".repeat(64);
const NOW = new Date("2026-06-17T12:00:00Z");
const WINDOW = 3600;

function grantPayload(over = {}) {
  return {
    grant_id: "tm-grant-academy-2026-06",
    capability_id: "TM-1",
    tenant_id: "academy",
    licensee: { licensee_id: "academy-tn", legal_name: "The Academy" },
    mark_class: "governed_agent",
    surface_origin: "https://app.academytn.com",
    heartbeat_key: { kid: "licensee-hb-2026-06", jwk: { kty: "OKP", crv: "Ed25519", x: HB_PUB_B64URL } },
    kernel_policy_hash: POLICY,
    coverage_window_seconds: WINDOW,
    valid_from: "2026-06-15T00:00:00Z",
    valid_until: "2026-09-15T00:00:00Z",
    issued_at: "2026-06-15T00:00:00Z",
    iss: "https://www.strixgov.com",
    environment: "prod",
    ...over,
  };
}

function signedGrant(payload) {
  const sig = crypto.sign(null, Buffer.from(scjCanonicalize(payload), "utf8"), AUTHORITY.privateKey).toString("hex");
  return { payload, signature: sig, kid: "strix-demo-EPHEMERAL", created_at: "2026-06-15T00:00:01Z" };
}

function heartbeat({ policy = POLICY, emittedAt = "2026-06-17T12:00:00Z", grantId = "tm-grant-academy-2026-06", tenantId = "academy" } = {}) {
  const fields = {
    schemaVersion: "trust_mark_heartbeat_v1",
    grantId,
    tenantId,
    licenseeId: "academy-tn",
    kernelPolicyHash: policy,
    chainHeadHash: "sha256:" + "a".repeat(64),
    chainLength: 42,
    emittedAt,
    signingKeyId: "licensee-hb-2026-06",
  };
  const sig = crypto.sign(null, Buffer.from(scjCanonicalize(fields), "utf8"), HEARTBEAT.privateKey).toString("base64url");
  return { ...fields, signature: sig };
}

// fetchImpl returning a fixed doc (or a non-ok status / non-JSON).
const fetchReturning = (doc, { ok = true, status = 200, badJson = false } = {}) =>
  async () => ({ ok, status, json: async () => { if (badJson) throw new Error("not json"); return doc; } });

const resolve = (payload, doc, fetchOpts) =>
  resolveTrustMarkCoverageFromGrant(payload, { fetchImpl: fetchReturning(doc, fetchOpts), now: NOW });

test("coverage COVERED — fresh, in-policy, grant-bound heartbeat", async () => {
  const r = await resolve(grantPayload(), heartbeat());
  assert.equal(r.status, COVERAGE_STATUS.COVERED);
  assert.equal(r.reason, "COVERAGE_OK");
});

test("coverage NOT_COVERED — policy drift (the hollowed-kernel defense)", async () => {
  const r = await resolve(grantPayload(), heartbeat({ policy: "sha256:" + "d".repeat(64) }));
  assert.equal(r.status, COVERAGE_STATUS.NOT_COVERED);
  assert.equal(r.reason, "POLICY_HASH_MISMATCH");
});

test("coverage NOT_COVERED — stale beyond the SIGNED coverage window", async () => {
  const r = await resolve(grantPayload(), heartbeat({ emittedAt: "2026-06-17T10:00:00Z" })); // 2h > 3600s
  assert.equal(r.status, COVERAGE_STATUS.NOT_COVERED);
  assert.equal(r.reason, "HEARTBEAT_STALE");
});

test("coverage NOT_COVERED — future-dated beyond skew (pre-sign replay defense)", async () => {
  const r = await resolve(grantPayload(), heartbeat({ emittedAt: "2026-06-17T12:30:00Z" })); // +30m > 300s
  assert.equal(r.status, COVERAGE_STATUS.NOT_COVERED);
  assert.equal(r.reason, "HEARTBEAT_FROM_FUTURE");
});

test("coverage NOT_COVERED — heartbeat bound to a different grant (cross-licensee replay)", async () => {
  const r = await resolve(grantPayload(), heartbeat({ grantId: "tm-grant-someone-else" }));
  assert.equal(r.status, COVERAGE_STATUS.NOT_COVERED);
  assert.equal(r.reason, "GRANT_MISMATCH");
});

test("coverage NOT_COVERED — signature from the wrong key is DEFINITIVE", async () => {
  const { signature, ...fields } = heartbeat(); // drop the good signature, keep the 9 fields
  const wrongKey = crypto.generateKeyPairSync("ed25519").privateKey;
  const hb = { ...fields, signature: crypto.sign(null, Buffer.from(scjCanonicalize(fields), "utf8"), wrongKey).toString("base64url") };
  const r = await resolve(grantPayload(), hb);
  assert.equal(r.status, COVERAGE_STATUS.NOT_COVERED);
  assert.equal(r.reason, "SIGNATURE_INVALID");
});

test("coverage UNAVAILABLE — surface unreachable (never a fake GREEN, never a false RED)", async () => {
  const r = await resolve(grantPayload(), null, { ok: false, status: 404 });
  assert.equal(r.status, COVERAGE_STATUS.UNAVAILABLE);
  assert.equal(r.reason, "SURFACE_UNREACHABLE");
});

test("coverage UNAVAILABLE — malformed heartbeat document", async () => {
  const r = await resolve(grantPayload(), {}, { badJson: true });
  assert.equal(r.status, COVERAGE_STATUS.UNAVAILABLE);
  assert.equal(r.reason, "HEARTBEAT_MALFORMED");
});

// ── schema tolerance (0.6.0 ↔ 0.7.0 transition) ──
const verifyOpts = { resolvePublicKey: () => AUTHORITY.publicKey, verifiedAt: NOW.toISOString(), capabilityActive: true };

test("schema: a 14-field (0.7.0) grant verifies rules 1–8", () => {
  const r = verifyTrustMarkGrant(signedGrant(grantPayload()), verifyOpts);
  assert.equal(r.valid, true, `expected valid, got ${r.reason} @ ${r.failingRule}`);
});

test("schema: a legacy 12-field (0.6.0) grant still verifies (transitional tolerance)", () => {
  const p = grantPayload();
  delete p.kernel_policy_hash;
  delete p.coverage_window_seconds;
  const r = verifyTrustMarkGrant(signedGrant(p), verifyOpts);
  assert.equal(r.valid, true, `legacy grant should verify, got ${r.reason} @ ${r.failingRule}`);
});

test("schema: exactly one comparand present is malformed", () => {
  const p = grantPayload();
  delete p.coverage_window_seconds; // policy hash present, window absent
  const r = verifyTrustMarkGrant(signedGrant(p), verifyOpts);
  assert.equal(r.valid, false);
  assert.equal(r.failingRule, TM1_RULE.SCHEMA);
  assert.equal(r.reason, TM1_REASON.SCHEMA_MISSING_FIELD);
});

test("schema: a malformed kernel_policy_hash fails at the schema rule", () => {
  const r = verifyTrustMarkGrant(signedGrant(grantPayload({ kernel_policy_hash: "not-a-hash" })), verifyOpts);
  assert.equal(r.failingRule, TM1_RULE.SCHEMA);
  assert.equal(r.reason, TM1_REASON.SCHEMA_MISSING_FIELD);
});

test("schema: a non-positive / boolean coverage_window_seconds fails at the schema rule", () => {
  for (const bad of [0, -5, true, 3.5, "3600"]) {
    const r = verifyTrustMarkGrant(signedGrant(grantPayload({ coverage_window_seconds: bad })), verifyOpts);
    assert.equal(r.failingRule, TM1_RULE.SCHEMA, `window=${JSON.stringify(bad)} should fail schema`);
    assert.equal(r.reason, TM1_REASON.SCHEMA_MISSING_FIELD);
  }
});
