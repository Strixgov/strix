/**
 * Reconstruct a `TransactionProofRecord` from its on-wire dict view.
 *
 * Mirror of `_record_from_view` in `tests/test_golden_vectors_ac1.py` and
 * `from_json_ld`'s parsing. Validation happens in the same order as the
 * Python reference so that construction-time negatives surface the same
 * error first (intent currency/amount before the AC-1 payload invariants).
 */

import {
  makeCounterparty,
  makeIntent,
  makeTransactionProofPayload,
  makeTransactionProofRecord,
  type Counterparty,
  type CounterpartyKind,
  type Network,
  type NetworkReceipt,
  type TransactionIntent,
  type TransactionKind,
  type TransactionProofPayload,
  type TransactionProofRecord,
} from "./types.js";
import type { ActorAttestationRecord } from "./actor-attestation.js";
import type { DeviceAttestationRecord } from "./device-attestation.js";

type Dict = Record<string, any>;

export function aa1FromView(d: Dict): ActorAttestationRecord {
  const p = d.payload;
  return {
    payload: {
      evidence_id: p.evidence_id,
      actor_class: p.actor_class,
      actor_id: p.actor_id,
      credential_class: p.credential_class,
      tenant_id: p.tenant_id,
      environment: p.environment,
      attested_at: p.attested_at,
      capability_id: p.capability_id,
      iss: p.iss,
    },
    signature: d.signature,
    kid: d.kid,
    created_at: d.created_at,
  };
}

export function aa2FromView(d: Dict): DeviceAttestationRecord {
  const p = d.payload;
  return {
    payload: {
      evidence_id: p.evidence_id,
      device_class: p.device_class,
      device_id: p.device_id,
      attestation_protocol: p.attestation_protocol,
      tenant_id: p.tenant_id,
      environment: p.environment,
      attested_at: p.attested_at,
      capability_id: p.capability_id,
      iss: p.iss,
    },
    signature: d.signature,
    kid: d.kid,
    created_at: d.created_at,
  };
}

export function payloadFromView(p: Dict): TransactionProofPayload {
  const principal = aa1FromView(p.principal_attestation);
  const agent = aa1FromView(p.agent_attestation);
  const device = p.device_attestation === null ? null : aa2FromView(p.device_attestation);

  const counterparty: Counterparty = makeCounterparty(
    p.counterparty.id,
    p.counterparty.kind as CounterpartyKind,
    p.counterparty.verification,
  );
  const intent: TransactionIntent = makeIntent(
    p.intent.kind as TransactionKind,
    p.intent.amount,
    p.intent.currency,
    p.intent.instrument_hash,
  );
  const receipt: NetworkReceipt = {
    network: p.network_receipt.network as Network,
    network_id: p.network_receipt.network_id,
    network_signature: p.network_receipt.network_signature,
    settled_at: p.network_receipt.settled_at,
  };

  return makeTransactionProofPayload({
    evidence_id: p.evidence_id,
    principal_attestation: principal,
    agent_attestation: agent,
    device_attestation: device,
    plan_hash: p.plan_hash,
    capability_id: p.capability_id,
    tenant_id: p.tenant_id,
    counterparty,
    intent,
    network_receipt: receipt,
    attested_at: p.attested_at,
    iss: p.iss,
  });
}

export function recordFromView(view: Dict): TransactionProofRecord {
  const payload = payloadFromView(view.payload);
  return makeTransactionProofRecord(payload, view.signature, view.kid, view.created_at);
}
