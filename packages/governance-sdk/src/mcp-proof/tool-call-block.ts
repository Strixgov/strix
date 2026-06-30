/**
 * MC-1 public verify-endpoint extension (ADR-014 §3 / ADR-020 §5).
 *
 * Mirror of `solo_builder.mcp_proof.ToolCallBlock` / `render_tool_call_block`.
 * Returned alongside the canonical payload when an MC-1 artifact exists for
 * the requested evidence. Tri-state `verified` mirrors AA-1's `actorClass`,
 * AA-2's `deviceClass`, and AC-1's `transaction` blocks.
 *
 * Privacy invariant (ADR-020 §5): the public surface NEVER returns
 * `params_hash`, `params_schema_hash`, `result_hash`, `server_signature`,
 * the full attestation records, `plan_hash`, or `mcp_server.attestation`.
 * Only the consumer-relevant summary leaves the bundle.
 */

import type {
  ExecutionStatus,
  MC1Reason,
  McpProofRecord,
  McpProofVerificationResult,
  MCPServerKind,
  ToolRiskTier,
} from "./types.js";

export interface ToolCallBlock {
  server_id: string;
  server_kind: MCPServerKind;
  tool_name: string;
  risk_tier: ToolRiskTier;
  status: ExecutionStatus;
  verified: boolean | null;
  verification_reason: MC1Reason | null;
}

/**
 * Build the public `toolCall` block.
 *   - record null → null (no MC-1 artifact; the endpoint omits the block).
 *   - valid → verified=true, reason=null.
 *   - reason === mc1_mcp_server_check_unavailable → verified=null + reason
 *     (substrate-error tri-state per ADR-020 §5).
 *   - any other invalid result → verified=false + reason.
 *
 * Throws when `record` is provided but `result` is null (the public endpoint
 * must verify before rendering).
 */
export function renderToolCallBlock(
  record: McpProofRecord | null,
  result: McpProofVerificationResult | null,
): ToolCallBlock | null {
  if (record === null) return null;
  if (result === null) {
    throw new Error(
      "renderToolCallBlock: result is required when record is provided (verify before rendering)",
    );
  }

  const payload = record.payload;
  let verified: boolean | null;
  let reason: MC1Reason | null;
  if (result.valid) {
    verified = true;
    reason = null;
  } else if (result.reason === "mc1_mcp_server_check_unavailable") {
    // Substrate-error tri-state: structurally valid, but rule 9's substrate
    // (the mcp_server resolver) was unreachable.
    verified = null;
    reason = result.reason;
  } else {
    verified = false;
    reason = result.reason ?? null;
  }

  return {
    server_id: payload.mcp_server.id,
    server_kind: payload.mcp_server.kind,
    tool_name: payload.tool_call.tool_name,
    risk_tier: payload.tool_call.risk_tier,
    status: payload.execution_receipt.status,
    verified,
    verification_reason: reason,
  };
}

export function toolCallBlockToDict(block: ToolCallBlock): Record<string, unknown> {
  return {
    server_id: block.server_id,
    server_kind: block.server_kind,
    tool_name: block.tool_name,
    risk_tier: block.risk_tier,
    status: block.status,
    verified: block.verified,
    verification_reason: block.verification_reason,
  };
}
