/**
 * Happy-path round-trip: mint a token, validate, burn the nonce, and
 * confirm a second validation fails with NONCE_REUSED.
 *
 * This is the canonical Mode 3 lifecycle in one test.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validateAuthorization, validateAuthorizationFromHeader } from "../src/index.mjs";
import {
  generateKeypair,
  buildPayload,
  signToken,
  encodeHeader,
  makeMemoryBurner,
  makeJwks,
} from "./_helpers/sign.mjs";

test("object-form: valid token validates, returns the bound fields, then NONCE_REUSED on replay", async () => {
  const keypair = generateKeypair();
  const payload = buildPayload();
  const token = signToken(payload, keypair);
  const { burnNonce, burned } = makeMemoryBurner();
  const jwks = makeJwks(keypair.jwk);

  const r1 = await validateAuthorization(token, { jwks, burnNonce });
  assert.equal(r1.ok, true, `expected ok=true; got ${JSON.stringify(r1)}`);
  assert.equal(r1.authorizationId, payload.authorizationId);
  assert.equal(r1.actorId, payload.actorId);
  assert.equal(r1.capabilityId, payload.capabilityId);
  assert.equal(r1.payloadHash, payload.payloadHash);
  assert.equal(r1.expiresAt, payload.expiresAt);
  assert.equal(burned.has(payload.nonce), true);

  const r2 = await validateAuthorization(token, { jwks, burnNonce });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "NONCE_REUSED");
});

test("header-form: valid token validates and the parsed envelope round-trips", async () => {
  const keypair = generateKeypair();
  const payload = buildPayload();
  const token = signToken(payload, keypair);
  const headerValue = encodeHeader(token);

  const { burnNonce } = makeMemoryBurner();
  const jwks = makeJwks(keypair.jwk);

  const r = await validateAuthorizationFromHeader(headerValue, { jwks, burnNonce });
  assert.equal(r.ok, true, `expected ok=true; got ${JSON.stringify(r)}`);
  assert.equal(r.authorizationId, payload.authorizationId);
});

test("tenant + environment binding succeed when matched", async () => {
  const keypair = generateKeypair();
  const payload = buildPayload({ tenantId: "alpha-co", environment: "staging" });
  const token = signToken(payload, keypair);

  const r = await validateAuthorization(token, {
    jwks: makeJwks(keypair.jwk),
    expectedTenantId: "alpha-co",
    expectedEnvironment: "staging",
    burnNonce: makeMemoryBurner().burnNonce,
  });
  assert.equal(r.ok, true);
});

test("the returned authorizationId can be carried into a downstream execution_receipt_v1 linkage", async () => {
  // Sanity: the validator surfaces the authorizationId in a shape mcp-adapter
  // can attach to its post-hoc receipt (arch spec §9 linkage).
  const keypair = generateKeypair();
  const payload = buildPayload();
  const token = signToken(payload, keypair);
  const r = await validateAuthorization(token, {
    jwks: makeJwks(keypair.jwk),
    burnNonce: makeMemoryBurner().burnNonce,
  });
  assert.equal(r.ok, true);
  assert.match(r.authorizationId, /^exa_/);
});
