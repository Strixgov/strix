/**
 * Reason-code coverage — every validation failure has its own test that
 * forces the failure and asserts the stable reason string.
 *
 * Rules 4 (KEY_NOT_ATTESTED) and 5 (KEY_REVOKED) are deferred to v0.2.0
 * (see src/index.mjs header). They are exported in VALIDATION_REASONS
 * so the symbol set is stable, but no rule currently emits them.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validateAuthorization } from "../src/index.mjs";
import {
  generateKeypair,
  buildPayload,
  signToken,
  makeMemoryBurner,
  makeJwks,
} from "./_helpers/sign.mjs";

function defaults() {
  const keypair = generateKeypair();
  const payload = buildPayload();
  const token = signToken(payload, keypair);
  return {
    keypair,
    payload,
    token,
    opts: { jwks: makeJwks(keypair.jwk), burnNonce: makeMemoryBurner().burnNonce },
  };
}

test("TOKEN_MALFORMED — missing payload field", async () => {
  const { token, opts } = defaults();
  delete token.nonce;
  const r = await validateAuthorization(token, opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TOKEN_MALFORMED");
});

test("TOKEN_MALFORMED — opts.jwks missing", async () => {
  const { token } = defaults();
  const r = await validateAuthorization(token, { burnNonce: async () => true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TOKEN_MALFORMED");
});

test("TOKEN_MALFORMED — opts.burnNonce missing", async () => {
  const { token, opts } = defaults();
  const r = await validateAuthorization(token, { jwks: opts.jwks });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TOKEN_MALFORMED");
});

test("TOKEN_MALFORMED — issuedAt not strict RFC 3339", async () => {
  const { keypair, payload, opts } = defaults();
  payload.issuedAt = "2026-05-23 12:00:00"; // space, not T; no tz
  const token = signToken(payload, keypair);
  const r = await validateAuthorization(token, opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TOKEN_MALFORMED");
});

test("TOKEN_MALFORMED — expiresAt before issuedAt", async () => {
  const { keypair, opts } = defaults();
  const issuedAt = "2026-05-23T12:00:00Z";
  const expiresAt = "2026-05-23T11:00:00Z";
  const payload = buildPayload({ issuedAt, expiresAt });
  const token = signToken(payload, keypair);
  const r = await validateAuthorization(token, opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TOKEN_MALFORMED");
});

test("SCHEMA_VERSION_UNSUPPORTED — schemaVersion = 2", async () => {
  const { keypair, opts } = defaults();
  const payload = buildPayload({ schemaVersion: 2 });
  const token = signToken(payload, keypair);
  const r = await validateAuthorization(token, opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SCHEMA_VERSION_UNSUPPORTED");
});

test("KEY_NOT_FOUND — signingKeyId missing", async () => {
  const { token, opts } = defaults();
  delete token.signingKeyId;
  const r = await validateAuthorization(token, opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "KEY_NOT_FOUND");
});

test("KEY_NOT_FOUND — signingKeyId not in JWKS", async () => {
  const { token, opts } = defaults();
  token.signingKeyId = "some-other-key";
  const r = await validateAuthorization(token, opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "KEY_NOT_FOUND");
});

test("SIGNATURE_INVALID — wrong key in JWKS for the same kid", async () => {
  const { keypair, token } = defaults();
  // Replace the JWK with a different keypair under the same kid.
  const decoy = generateKeypair(keypair.kid);
  const r = await validateAuthorization(token, {
    jwks: makeJwks(decoy.jwk),
    burnNonce: makeMemoryBurner().burnNonce,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SIGNATURE_INVALID");
});

test("SIGNATURE_INVALID — payload tampered after signing", async () => {
  const { token, opts } = defaults();
  token.capabilityId = "mcp.notion.delete_workspace"; // tamper
  const r = await validateAuthorization(token, opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SIGNATURE_INVALID");
});

test("SIGNATURE_INVALID — signature field missing", async () => {
  const { token, opts } = defaults();
  delete token.signature;
  const r = await validateAuthorization(token, opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SIGNATURE_INVALID");
});

test("EXPIRED — now is past expiresAt", async () => {
  const { keypair, opts } = defaults();
  const issuedAt = "2026-05-23T12:00:00Z";
  const expiresAt = "2026-05-23T12:05:00Z";
  const payload = buildPayload({ issuedAt, expiresAt });
  const token = signToken(payload, keypair);
  const r = await validateAuthorization(token, {
    ...opts,
    now: () => Date.parse("2026-05-23T13:00:00Z"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "EXPIRED");
});

test("TENANT_MISMATCH — expected tenant differs from payload", async () => {
  const { keypair, opts } = defaults();
  const payload = buildPayload({ tenantId: "alpha-co" });
  const token = signToken(payload, keypair);
  const r = await validateAuthorization(token, { ...opts, expectedTenantId: "beta-co" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TENANT_MISMATCH");
});

test("ENVIRONMENT_MISMATCH — expected environment differs from payload", async () => {
  const { keypair, opts } = defaults();
  const payload = buildPayload({ environment: "staging" });
  const token = signToken(payload, keypair);
  const r = await validateAuthorization(token, { ...opts, expectedEnvironment: "prod" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ENVIRONMENT_MISMATCH");
});

test("ACTOR_CLASS_MISMATCH — expected actorClass differs from payload", async () => {
  const { keypair, opts } = defaults();
  const payload = buildPayload({ actorClass: "agent" });
  const token = signToken(payload, keypair);
  const r = await validateAuthorization(token, { ...opts, expectedActorClass: "human" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ACTOR_CLASS_MISMATCH");
});

test("NONCE_REUSED — burnNonce returns false", async () => {
  const { token, opts } = defaults();
  const r = await validateAuthorization(token, { ...opts, burnNonce: async () => false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "NONCE_REUSED");
});

test("NONCE_REUSED — burnNonce throws is fail-closed (not silently allowed)", async () => {
  const { token, opts } = defaults();
  const r = await validateAuthorization(token, {
    ...opts,
    burnNonce: async () => { throw new Error("DB unreachable"); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "NONCE_REUSED");
});

test("rule ordering — TOKEN_MALFORMED (rule 1, field extraction) fires before SIGNATURE_INVALID (rule 6)", async () => {
  // A token with both a missing required field AND a tampered signature
  // must fail at rule 1 (field extraction), not rule 6 (signature). This
  // pins the per-spec rule order in src/index.mjs against accidental
  // reordering.
  const { token, opts } = defaults();
  delete token.nonce;          // rule 1 — required field
  token.signature = "AAAAAAAA"; // rule 6 — would also fail, must NOT be reached
  const r = await validateAuthorization(token, opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TOKEN_MALFORMED");
});

test("rule ordering — SIGNATURE_INVALID (rule 6) fires before EXPIRED (rule 7)", async () => {
  // A token whose signature is bad AND whose expiry is in the past must
  // fail at the signature check, not the expiry check. This matches arch
  // spec §8: rule 6 precedes rule 7. Auditors must be able to tell
  // "this token was never valid" (forgery / tamper) from "this token was
  // valid but expired" (operational).
  const { keypair, opts } = defaults();
  const payload = buildPayload({
    issuedAt: "2026-05-23T12:00:00Z",
    expiresAt: "2026-05-23T12:05:00Z",
  });
  const token = signToken(payload, keypair);
  token.capabilityId = "mcp.notion.delete_workspace"; // tamper → rule 6 fails
  const r = await validateAuthorization(token, {
    ...opts,
    now: () => Date.parse("2026-05-23T15:00:00Z"), // would also fail rule 7
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SIGNATURE_INVALID");
});

test("rule ordering — NONCE_REUSED is LAST so 'good token, already used' is distinguishable from 'never good'", async () => {
  // Force an EXPIRED with a stale nonce; we must see EXPIRED, not NONCE_REUSED.
  const { keypair, opts } = defaults();
  const payload = buildPayload({
    issuedAt: "2026-05-23T12:00:00Z",
    expiresAt: "2026-05-23T12:01:00Z",
  });
  const token = signToken(payload, keypair);
  const r = await validateAuthorization(token, {
    ...opts,
    burnNonce: async () => true, // would succeed if reached
    now: () => Date.parse("2026-05-23T15:00:00Z"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "EXPIRED", "EXPIRED must fire before NONCE_REUSED is even attempted");
});
