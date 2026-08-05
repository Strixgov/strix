/**
 * SE v1 → Visual Receipt mapper (docs/specs/visual-receipt-v1.md §5).
 *
 * Pure: `(record, verdict, opts) → VisualReceiptV1`. The verdict comes from
 * `@strixgov/verifier` (SE v1 two-layer model: signatureValid + hash/chain +
 * deployment context). The mapper never verifies — it projects a verdict it is
 * handed, so VERIFIED only ever comes from a real `signatureValid === true`.
 */

import type { VisualReceiptV1, DecisionStatus, ExecutionStatusLabel } from "./schema.js";
import { deriveProofState } from "./proofState.js";

/** Structural mirror of an SE v1 signed-evidence record — the subset the mapper reads.
 *  A real evidence row satisfies this by shape (no verifier runtime dep). */
export interface SignedEvidenceView {
  evidenceId: string;
  evidenceHash: string;
  capabilityId: string;
  action: string;
  signingKeyId?: string;
  signature?: string;
  iss?: string;
}

/** Structural mirror of the SE v1 verifier result (two-layer model). */
export interface SignedEvidenceVerdict {
  /** Layer 1 — cryptographic validity. `true` VERIFIED, `false` INVALID, `null` unknown. */
  signatureValid: boolean | null;
  signaturePresent: boolean;
  /** `true` for the LEGACY_UNSIGNED cohort (records signed before SE v1). */
  legacyUnsigned?: boolean;
  hashValid?: boolean | null;
  chainValid?: boolean | null;
  /** Could the signing key be resolved from the JWKS? */
  keyResolvable?: boolean;
}

export interface MapSignedEvidenceOptions {
  sampleLocal?: boolean;
  baseUrl?: string;
  decisionStatus?: DecisionStatus;
  executionStatus?: ExecutionStatusLabel;
  policyVersion?: string;
}

export function mapSignedEvidenceToVisualReceipt(
  record: SignedEvidenceView,
  verdict: SignedEvidenceVerdict | null | undefined,
  opts: MapSignedEvidenceOptions = {},
): VisualReceiptV1 {
  const baseUrl = (opts.baseUrl ?? "https://www.strixgov.com").replace(/\/+$/, "");

  // Legacy-unsigned records have no signature: deriveProofState yields
  // LEGACY_UNSIGNED for signaturePresent=false, which is exactly the honest state.
  const signaturePresent = verdict ? verdict.signaturePresent && !verdict.legacyUnsigned : Boolean(record.signature);

  const proof = deriveProofState({
    verdict: verdict ? { valid: verdict.signatureValid === true } : undefined,
    signaturePresent,
    keyResolvable: verdict?.keyResolvable ?? true,
    sampleLocal: opts.sampleLocal,
    hashValid: verdict?.hashValid ?? null,
    chainValid: verdict?.chainValid ?? null,
    issuer: record.iss,
    kid: record.signingKeyId,
  });

  return {
    visualReceiptVersion: "1.0",
    sourceType: "SE_V1",
    sourceId: record.evidenceId,
    sourceHash: record.evidenceHash,
    title: `Governed Action — ${record.action}`,
    summary: `A governed action (${record.action}) recorded signed evidence under ${record.capabilityId}.`,
    capabilityId: record.capabilityId,
    actionLabel: record.action,
    // SE v1 evidence is recorded after evaluation; the action was admitted and
    // (by default) executed. Callers override when the evidence is for a
    // blocked/drafted action — decision and execution stay separate (VR-5).
    decisionStatus: opts.decisionStatus ?? "ALLOW",
    executionStatus: opts.executionStatus ?? "EXECUTED",
    proof,
    control: {
      policyVersion: opts.policyVersion,
    },
    verificationUrl: `${baseUrl}/api/public/verify?hash=${encodeURIComponent(record.evidenceHash)}`,
    renderedAt: new Date(0).toISOString(),
  };
}
