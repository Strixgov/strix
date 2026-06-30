/**
 * `verifyTransactionProof` — the 12-rule AC-1 verifier.
 *
 * Behaviour-faithful TS port of
 * `solo_builder.transaction_proof.verify_transaction_proof`. Runs the 12
 * `AC1VerifierRule` checks in the locked fixed order and short-circuits on
 * the first failure (minimal-information — an attacker learns only the first
 * thing that failed). Fail-closed throughout: rule 10 refuses a public-rail
 * receipt with no signature resolver; unknown capability state fails.
 *
 * A TS verifier built to this contract accepts a Python-signed bundle: the
 * canonical bytes are byte-identical (proven against the corpus) and the
 * rule outcomes match the reference for every vector.
 */

import { lookupStatus, AC_1, ReservationStatus } from "./capabilities.js";
import {
  verifyActorAttestationRecord,
  parseIso,
  type RevocationListResolver,
} from "./actor-attestation.js";
import { verifyDeviceAttestationRecord } from "./device-attestation.js";
import { payloadCanonicalBytes, type AC1Reason, type AC1VerifierRule } from "./types.js";
import type {
  CounterpartyResolver,
  NetworkSignatureResolver,
  PlanResolver,
  TransactionProofRecord,
  TransactionVerificationResult,
} from "./types.js";
import type { SignatureVerifier, JwksResolver } from "./verifier-types.js";
import { hexToBytes } from "./actor-attestation.js";

function fail(rule: AC1VerifierRule, reason: AC1Reason, detail: string): TransactionVerificationResult {
  return { valid: false, failingRule: rule, reason, detail };
}

export interface VerifyTransactionProofOptions {
  signatureVerifier: SignatureVerifier;
  jwksResolver: JwksResolver;
  planResolver: PlanResolver;
  counterpartyResolver?: CounterpartyResolver | null;
  networkSignatureResolver?: NetworkSignatureResolver | null;
  revocationResolver?: RevocationListResolver | null;
  boundEvidenceOccurredAt?: string | null;
  freshnessWindowSeconds?: number;
}

export function verifyTransactionProof(
  record: TransactionProofRecord,
  opts: VerifyTransactionProofOptions,
): TransactionVerificationResult {
  const {
    signatureVerifier,
    jwksResolver,
    planResolver,
    counterpartyResolver = null,
    networkSignatureResolver = null,
    revocationResolver = null,
    boundEvidenceOccurredAt = null,
    freshnessWindowSeconds = 300,
  } = opts;

  const payload = record.payload;

  // Rule 1: schema (envelope fields; payload-field presence + capability_id
  // invariant were enforced at construction).
  if (!record.signature || !record.kid || !record.created_at) {
    return fail("schema", "ac1_schema_missing_field", "envelope field (signature / kid / created_at) missing");
  }

  // Rule 2: capability — AC-1 must be ACTIVE.
  if (payload.capability_id !== AC_1) {
    return fail("capability", "ac1_capability_not_active", `capability_id must be ${AC_1}, got ${payload.capability_id}`);
  }
  if (lookupStatus(AC_1) !== ReservationStatus.ACTIVE) {
    const s = lookupStatus(AC_1) ?? "not_registered";
    return fail("capability", "ac1_capability_not_active", `AC-1 capability status is ${s}, expected 'active'`);
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
      "ac1_principal_attestation_invalid",
      `principal AA-1 failed: ${principalResult.reason ?? "unknown"}`,
    );
  }

  // Rule 4: agent attestation — class lock, then delegate to AA-1.
  const agentPayload = payload.agent_attestation.payload;
  if (agentPayload.actor_class !== "agent") {
    return fail("agent_attestation", "ac1_agent_attestation_invalid", `agent actor_class must be 'agent', got ${agentPayload.actor_class}`);
  }
  if (agentPayload.credential_class !== "agent_token") {
    return fail("agent_attestation", "ac1_agent_attestation_invalid", `agent credential_class must be 'agent_token', got ${agentPayload.credential_class}`);
  }
  const agentResult = verifyActorAttestationRecord(payload.agent_attestation, subOpts);
  if (!agentResult.valid) {
    return fail("agent_attestation", "ac1_agent_attestation_invalid", `agent AA-1 failed: ${agentResult.reason ?? "unknown"}`);
  }

  // Rule 5: device attestation.
  const principalIsHuman = payload.principal_attestation.payload.actor_class === "human";
  if (payload.device_attestation !== null) {
    const deviceResult = verifyDeviceAttestationRecord(payload.device_attestation, subOpts);
    if (!deviceResult.valid) {
      return fail("device_attestation", "ac1_device_attestation_invalid", `device AA-2 failed: ${deviceResult.reason ?? "unknown"}`);
    }
  } else if (principalIsHuman) {
    return fail("device_attestation", "ac1_device_attestation_invalid", "device_attestation is required when principal actor_class=human");
  }

  // Rule 6: plan resolution.
  const plan = planResolver.resolve(payload.plan_hash);
  if (plan === null) {
    return fail("plan_resolution", "ac1_plan_not_found", `plan ${payload.plan_hash.slice(0, 12)}... not found`);
  }
  const approvedAt = plan["approved_at"];
  if (approvedAt) {
    const planApprovedMs = parseIso(String(approvedAt));
    const attestedMs = parseIso(payload.attested_at);
    if (planApprovedMs === null || attestedMs === null) {
      return fail("plan_resolution", "ac1_plan_not_found", "plan timestamp parse failed");
    }
    if (planApprovedMs >= attestedMs) {
      return fail(
        "plan_resolution",
        "ac1_plan_not_found",
        `plan approved_at=${approvedAt} is not strictly before attested_at=${payload.attested_at}`,
      );
    }
  }

  // Rule 7: capability scope (present-with-empty-list is explicit deny-all).
  const allowedIntents = plan["allowed_intents"];
  if (allowedIntents !== undefined && allowedIntents !== null) {
    if (!(allowedIntents as unknown[]).includes(payload.intent.kind)) {
      return fail("capability_scope", "ac1_capability_scope_violation", `intent.kind=${payload.intent.kind} not in plan.allowed_intents`);
    }
  }
  const spendingCap = plan["spending_cap_per_transaction"];
  if (spendingCap !== undefined && spendingCap !== null) {
    if (payload.intent.amount > Number(spendingCap)) {
      return fail("capability_scope", "ac1_capability_scope_violation", `intent.amount=${payload.intent.amount} exceeds plan.spending_cap_per_transaction=${spendingCap}`);
    }
  }
  const allowedCounterparties = plan["allowed_counterparties"];
  if (allowedCounterparties !== undefined && allowedCounterparties !== null) {
    if (!(allowedCounterparties as unknown[]).includes(payload.counterparty.id)) {
      return fail("capability_scope", "ac1_capability_scope_violation", `counterparty.id=${payload.counterparty.id} not in plan.allowed_counterparties`);
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
      return fail("tenant_coherence", "ac1_tenant_mismatch", `${label} attestation tenant_id=${attestationTenant} != envelope tenant_id=${payload.tenant_id}`);
    }
  }

  // Rule 9: counterparty validation (skipped when no resolver).
  if (counterpartyResolver) {
    const status = counterpartyResolver.verify(payload.counterparty);
    if (status === "unavailable") {
      return fail("counterparty", "ac1_counterparty_check_unavailable", `counterparty resolver unavailable for ${payload.counterparty.id}`);
    }
    if (status === "invalid") {
      return fail("counterparty", "ac1_counterparty_unknown", `counterparty ${payload.counterparty.id} not verified`);
    }
  }

  // Rule 10: network receipt.
  const network = payload.network_receipt.network;
  if (network !== "none") {
    if (!payload.network_receipt.network_id) {
      return fail("network_receipt", "ac1_network_receipt_invalid", `network=${network} requires non-empty network_id`);
    }
    if (network !== "internal") {
      if (!payload.network_receipt.network_signature) {
        return fail("network_receipt", "ac1_network_receipt_invalid", `network=${network} requires non-empty network_signature`);
      }
      // Fail closed when no resolver is supplied — public-rail signatures MUST
      // be verified against the network's published key (ADR-018 §1 rule 10).
      if (!networkSignatureResolver) {
        return fail(
          "network_receipt",
          "ac1_network_receipt_invalid",
          `network=${network} requires network_signature_resolver to verify network_signature against the network's published key (rule 10 fails closed when the resolver is missing)`,
        );
      }
      if (!networkSignatureResolver.verify(payload.network_receipt)) {
        return fail("network_receipt", "ac1_network_receipt_invalid", `network=${network} signature failed verification`);
      }
    }
  }

  // Rule 11: time freshness (only when caller supplies a bound timestamp).
  if (boundEvidenceOccurredAt !== null && boundEvidenceOccurredAt !== undefined) {
    const attestedMs = parseIso(payload.attested_at);
    const boundMs = parseIso(boundEvidenceOccurredAt);
    if (attestedMs === null || boundMs === null) {
      return fail("time_freshness", "ac1_time_freshness_violated", "timestamp parse failed");
    }
    if (Math.abs(attestedMs - boundMs) > freshnessWindowSeconds * 1000) {
      return fail("time_freshness", "ac1_time_freshness_violated", "attested_at vs occurred_at exceeds freshness window");
    }
  }

  // Rule 12: bundle signature.
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = hexToBytes(record.signature);
  } catch {
    return fail("bundle_signature", "ac1_signature_invalid", "bundle signature is not hex-encoded");
  }
  const publicKey = jwksResolver.publicKey(payload.iss, record.kid);
  if (publicKey === null) {
    return fail("bundle_signature", "ac1_signature_invalid", `no key for (iss=${payload.iss}, kid=${record.kid})`);
  }
  if (!signatureVerifier.verify(payloadCanonicalBytes(payload), signatureBytes, publicKey)) {
    return fail("bundle_signature", "ac1_signature_invalid", "bundle signature verification failed");
  }

  return { valid: true };
}
