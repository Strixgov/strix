/**
 * MC-1 → Visual Receipt mapper (docs/specs/visual-receipt-v1.md §5).
 *
 * Pure: `(record, verdict, opts) → VisualReceiptV1`. It never calls the verifier
 * itself — it receives the verdict, so the only field that can read `VERIFIED`
 * comes from a real `verifyMcpProof` result (compose via `verifyAndRender`).
 */

import type { VisualReceiptV1, ExecutionStatusLabel, DecisionStatus } from "./schema.js";
import { deriveProofState, type Verdict } from "./proofState.js";

/** Structural mirror of `@strixgov/sdk/mcp-proof` `McpProofRecord` — the subset the
 *  mapper reads. A real `McpProofRecord` satisfies this by shape (no SDK runtime dep). */
export interface McpProofRecordView {
  payload: {
    evidence_id: string;
    capability_id: string;
    iss: string;
    plan_hash: string;
    tool_call: { tool_name: string; risk_tier: string; params_hash: string };
    execution_receipt: { status: "success" | "failed" | "cancelled" };
  };
  signature: string;
  kid: string;
}

export interface MapMc1Options {
  /** Could the public key be resolved from the JWKS? */
  keyResolvable: boolean;
  /** Signed by a demo/local key, not a published production key. */
  sampleLocal?: boolean;
  /** Base URL for the public verification surface. */
  baseUrl?: string;
  /** Did this governed call require (and is it still awaiting) human approval? */
  humanApprovalRequired?: boolean;
  /** Override the executed/decision framing when the call was drafted-not-sent. */
  notSent?: boolean;
}

const EXEC_LABEL: Record<string, ExecutionStatusLabel> = {
  success: "EXECUTED",
  failed: "FAILED",
  cancelled: "BLOCKED",
};

export function mapMc1ToVisualReceipt(
  record: McpProofRecordView,
  verdict: Verdict | null | undefined,
  opts: MapMc1Options,
): VisualReceiptV1 {
  const p = record.payload;
  const baseUrl = (opts.baseUrl ?? "https://www.strixgov.com").replace(/\/+$/, "");

  const proof = deriveProofState({
    verdict,
    signaturePresent: Boolean(record.signature),
    keyResolvable: opts.keyResolvable,
    sampleLocal: opts.sampleLocal,
    issuer: p.iss,
    kid: record.kid,
  });

  // MC-1 records *executed/allowed* calls, not decisions (the schema has no
  // decision field). A drafted-not-sent call is an ALLOW whose execution did not
  // happen — decision and execution are shown separately (P-2 / VR-5).
  const executionStatus: ExecutionStatusLabel = opts.notSent
    ? "NOT_SENT"
    : EXEC_LABEL[p.execution_receipt.status] ?? "NOT_ATTEMPTED";
  const decisionStatus: DecisionStatus = opts.humanApprovalRequired
    ? "APPROVAL_REQUIRED"
    : "ALLOW";

  return {
    visualReceiptVersion: "1.0",
    sourceType: "MC_1",
    sourceId: p.evidence_id,
    sourceHash: p.plan_hash, // bound canonical anchor; replaced by canonical-bytes hash in slice 2
    title: `Tool Action — ${p.tool_call.tool_name}`,
    summary: `A governed agent invoked ${p.tool_call.tool_name} (${p.tool_call.risk_tier} risk).`,
    capabilityId: p.capability_id,
    actionLabel: p.tool_call.tool_name,
    decisionStatus,
    executionStatus,
    proof,
    control: {
      tokenRequired: p.tool_call.risk_tier === "critical" || p.tool_call.risk_tier === "high",
      humanApprovalRequired: opts.humanApprovalRequired ?? false,
    },
    verificationUrl: `${baseUrl}/proof/mc1/${encodeURIComponent(p.evidence_id)}`,
    renderedAt: new Date(0).toISOString(), // deterministic default; caller may override
  };
}
