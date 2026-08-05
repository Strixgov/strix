/**
 * Proof-state derivation (docs/specs/visual-receipt-v1.md §3).
 *
 * Mirrors ADR-017 `tri_state_color_for`: the visual state + locked color are a
 * total function of (the verifier's verdict, the signing context). This is the
 * one place that decides a label, and it can only label `VERIFIED` when handed a
 * verdict with `valid === true` (VR-2). The renderer downstream is pure display.
 */

import type { TriStateColor, VerificationStatus, VisualReceiptProof } from "./schema.js";

/** Structural mirror of `@strixgov/sdk` `McpProofVerificationResult` (and the AC-1 sibling).
 *  A real SDK result satisfies this by shape — no runtime dependency on the SDK. */
export interface Verdict {
  valid: boolean;
  failingRule?: string;
  reason?: string;
  detail?: string;
}

export interface ProofStateInput {
  /** The verifier verdict. `null`/`undefined` means verification has not run → PENDING. */
  verdict?: Verdict | null;
  /** Is a signature present on the record at all? `false` → LEGACY_UNSIGNED. */
  signaturePresent: boolean;
  /** Could the public key be resolved from the JWKS? `false` → UNVERIFIABLE (substrate). */
  keyResolvable: boolean;
  /** Signed by a demo/local key rather than a published production key. */
  sampleLocal?: boolean;
  /** Optional signed-evidence sub-results, surfaced separately (P-2 / VR-5). */
  hashValid?: boolean | null;
  chainValid?: boolean | null;
  issuer?: string;
  kid?: string;
}

const COLOR: Record<VerificationStatus, TriStateColor> = {
  VERIFIED: "GREEN",
  INVALID: "RED",
  UNVERIFIABLE: "YELLOW",
  LEGACY_UNSIGNED: "SLATE",
  SAMPLE_LOCAL: "SLATE",
  PENDING: "SLATE",
};

/**
 * Decide the visual verification state. Order matters and is fail-closed: the
 * only path to VERIFIED is a present signature, a resolvable production key, a
 * non-sample context, and a verdict that actually passed.
 */
export function deriveProofState(input: ProofStateInput): VisualReceiptProof {
  const { verdict, signaturePresent, keyResolvable, sampleLocal } = input;

  let status: VerificationStatus;
  if (!signaturePresent) {
    status = "LEGACY_UNSIGNED";
  } else if (verdict == null) {
    status = "PENDING";
  } else if (sampleLocal) {
    // A real, correct signature — but from a demo/local key, not a published
    // production key. Must be visibly labeled and is never VERIFIED in prod (VR-6).
    status = "SAMPLE_LOCAL";
  } else if (!keyResolvable) {
    // Key could not be resolved from the public JWKS: substrate error, not a
    // proof of invalidity. Tri-state verified=null → YELLOW.
    status = "UNVERIFIABLE";
  } else if (verdict.valid === true) {
    status = "VERIFIED";
  } else {
    status = "INVALID";
  }

  const proof: VisualReceiptProof = {
    verificationStatus: status,
    color: COLOR[status],
    hashValid: input.hashValid ?? null,
    chainValid: input.chainValid ?? null,
    signaturePresent,
    signatureValid:
      status === "VERIFIED" ? true : status === "INVALID" ? false : null,
    algorithm: "Ed25519",
  };

  if (status === "INVALID" && verdict) {
    if (verdict.failingRule) proof.failingRule = verdict.failingRule;
    if (verdict.reason) proof.reason = verdict.reason;
  }
  if (input.issuer) proof.issuer = input.issuer;
  if (input.kid) proof.kid = scrubKid(input.kid);
  return proof;
}

/** Env-segment scrub mirroring apps/strix-console/src/lib/proof/redact.ts (§6).
 *  `strix-prod-2026-06` → `strix-***-2026-06`. */
export function scrubKid(kid: string): string {
  return kid.replace(/^(strix)-(prod|dev|staging|test)-(\d{4}-\d{2})$/i, "$1-***-$3");
}
