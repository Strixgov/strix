/**
 * MC-1 `mcp_proof_v1` locked types, vocabularies, reason codes, verifier
 * rules, and sub-record constructors.
 *
 * Mirrors `solo_builder.mcp_proof` byte-for-byte: same enums (4 MCP server
 * kinds, 4 risk tiers, 3 execution statuses), same 15 reason codes, same 12
 * verifier rules in fixed order, same construction-time invariants. The
 * construction validators reproduce the Python dataclass `__post_init__`
 * errors (matched against the corpus `construction_error_substring`s).
 *
 * The AA-1 / AA-2 attestation records MC-1 nests are the *same* shared
 * surface AC-1 nests (the Python `mcp_proof` and `transaction_proof` modules
 * both import the one `actor_attestation` / `device_attestation` module);
 * we reuse those ports here rather than fork them, so there is exactly one
 * AA-1/AA-2 verifier in this SDK and no drift between siblings.
 */

import { canonicalize } from "./canonical.js";
import { MC_1 } from "../transaction-proof/capabilities.js";
import type {
  ActorAttestationRecord,
  ActorClass,
} from "../transaction-proof/actor-attestation.js";
import type { DeviceAttestationRecord } from "../transaction-proof/device-attestation.js";

// ── Locked vocabularies ──────────────────────────────────────────────────────

export type MCPServerKind = "signed_server" | "local" | "peer_agent" | "tenant_internal";
export const MCP_SERVER_KINDS: readonly MCPServerKind[] = [
  "signed_server",
  "local",
  "peer_agent",
  "tenant_internal",
];

export type ToolRiskTier = "critical" | "high" | "medium" | "low";
export const TOOL_RISK_TIERS: readonly ToolRiskTier[] = ["critical", "high", "medium", "low"];

export type ExecutionStatus = "success" | "failed" | "cancelled";
export const EXECUTION_STATUSES: readonly ExecutionStatus[] = ["success", "failed", "cancelled"];

// ── Reason codes (15) ────────────────────────────────────────────────────────

export type MC1Reason =
  | "mc1_schema_missing_field"
  | "mc1_schema_unknown_field"
  | "mc1_capability_not_active"
  | "mc1_principal_attestation_invalid"
  | "mc1_agent_attestation_invalid"
  | "mc1_device_attestation_invalid"
  | "mc1_plan_not_found"
  | "mc1_capability_scope_violation"
  | "mc1_params_hash_mismatch"
  | "mc1_tenant_mismatch"
  | "mc1_mcp_server_unknown"
  | "mc1_mcp_server_check_unavailable"
  | "mc1_execution_receipt_invalid"
  | "mc1_time_freshness_violated"
  | "mc1_signature_invalid";

// ── Verifier rules (12, fixed order) ─────────────────────────────────────────

export type MC1VerifierRule =
  | "schema"
  | "capability"
  | "principal_attestation"
  | "agent_attestation"
  | "device_attestation"
  | "plan_resolution"
  | "capability_scope"
  | "tenant_coherence"
  | "mcp_server"
  | "execution_receipt"
  | "time_freshness"
  | "bundle_signature";

// ── Sub-records ──────────────────────────────────────────────────────────────

export interface McpServer {
  id: string;
  kind: MCPServerKind;
  attestation: string;
}

/** Construct + validate an McpServer (mirror of `McpServer.__post_init__`). */
export function makeMcpServer(id: string, kind: MCPServerKind, attestation: string): McpServer {
  if (!id) throw new Error("McpServer.id is required");
  return { id, kind, attestation };
}

export function mcpServerToDict(s: McpServer): Record<string, unknown> {
  return { id: s.id, kind: s.kind, attestation: s.attestation };
}

export interface ToolCall {
  server_id: string;
  tool_name: string;
  risk_tier: ToolRiskTier;
  params_hash: string;
  params_schema_hash: string;
}

/** Construct + validate a ToolCall (mirror of `ToolCall.__post_init__`, K-BIND-3 invariants). */
export function makeToolCall(
  server_id: string,
  tool_name: string,
  risk_tier: ToolRiskTier,
  params_hash: string,
  params_schema_hash: string,
): ToolCall {
  if (!server_id) throw new Error("ToolCall.server_id is required");
  if (!tool_name) throw new Error("ToolCall.tool_name is required");
  if (!params_hash) throw new Error("ToolCall.params_hash is required (K-BIND-3 invariant)");
  if (!params_schema_hash) {
    throw new Error("ToolCall.params_schema_hash is required (K-BIND-3 invariant)");
  }
  return { server_id, tool_name, risk_tier, params_hash, params_schema_hash };
}

export function toolCallToDict(c: ToolCall): Record<string, unknown> {
  return {
    server_id: c.server_id,
    tool_name: c.tool_name,
    risk_tier: c.risk_tier,
    params_hash: c.params_hash,
    params_schema_hash: c.params_schema_hash,
  };
}

export interface ExecutionReceipt {
  status: ExecutionStatus;
  result_hash: string;
  server_signature: string;
  started_at: string;
  completed_at: string;
}

/** Construct + validate an ExecutionReceipt (mirror of `ExecutionReceipt.__post_init__`). */
export function makeExecutionReceipt(
  status: ExecutionStatus,
  result_hash: string,
  server_signature: string,
  started_at: string,
  completed_at: string,
): ExecutionReceipt {
  if (!result_hash) {
    throw new Error("ExecutionReceipt.result_hash is required (always populated)");
  }
  if (!started_at) throw new Error("ExecutionReceipt.started_at is required");
  if (!completed_at) throw new Error("ExecutionReceipt.completed_at is required");
  return { status, result_hash, server_signature, started_at, completed_at };
}

export function executionReceiptToDict(r: ExecutionReceipt): Record<string, unknown> {
  return {
    status: r.status,
    result_hash: r.result_hash,
    server_signature: r.server_signature,
    started_at: r.started_at,
    completed_at: r.completed_at,
  };
}

// ── Canonical payload (12 fields) ────────────────────────────────────────────

export const REQUIRED_MCP_PROOF_FIELDS: readonly string[] = [
  "evidence_id",
  "principal_attestation",
  "agent_attestation",
  "device_attestation",
  "plan_hash",
  "capability_id",
  "tenant_id",
  "mcp_server",
  "tool_call",
  "execution_receipt",
  "attested_at",
  "iss",
];

export interface McpProofPayload {
  evidence_id: string;
  principal_attestation: ActorAttestationRecord;
  agent_attestation: ActorAttestationRecord;
  device_attestation: DeviceAttestationRecord | null;
  plan_hash: string;
  capability_id: string;
  tenant_id: string;
  mcp_server: McpServer;
  tool_call: ToolCall;
  execution_receipt: ExecutionReceipt;
  attested_at: string;
  iss: string;
}

/** Canonical dict view of a nested AA-1 record (9-field payload + envelope). */
function aa1RecordToDict(r: ActorAttestationRecord): Record<string, unknown> {
  return {
    payload: {
      evidence_id: r.payload.evidence_id,
      actor_class: r.payload.actor_class,
      actor_id: r.payload.actor_id,
      credential_class: r.payload.credential_class,
      tenant_id: r.payload.tenant_id,
      environment: r.payload.environment,
      attested_at: r.payload.attested_at,
      capability_id: r.payload.capability_id,
      iss: r.payload.iss,
    },
    signature: r.signature,
    kid: r.kid,
    created_at: r.created_at,
  };
}

/** Canonical dict view of a nested AA-2 record (9-field payload + envelope). */
function aa2RecordToDict(r: DeviceAttestationRecord): Record<string, unknown> {
  return {
    payload: {
      evidence_id: r.payload.evidence_id,
      device_class: r.payload.device_class,
      device_id: r.payload.device_id,
      attestation_protocol: r.payload.attestation_protocol,
      tenant_id: r.payload.tenant_id,
      environment: r.payload.environment,
      attested_at: r.payload.attested_at,
      capability_id: r.payload.capability_id,
      iss: r.payload.iss,
    },
    signature: r.signature,
    kid: r.kid,
    created_at: r.created_at,
  };
}

/**
 * Construct + validate an McpProofPayload (mirror of `__post_init__`). The
 * checks run in the same order as the Python dataclass so construction-time
 * negatives surface the same first error:
 *   1. capability_id === "MC-1"
 *   2. required string fields non-empty
 *   3. agent actor_class === "agent"  (MC-1 §1 AA-PRE-2 lock)
 *   4. agent credential_class === "agent_token"
 *   5. tool_call.server_id === mcp_server.id (cross-binding)
 */
export function makeMcpProofPayload(p: McpProofPayload): McpProofPayload {
  if (p.capability_id !== MC_1) {
    throw new Error(
      `capability_id must be '${MC_1}' for an MC-1 envelope, got '${p.capability_id}'`,
    );
  }
  for (const fld of ["evidence_id", "plan_hash", "tenant_id", "attested_at", "iss"] as const) {
    if (!p[fld]) throw new Error(`${fld} is required`);
  }
  const agent = p.agent_attestation.payload;
  if (agent.actor_class !== "agent") {
    throw new Error(
      `agent_attestation.actor_class must be 'agent' (got '${agent.actor_class}') — MC-1 §1 invariant`,
    );
  }
  if (agent.credential_class !== "agent_token") {
    throw new Error(
      `agent_attestation.credential_class must be 'agent_token' (got '${agent.credential_class}') — MC-1 §1 invariant`,
    );
  }
  if (p.tool_call.server_id !== p.mcp_server.id) {
    throw new Error(
      `tool_call.server_id='${p.tool_call.server_id}' must match mcp_server.id='${p.mcp_server.id}'`,
    );
  }
  return p;
}

export function payloadToDict(p: McpProofPayload): Record<string, unknown> {
  return {
    evidence_id: p.evidence_id,
    principal_attestation: aa1RecordToDict(p.principal_attestation),
    agent_attestation: aa1RecordToDict(p.agent_attestation),
    device_attestation: p.device_attestation === null ? null : aa2RecordToDict(p.device_attestation),
    plan_hash: p.plan_hash,
    capability_id: p.capability_id,
    tenant_id: p.tenant_id,
    mcp_server: mcpServerToDict(p.mcp_server),
    tool_call: toolCallToDict(p.tool_call),
    execution_receipt: executionReceiptToDict(p.execution_receipt),
    attested_at: p.attested_at,
    iss: p.iss,
  };
}

export function payloadCanonicalBytes(p: McpProofPayload): Uint8Array {
  return canonicalize(payloadToDict(p));
}

export interface McpProofRecord {
  payload: McpProofPayload;
  signature: string;
  kid: string;
  created_at: string;
}

export function makeMcpProofRecord(
  payload: McpProofPayload,
  signature: string,
  kid: string,
  created_at: string,
): McpProofRecord {
  if (!signature) throw new Error("signature is required");
  if (!kid) throw new Error("kid is required");
  if (!created_at) throw new Error("created_at is required");
  return { payload, signature, kid, created_at };
}

// ── Resolver protocols + result ──────────────────────────────────────────────

export type McpServerVerificationStatus = "verified" | "unknown" | "unavailable";
export type ServerSignatureStatus = "valid" | "invalid" | "skipped";

export interface McpServerResolver {
  verify(server: McpServer): McpServerVerificationStatus;
}

export interface ServerSignatureResolver {
  verify(receipt: ExecutionReceipt, server: McpServer): boolean;
}

export interface PlanResolver {
  resolve(planHash: string): Record<string, unknown> | null;
}

export interface McpProofVerificationResult {
  valid: boolean;
  failingRule?: MC1VerifierRule;
  reason?: MC1Reason;
  detail?: string;
}

// Re-export the actor-class type so MC-1 consumers don't have to reach into
// the transaction-proof module for it.
export type { ActorClass };
