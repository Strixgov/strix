/**
 * Test helper — mint execution_authorization_v1 tokens.
 *
 * This mirrors what mcp-adapter's signer would do once Phase 2 (token
 * issuance wiring) ships. Lives in test/_helpers/ so it's not part of
 * the validator's public surface — the validator should never depend
 * on a signer.
 */

import crypto from "node:crypto";
import { canonicalizeJSON } from "../../src/canonical-json.mjs";

export { canonicalizeJSON };

export function generateKeypair(kid = "test-key-2026-05") {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const jwk = {
    kid,
    kty: "OKP",
    crv: "Ed25519",
    x: rawPub.toString("base64url"),
  };
  return { privateKey, publicKey, kid, jwk };
}

/** Build the 11-field payload from defaults + overrides. Defaults yield a valid token. */
export function buildPayload(overrides = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000);
  return {
    schemaVersion: 1,
    authorizationId: "exa_" + crypto.randomBytes(10).toString("hex"),
    decisionId: "dec_" + crypto.randomBytes(8).toString("hex"),
    capabilityId: "mcp.notion.update_page",
    actorId: "agent-claude-1",
    actorClass: "agent",
    payloadHash: "sha256:" + crypto.randomBytes(32).toString("hex"),
    tenantId: "acme-corp",
    environment: "prod",
    nonce: crypto.randomBytes(16).toString("base64url"),
    issuedAt: now.toISOString().replace(/\.\d+Z$/, "Z"),
    expiresAt: expiresAt.toISOString().replace(/\.\d+Z$/, "Z"),
    ...overrides,
  };
}

/** Sign a payload, returning the full object-form token (payload + signingKeyId + signature). */
export function signToken(payload, { privateKey, kid }) {
  const canonical = canonicalizeJSON(payload);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf-8"), privateKey);
  return { ...payload, signingKeyId: kid, signature: sig.toString("base64url") };
}

/** Encode an object-form token into the on-wire HTTP header format from spec §6.2. */
export function encodeHeader(token) {
  const { signature, ...payloadPlusKid } = token;
  // signingKeyId is part of the canonical payload in the header form (spec §6.2).
  const canonical = canonicalizeJSON(payloadPlusKid);
  const payloadB64 = Buffer.from(canonical, "utf-8").toString("base64url");
  return `${payloadB64}.${signature}`;
}

/** Convenience: in-memory burnNonce that records what was burned. */
export function makeMemoryBurner() {
  const burned = new Set();
  return {
    burned,
    burnNonce: async (nonce) => {
      if (burned.has(nonce)) return false;
      burned.add(nonce);
      return true;
    },
  };
}

/** Convenience: a JWKS with one key. */
export function makeJwks(jwk) {
  return { keys: [jwk] };
}
