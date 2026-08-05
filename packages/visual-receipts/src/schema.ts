/**
 * Visual Receipt v1 — schema (docs/specs/visual-receipt-v1.md §4).
 *
 * The human-readable projection of a verification result. Every field is
 * derived from signed canonical bytes or from the verifier's verdict — never
 * from arbitrary UI props (Gate E / EVI-2). `verificationStatus: "VERIFIED"`
 * is only ever produced from a verifier result whose `valid === true` (VR-2).
 */

export type VisualReceiptSourceType =
  | "SE_V1"
  | "MC_1"
  | "AC_1"
  | "APPROVAL_ARTIFACT";

/** Reconciled with ADR-017 `TriStateColor`; the renderer adds none of its own (VR-8). */
export type TriStateColor = "GREEN" | "RED" | "YELLOW" | "SLATE";

export type VerificationStatus =
  | "VERIFIED"
  | "INVALID"
  | "LEGACY_UNSIGNED"
  | "UNVERIFIABLE"
  | "SAMPLE_LOCAL"
  | "PENDING";

export type DecisionStatus = "ALLOW" | "DENY" | "INTERCEPT" | "APPROVAL_REQUIRED";

export type ExecutionStatusLabel =
  | "NOT_ATTEMPTED"
  | "EXECUTED"
  | "BLOCKED"
  | "FAILED"
  | "NOT_SENT"
  | "DRAFT_ONLY";

/** Explicit render lifecycle states (Gate G). A failed render never looks like a control success. */
export type VisualRenderStatus =
  | "VISUAL_RENDERED"
  | "VISUAL_RENDER_FAILED"
  | "VISUAL_PENDING"
  | "VISUAL_NOT_AVAILABLE"
  | "VISUAL_REDACTED";

export interface VisualReceiptProof {
  verificationStatus: VerificationStatus;
  color: TriStateColor;
  hashValid: boolean | null;
  chainValid: boolean | null;
  signaturePresent: boolean;
  signatureValid: boolean | null;
  /** Present iff INVALID. Stable reason code, never free-text. */
  failingRule?: string;
  reason?: string;
  issuer?: string;
  /** Env segment scrubbed for public surfaces (§6). */
  kid?: string;
  algorithm?: "Ed25519";
}

export interface VisualReceiptControl {
  policyVersion?: string;
  reason?: string;
  tokenRequired?: boolean;
  tokenConsumed?: boolean;
  humanApprovalRequired?: boolean;
}

export interface VisualReceiptV1 {
  visualReceiptVersion: "1.0";
  sourceType: VisualReceiptSourceType;
  sourceId: string;
  sourceHash: string;

  title: string;
  summary: string;

  capabilityId: string;
  actionLabel: string;
  decisionStatus: DecisionStatus;
  executionStatus: ExecutionStatusLabel;

  proof: VisualReceiptProof;
  control: VisualReceiptControl;

  verificationUrl: string;
  renderedAt: string;
  /** sha256 over the manifest with `renderHash` omitted — makes a render reproducible (VR-9). */
  renderHash?: string;
}
