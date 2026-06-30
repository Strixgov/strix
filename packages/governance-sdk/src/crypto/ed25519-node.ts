/**
 * node:crypto-backed Ed25519 `SignatureVerifier` + map-based key resolvers.
 *
 * The production/server signature verifier the AC-1 and proof_bundle_v2
 * verifiers inject (the conformance corpora replay envelope + authority
 * signatures with *real* keys). A browser/edge build supplies a
 * WebCrypto-backed equivalent against the same interfaces.
 *
 * Raw 32-byte Ed25519 public keys are wrapped as an OKP JWK so node can
 * build the KeyObject without DER plumbing; verify is synchronous (RFC 8032
 * deterministic).
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export interface RawSignatureVerifier {
  verify(payload: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
}

function keyObjectFromRaw(publicKey: Uint8Array) {
  const x = Buffer.from(publicKey).toString("base64url");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

/** Real Ed25519 verification, fail-closed: any error → false, never throws. */
export const nodeEd25519Verifier: RawSignatureVerifier = {
  verify(payload, signature, publicKey) {
    try {
      if (publicKey.length !== 32) return false;
      return cryptoVerify(null, Buffer.from(payload), keyObjectFromRaw(publicKey), Buffer.from(signature));
    } catch {
      return false;
    }
  },
};

/** Resolve `kid` (or origin-scoped `(origin, kid)`) → raw key from a hex map. */
export class MapJwksResolver {
  private readonly keys: Map<string, Uint8Array>;
  constructor(hexByKid: Record<string, string>) {
    this.keys = new Map(Object.entries(hexByKid).map(([k, hex]) => [k, Buffer.from(hex, "hex")]));
  }
  publicKey(kid: string, _origin?: string): Uint8Array | null {
    return this.keys.get(kid) ?? null;
  }
}

/** Resolve an attestation-authority name → raw key from a hex map. */
export class MapAuthorityResolver {
  private readonly keys: Map<string, Uint8Array>;
  constructor(hexByAuthority: Record<string, string>) {
    this.keys = new Map(Object.entries(hexByAuthority).map(([k, hex]) => [k, Buffer.from(hex, "hex")]));
  }
  authorityPublicKey(authority: string): Uint8Array | null {
    return this.keys.get(authority) ?? null;
  }
}
