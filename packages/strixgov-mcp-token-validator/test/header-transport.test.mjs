/**
 * Header-transport tests for Posture B (proxy / network egress gating).
 *
 * Wire format from arch spec §6.2:
 *   <base64url(canonical-json-payload)>.<base64url(signature)>
 *
 * The header form embeds `signingKeyId` inside the canonical payload
 * (not as a separate envelope field). The validator must lift it back
 * out for the JWKS resolution step.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validateAuthorizationFromHeader } from "../src/index.mjs";
import {
  generateKeypair,
  buildPayload,
  signToken,
  encodeHeader,
  makeMemoryBurner,
  makeJwks,
  canonicalizeJSON,
} from "./_helpers/sign.mjs";

test("header-form happy path round-trips through encode → validate", async () => {
  const keypair = generateKeypair();
  const payload = buildPayload();
  const token = signToken(payload, keypair);
  const headerValue = encodeHeader(token);

  const r = await validateAuthorizationFromHeader(headerValue, {
    jwks: makeJwks(keypair.jwk),
    burnNonce: makeMemoryBurner().burnNonce,
  });
  assert.equal(r.ok, true, `expected ok=true; got ${JSON.stringify(r)}`);
});

test("TOKEN_MALFORMED — header missing the dot separator", async () => {
  const r = await validateAuthorizationFromHeader("no-dot-here", {
    jwks: { keys: [] },
    burnNonce: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TOKEN_MALFORMED");
});

test("TOKEN_MALFORMED — empty header", async () => {
  const r = await validateAuthorizationFromHeader("", {
    jwks: { keys: [] },
    burnNonce: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TOKEN_MALFORMED");
});

test("TOKEN_MALFORMED — payload segment not valid base64url-decodable JSON", async () => {
  const r = await validateAuthorizationFromHeader("!!!.!!!", {
    jwks: { keys: [] },
    burnNonce: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TOKEN_MALFORMED");
});

test("CANONICALIZATION_DRIFT — on-wire payload bytes don't match SCJ v1 reserialization", async () => {
  // Construct a payload with extra whitespace; canonicalizer would
  // re-emit without whitespace; the on-wire bytes won't match.
  const keypair = generateKeypair();
  const payload = buildPayload();
  const token = signToken(payload, keypair);
  const nonCanonicalJson =
    "{ " + JSON.stringify({ ...payload, signingKeyId: keypair.kid }).slice(1);
  const payloadB64 = Buffer.from(nonCanonicalJson, "utf-8").toString("base64url");
  const headerValue = `${payloadB64}.${token.signature}`;

  const r = await validateAuthorizationFromHeader(headerValue, {
    jwks: makeJwks(keypair.jwk),
    burnNonce: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "CANONICALIZATION_DRIFT");
});

test("CANONICALIZATION_DRIFT — reordered keys on the wire (semantically equal, byte-different)", async () => {
  // Critical attack class: same JSON values, different byte order.
  // Without the byte-equality check, an attacker could submit a
  // semantically-equal payload with keys in a different order; the
  // canonicalizer would produce the same canonical form (and signature
  // would verify against THAT) — so the validator's defense is the
  // on-wire bytes must already be canonical.
  const keypair = generateKeypair();
  const payload = buildPayload();
  const tokenObj = signToken(payload, keypair);

  // Build a non-canonically-ordered payload (z-first instead of byte-sorted).
  const reordered = {};
  for (const k of Object.keys({ ...payload, signingKeyId: keypair.kid }).reverse()) {
    reordered[k] = ({ ...payload, signingKeyId: keypair.kid })[k];
  }
  const reorderedJson = JSON.stringify(reordered);
  const canonical = canonicalizeJSON({ ...payload, signingKeyId: keypair.kid });
  assert.notEqual(
    reorderedJson,
    canonical,
    "vector setup: reordered bytes must differ from canonical bytes",
  );
  const payloadB64 = Buffer.from(reorderedJson, "utf-8").toString("base64url");
  const headerValue = `${payloadB64}.${tokenObj.signature}`;

  const r = await validateAuthorizationFromHeader(headerValue, {
    jwks: makeJwks(keypair.jwk),
    burnNonce: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "CANONICALIZATION_DRIFT");
});
