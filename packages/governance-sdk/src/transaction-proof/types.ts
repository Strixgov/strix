/**
 * AC-1 `transaction_proof_v1` locked types, vocabularies, reason codes,
 * verifier rules, and sub-record constructors.
 *
 * Mirrors `solo_builder.transaction_proof` byte-for-byte: same enums (4
 * counterparty kinds, 5 transaction kinds, 6 networks), same 14 reason
 * codes, same 12 verifier rules in fixed order, same construction-time
 * invariants. The construction validators reproduce the Python dataclass
 * `__post_init__` errors (matched against the corpus
 * `construction_error_substring`s).
 */

import { canonicalize } from "./canonical.js";
import { AC_1 } from "./capabilities.js";
import type { ActorAttestationRecord } from "./actor-attestation.js";
import type { DeviceAttestationRecord } from "./device-attestation.js";

// ── Locked vocabularies ──────────────────────────────────────────────────────

export type CounterpartyKind = "merchant" | "peer_agent" | "service" | "treasury";
export const COUNTERPARTY_KINDS: readonly CounterpartyKind[] = [
  "merchant",
  "peer_agent",
  "service",
  "treasury",
];

export type TransactionKind =
  | "purchase"
  | "subscription"
  | "refund"
  | "transfer"
  | "authorization_only";
export const TRANSACTION_KINDS: readonly TransactionKind[] = [
  "purchase",
  "subscription",
  "refund",
  "transfer",
  "authorization_only",
];

export type Network =
  | "stripe"
  | "visa_ap"
  | "mastercard_agent_pay"
  | "paypal_agent"
  | "internal"
  | "none";
export const NETWORKS: readonly Network[] = [
  "stripe",
  "visa_ap",
  "mastercard_agent_pay",
  "paypal_agent",
  "internal",
  "none",
];

// ── Reason codes (14) ────────────────────────────────────────────────────────

export type AC1Reason =
  | "ac1_schema_missing_field"
  | "ac1_schema_unknown_field"
  | "ac1_capability_not_active"
  | "ac1_principal_attestation_invalid"
  | "ac1_agent_attestation_invalid"
  | "ac1_device_attestation_invalid"
  | "ac1_plan_not_found"
  | "ac1_capability_scope_violation"
  | "ac1_tenant_mismatch"
  | "ac1_counterparty_unknown"
  | "ac1_counterparty_check_unavailable"
  | "ac1_network_receipt_invalid"
  | "ac1_time_freshness_violated"
  | "ac1_signature_invalid";

// ── Verifier rules (12, fixed order) ─────────────────────────────────────────

export type AC1VerifierRule =
  | "schema"
  | "capability"
  | "principal_attestation"
  | "agent_attestation"
  | "device_attestation"
  | "plan_resolution"
  | "capability_scope"
  | "tenant_coherence"
  | "counterparty"
  | "network_receipt"
  | "time_freshness"
  | "bundle_signature";

// ── Sub-records ──────────────────────────────────────────────────────────────

export interface Counterparty {
  id: string;
  kind: CounterpartyKind;
  verification: string;
}

export function makeCounterparty(id: string, kind: CounterpartyKind, verification: string): Counterparty {
  if (!id) throw new Error("Counterparty.id is required");
  if (!verification) throw new Error("Counterparty.verification is required");
  return { id, kind, verification };
}

export function counterpartyToDict(c: Counterparty): Record<string, unknown> {
  return { id: c.id, kind: c.kind, verification: c.verification };
}

export interface TransactionIntent {
  kind: TransactionKind;
  amount: number;
  currency: string;
  instrument_hash: string;
}

export function makeIntent(
  kind: TransactionKind,
  amount: number,
  currency: string,
  instrumentHash: string,
): TransactionIntent {
  if (amount < 0) throw new Error("TransactionIntent.amount must be non-negative (minor units)");
  if (!currency || currency.length !== 3) {
    throw new Error("TransactionIntent.currency must be a 3-letter ISO 4217 code");
  }
  if (!instrumentHash) throw new Error("TransactionIntent.instrument_hash is required");
  return { kind, amount, currency, instrument_hash: instrumentHash };
}

export function intentToDict(i: TransactionIntent): Record<string, unknown> {
  return { kind: i.kind, amount: i.amount, currency: i.currency, instrument_hash: i.instrument_hash };
}

export interface NetworkReceipt {
  network: Network;
  network_id: string;
  network_signature: string;
  settled_at: string;
}

export function networkReceiptToDict(r: NetworkReceipt): Record<string, unknown> {
  return {
    network: r.network,
    network_id: r.network_id,
    network_signature: r.network_signature,
    settled_at: r.settled_at,
  };
}

// ── Canonical payload (12 fields) ────────────────────────────────────────────

export const REQUIRED_TRANSACTION_FIELDS: readonly string[] = [
  "evidence_id",
  "principal_attestation",
  "agent_attestation",
  "device_attestation",
  "plan_hash",
  "capability_id",
  "tenant_id",
  "counterparty",
  "intent",
  "network_receipt",
  "attested_at",
  "iss",
];

export interface TransactionProofPayload {
  evidence_id: string;
  principal_attestation: ActorAttestationRecord;
  agent_attestation: ActorAttestationRecord;
  device_attestation: DeviceAttestationRecord | null;
  plan_hash: string;
  capability_id: string;
  tenant_id: string;
  counterparty: Counterparty;
  intent: TransactionIntent;
  network_receipt: NetworkReceipt;
  attested_at: string;
  iss: string;
}

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

/** Construct + validate a TransactionProofPayload (mirror of `__post_init__`). */
export function makeTransactionProofPayload(p: TransactionProofPayload): TransactionProofPayload {
  if (p.capability_id !== AC_1) {
    throw new Error(
      `capability_id must be '${AC_1}' for an AC-1 envelope, got '${p.capability_id}'`,
    );
  }
  for (const fld of ["evidence_id", "plan_hash", "tenant_id", "attested_at", "iss"] as const) {
    if (!p[fld]) throw new Error(`${fld} is required`);
  }
  const agent = p.agent_attestation.payload;
  if (agent.actor_class !== "agent") {
    throw new Error(
      `agent_attestation.actor_class must be 'agent' (got '${agent.actor_class}') — AC-1 §1 invariant`,
    );
  }
  if (agent.credential_class !== "agent_token") {
    throw new Error(
      `agent_attestation.credential_class must be 'agent_token' (got '${agent.credential_class}') — AC-1 §1 invariant`,
    );
  }
  return p;
}

export function payloadToDict(p: TransactionProofPayload): Record<string, unknown> {
  return {
    evidence_id: p.evidence_id,
    principal_attestation: aa1RecordToDict(p.principal_attestation),
    agent_attestation: aa1RecordToDict(p.agent_attestation),
    device_attestation: p.device_attestation === null ? null : aa2RecordToDict(p.device_attestation),
    plan_hash: p.plan_hash,
    capability_id: p.capability_id,
    tenant_id: p.tenant_id,
    counterparty: counterpartyToDict(p.counterparty),
    intent: intentToDict(p.intent),
    network_receipt: networkReceiptToDict(p.network_receipt),
    attested_at: p.attested_at,
    iss: p.iss,
  };
}

export function payloadCanonicalBytes(p: TransactionProofPayload): Uint8Array {
  return canonicalize(payloadToDict(p));
}

export interface TransactionProofRecord {
  payload: TransactionProofPayload;
  signature: string;
  kid: string;
  created_at: string;
}

export function makeTransactionProofRecord(
  payload: TransactionProofPayload,
  signature: string,
  kid: string,
  created_at: string,
): TransactionProofRecord {
  if (!signature) throw new Error("signature is required");
  if (!kid) throw new Error("kid is required");
  if (!created_at) throw new Error("created_at is required");
  return { payload, signature, kid, created_at };
}

// ── Resolver protocols + result ──────────────────────────────────────────────

export type CounterpartyVerificationStatus = "verified" | "invalid" | "unavailable";
export type NetworkSignatureStatus = "valid" | "invalid" | "skipped";

export interface CounterpartyResolver {
  verify(counterparty: Counterparty): CounterpartyVerificationStatus;
}

export interface NetworkSignatureResolver {
  verify(receipt: NetworkReceipt): boolean;
}

export interface PlanResolver {
  resolve(planHash: string): Record<string, unknown> | null;
}

export interface TransactionVerificationResult {
  valid: boolean;
  failingRule?: AC1VerifierRule;
  reason?: AC1Reason;
  detail?: string;
}
