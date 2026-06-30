/**
 * proof_bundle_v2 verification types + pluggable resolver protocols.
 * Mirror of `solo_builder.bundle_verifier`.
 */

export type VerificationStatus = "VERIFIED" | "INVALID" | "LEGACY_UNSIGNED";

export type FailingStep =
  | "envelope"
  | "decision"
  | "execution_receipt"
  | "actor_attestation"
  | "tool_call_receipts";

export interface SubResult {
  name: string;
  passed: boolean;
  error?: string | null;
}

export interface VerificationResult {
  status: VerificationStatus;
  failingStep?: FailingStep | null;
  failingIndex?: number | null;
  error?: string | null;
  subResults: SubResult[];
}

/** Pluggable Ed25519 verification — payload/signature/key as raw bytes. */
export interface SignatureVerifier {
  verify(payload: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
}

/**
 * Pluggable JWKS lookup. The unscoped form is `publicKey(kid)`; the
 * post-ADR-011 origin-scoped form passes `origin` (the envelope `iss`). A
 * resolver MAY honor both — the verifier calls the scoped form when the
 * envelope carries an `iss`.
 */
export interface JwksResolver {
  publicKey(kid: string, origin?: string): Uint8Array | null;
}

/** Pluggable attestation-authority key lookup (authority name → raw key). */
export interface AttestationAuthorityResolver {
  authorityPublicKey(authority: string): Uint8Array | null;
}
