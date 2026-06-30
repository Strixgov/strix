/**
 * Reconstruct an `McpProofRecord` from its on-wire dict view.
 *
 * Mirror of `_record_from_view` in `tests/test_golden_vectors.py` and
 * `from_json_ld`'s parsing. Validation happens in the same order as the
 * Python reference so construction-time negatives surface the same first
 * error: the sub-records (`McpServer` / `ToolCall` / `ExecutionReceipt`) are
 * built before the payload, then `makeMcpProofPayload` enforces the MC-1 §1
 * invariants (capability id, agent-class pair, server-id cross-binding).
 *
 * The nested AA-1 / AA-2 records reuse the shared `aa1FromView` / `aa2FromView`
 * reconstructors from the transaction-proof module — the same on-wire shape.
 */

import {
  makeExecutionReceipt,
  makeMcpProofPayload,
  makeMcpProofRecord,
  makeMcpServer,
  makeToolCall,
  type ExecutionStatus,
  type McpProofPayload,
  type McpProofRecord,
  type MCPServerKind,
  type ToolRiskTier,
} from "./types.js";
import { aa1FromView, aa2FromView } from "../transaction-proof/parse.js";

type Dict = Record<string, any>;

export function payloadFromView(p: Dict): McpProofPayload {
  const principal = aa1FromView(p.principal_attestation);
  const agent = aa1FromView(p.agent_attestation);
  const device = p.device_attestation === null ? null : aa2FromView(p.device_attestation);

  const mcpServer = makeMcpServer(
    p.mcp_server.id,
    p.mcp_server.kind as MCPServerKind,
    p.mcp_server.attestation,
  );
  const toolCall = makeToolCall(
    p.tool_call.server_id,
    p.tool_call.tool_name,
    p.tool_call.risk_tier as ToolRiskTier,
    p.tool_call.params_hash,
    p.tool_call.params_schema_hash,
  );
  const executionReceipt = makeExecutionReceipt(
    p.execution_receipt.status as ExecutionStatus,
    p.execution_receipt.result_hash,
    p.execution_receipt.server_signature,
    p.execution_receipt.started_at,
    p.execution_receipt.completed_at,
  );

  return makeMcpProofPayload({
    evidence_id: p.evidence_id,
    principal_attestation: principal,
    agent_attestation: agent,
    device_attestation: device,
    plan_hash: p.plan_hash,
    capability_id: p.capability_id,
    tenant_id: p.tenant_id,
    mcp_server: mcpServer,
    tool_call: toolCall,
    execution_receipt: executionReceipt,
    attested_at: p.attested_at,
    iss: p.iss,
  });
}

export function recordFromView(view: Dict): McpProofRecord {
  const payload = payloadFromView(view.payload);
  return makeMcpProofRecord(payload, view.signature, view.kid, view.created_at);
}
