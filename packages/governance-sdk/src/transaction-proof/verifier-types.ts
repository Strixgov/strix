/**
 * Pluggable crypto/resolver protocols for the AC-1 verifier.
 *
 * Mirrors the `SignatureVerifier` / `JwksResolver` Protocols the Python
 * reference injects. Keeping crypto pluggable means the same verifier runs
 * with a real Ed25519 verifier server-side and a WebCrypto one client-side,
 * and the conformance corpus can replay with an `AlwaysGood` fake (exactly
 * as `test_golden_vectors_ac1.py` does).
 */

/** Verifies a detached signature over `payload` bytes with a raw public key. */
export interface SignatureVerifier {
  verify(payload: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
}

/** Resolves an origin-scoped `(iss, kid)` to a raw public key, or null. */
export interface JwksResolver {
  publicKey(iss: string, kid: string): Uint8Array | null;
}
