/**
 * `verifyMcpProof` — the 12-rule MC-1 verifier.
 *
 * Behaviour-faithful TS port of
 * `solo_builder.mcp_proof.verify_mcp_proof`. Runs the 12 `MC1VerifierRule`
 * checks in the locked fixed order and short-circuits on the first failure
 * (minimal-information — an attacker learns only the first thing that
 * failed). Fail-closed throughout: rule 10 refuses a `signed_server` receipt
 * with no signature resolver; an unknown / not-active capability fails.
 *
 * A TS verifier built to this contract accepts a Python-signed bundle: the
 * canonical bytes are byte-identical (proven against the corpus) and the rule
 * outcomes match the reference for every vector.
 *
 * Rules 3/4/5 delegate to the shared AA-1 / AA-2 sub-verifiers — the same
 * ports AC-1 rules 3/4/5 use (the Python reference imports one
 * `actor_attestation` / `device_attestation` module for both envelopes).
 */

import { lookupStatus, MC_1, ReservationStatus } from "../transaction-proof/capabilities.js";
import {
  verifyActorAttestationRecord,
  parseIso,
  hexToBytes,
  type RevocationListResolver,
} from "../transaction-proof/actor-attestation.js";
import { verifyDeviceAttestationRecord } from "../transaction-proof/device-attestation.js";
import { payloadCanonicalBytes } from "./types.js";
import type {
  McpProofRecord,
  McpProofVerificationResult,
  McpServerResolver,
  MC1Reason,
  MC1VerifierRule,
  PlanResolver,
  ServerSignatureResolver,
} from "./types.js";
import type { SignatureVerifier, JwksResolver } from "../transaction-proof/verifier-types.js";

function fail(rule: MC1VerifierRule, reason: MC1Reason, detail: string): McpProofVerificationResult {
  return { valid: false, failingRule: rule, reason, detail };
}

export interface VerifyMcpProofOptions {
  signatureVerifier: SignatureVerifier;
  jwksResolver: JwksResolver;
  planResolver: PlanResolver;
  mcpServerResolver?: McpServerResolver | null;
  serverSignatureResolver?: ServerSignatureResolver | null;
  revocationResolver?: RevocationListResolver | null;
  boundEvidenceOccurredAt?: string | null;
  freshnessWindowSeconds?: number;
}

export function verifyMcpProof(
  record: McpProofRecord,
  opts: VerifyMcpProofOptions,
): McpProofVerificationResult {
  const {
    signatureVerifier,
    jwksResolver,
    planResolver,
    mcpServerResolver = null,
    serverSignatureResolver = null,
    revocationResolver = null,
    boundEvidenceOccurredAt = null,
    freshnessWindowSeconds = 300,
  } = opts;

  const payload = record.payload;

  // Rule 1: schema (envelope fields; payload-field presence + capability_id
  // invariant + tool_call/mcp_server.id cross-binding were enforced at
  // construction).
  if (!record.signature || !record.kid || !record.created_at) {
    return fail("schema", "mc1_schema_missing_field", "envelope field (signature / kid / created_at) missing");
  }

  // Rule 2: capability — MC-1 must be ACTIVE.
  if (payload.capability_id !== MC_1) {
    return fail("capability", "mc1_capability_not_active", `capability_id must be ${MC_1}, got ${payload.capability_id}`);
  }
  if (lookupStatus(MC_1) !== ReservationStatus.ACTIVE) {
    const s = lookupStatus(MC_1) ?? "not_registered";
    return fail("capability", "mc1_capability_not_active", `MC-1 capability status is ${s}, expected 'active'`);
  }

  const subOpts = {
    signatureVerifier,
    jwks: jwksResolver,
    boundEvidenceTenant: payload.tenant_id,
    boundEvidenceOccurredAt,
    freshnessWindowSeconds,
    revocationResolver,
  };

  // Rule 3: principal attestation — delegate to AA-1.
  const principalResult = verifyActorAttestationRecord(payload.principal_attestation, subOpts);
  if (!principalResult.valid) {
    return fail(
      "principal_attestation",
      "mc1_principal_attestation_invalid",
      `principal AA-1 failed: ${principalResult.reason ?? "unknown"}`,
    );
  }

  // Rule 4: agent attestation — class lock, then delegate to AA-1.
  const agentPayload = payload.agent_attestation.payload;
  if (agentPayload.actor_class !== "agent") {
    return fail("agent_attestation", "mc1_agent_attestation_invalid", `agent actor_class must be 'agent', got ${agentPayload.actor_class}`);
  }
  if (agentPayload.credential_class !== "agent_token") {
    return fail("agent_attestation", "mc1_agent_attestation_invalid", `agent credential_class must be 'agent_token', got ${agentPayload.credential_class}`);
  }
  const agentResult = verifyActorAttestationRecord(payload.agent_attestation, subOpts);
  if (!agentResult.valid) {
    return fail("agent_attestation", "mc1_agent_attestation_invalid", `agent AA-1 failed: ${agentResult.reason ?? "unknown"}`);
  }

  // Rule 5: device attestation.
  const principalIsHuman = payload.principal_attestation.payload.actor_class === "human";
  if (payload.device_attestation !== null) {
    const deviceResult = verifyDeviceAttestationRecord(payload.device_attestation, subOpts);
    if (!deviceResult.valid) {
      return fail("device_attestation", "mc1_device_attestation_invalid", `device AA-2 failed: ${deviceResult.reason ?? "unknown"}`);
    }
  } else if (principalIsHuman) {
    return fail("device_attestation", "mc1_device_attestation_invalid", "device_attestation is required when principal actor_class=human");
  }

  // Rule 6: plan resolution.
  const plan = planResolver.resolve(payload.plan_hash);
  if (plan === null) {
    return fail("plan_resolution", "mc1_plan_not_found", `plan ${payload.plan_hash.slice(0, 12)}... not found`);
  }
  const approvedAt = plan["approved_at"];
  if (approvedAt) {
    const planApprovedMs = parseIso(String(approvedAt));
    const attestedMs = parseIso(payload.attested_at);
    if (planApprovedMs === null || attestedMs === null) {
      return fail("plan_resolution", "mc1_plan_not_found", "plan timestamp parse failed");
    }
    if (planApprovedMs >= attestedMs) {
      return fail(
        "plan_resolution",
        "mc1_plan_not_found",
        `plan approved_at=${approvedAt} is not strictly before attested_at=${payload.attested_at}`,
      );
    }
  }

  // Rule 7: capability scope — allowed_tools membership + K-BIND-3 binding.
  const toolName = payload.tool_call.tool_name;
  const allowedTools = plan["allowed_tools"];
  // Missing field is permissive (v1 forward-compat). Present-with-empty-list
  // is explicit deny-all — a Plan that authorizes no tools rejects every call.
  if (allowedTools !== undefined && allowedTools !== null) {
    if (!(allowedTools as unknown[]).includes(toolName)) {
      return fail(
        "capability_scope",
        "mc1_capability_scope_violation",
        `tool_call.tool_name=${toolName} not in plan.allowed_tools`,
      );
    }
  }
  // K-BIND-3 params binding.
  const boundParamsHash = plan["bound_params_hash"];
  if (boundParamsHash && typeof boundParamsHash === "object") {
    const expected = (boundParamsHash as Record<string, unknown>)[toolName];
    if (expected !== undefined && expected !== null && expected !== payload.tool_call.params_hash) {
      return fail(
        "capability_scope",
        "mc1_params_hash_mismatch",
        `tool_call.params_hash=${payload.tool_call.params_hash} != plan.bound_params_hash[${toolName}]=${expected}`,
      );
    }
  }
  // K-BIND-3 schema binding.
  const boundSchemaHash = plan["bound_params_schema_hash"];
  if (boundSchemaHash && typeof boundSchemaHash === "object") {
    const expected = (boundSchemaHash as Record<string, unknown>)[toolName];
    if (expected !== undefined && expected !== null && expected !== payload.tool_call.params_schema_hash) {
      return fail(
        "capability_scope",
        "mc1_params_hash_mismatch",
        `tool_call.params_schema_hash=${payload.tool_call.params_schema_hash} != plan.bound_params_schema_hash[${toolName}]=${expected}`,
      );
    }
  }

  // Rule 8: tenant coherence.
  const tenantChecks: Array<[string, string]> = [
    ["principal", payload.principal_attestation.payload.tenant_id],
    ["agent", payload.agent_attestation.payload.tenant_id],
  ];
  if (payload.device_attestation !== null) {
    tenantChecks.push(["device", payload.device_attestation.payload.tenant_id]);
  }
  for (const [label, attestationTenant] of tenantChecks) {
    if (attestationTenant !== payload.tenant_id) {
      return fail("tenant_coherence", "mc1_tenant_mismatch", `${label} attestation tenant_id=${attestationTenant} != envelope tenant_id=${payload.tenant_id}`);
    }
  }

  // Rule 9: MCP server validation (skipped when no resolver).
  if (mcpServerResolver) {
    const status = mcpServerResolver.verify(payload.mcp_server);
    if (status === "unavailable") {
      return fail("mcp_server", "mc1_mcp_server_check_unavailable", `mcp server resolver unavailable for ${payload.mcp_server.id}`);
    }
    if (status === "unknown") {
      return fail("mcp_server", "mc1_mcp_server_unknown", `mcp server ${payload.mcp_server.id} not verified`);
    }
  }

  // Rule 10: execution receipt + server signature.
  const serverKind = payload.mcp_server.kind;
  const receipt = payload.execution_receipt;
  if (!receipt.result_hash) {
    return fail("execution_receipt", "mc1_execution_receipt_invalid", "execution_receipt.result_hash is required");
  }
  if (serverKind === "signed_server") {
    if (!receipt.server_signature) {
      return fail("execution_receipt", "mc1_execution_receipt_invalid", "signed_server kind requires non-empty execution_receipt.server_signature");
    }
    // Fail closed when no resolver is supplied — signed_server signatures MUST
    // be verified against the server's published key (ADR-020 §1 rule 10).
    if (!serverSignatureResolver) {
      return fail(
        "execution_receipt",
        "mc1_execution_receipt_invalid",
        "signed_server kind requires server_signature_resolver to verify execution_receipt.server_signature against the server's published key (rule 10 fails closed when the resolver is missing)",
      );
    }
    if (!serverSignatureResolver.verify(receipt, payload.mcp_server)) {
      return fail("execution_receipt", "mc1_execution_receipt_invalid", `server signature failed verification for ${payload.mcp_server.id}`);
    }
  }
  // local / tenant_internal / peer_agent: server_signature optional, skipped.

  // Rule 11: time freshness (only when caller supplies a bound timestamp).
  if (boundEvidenceOccurredAt !== null && boundEvidenceOccurredAt !== undefined) {
    const attestedMs = parseIso(payload.attested_at);
    const boundMs = parseIso(boundEvidenceOccurredAt);
    if (attestedMs === null || boundMs === null) {
      return fail("time_freshness", "mc1_time_freshness_violated", "timestamp parse failed");
    }
    if (Math.abs(attestedMs - boundMs) > freshnessWindowSeconds * 1000) {
      return fail("time_freshness", "mc1_time_freshness_violated", "attested_at vs occurred_at exceeds freshness window");
    }
  }

  // Rule 12: bundle signature.
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = hexToBytes(record.signature);
  } catch {
    return fail("bundle_signature", "mc1_signature_invalid", "bundle signature is not hex-encoded");
  }
  const publicKey = jwksResolver.publicKey(payload.iss, record.kid);
  if (publicKey === null) {
    return fail("bundle_signature", "mc1_signature_invalid", `no key for (iss=${payload.iss}, kid=${record.kid})`);
  }
  if (!signatureVerifier.verify(payloadCanonicalBytes(payload), signatureBytes, publicKey)) {
    return fail("bundle_signature", "mc1_signature_invalid", "bundle signature verification failed");
  }

  return { valid: true };
}
