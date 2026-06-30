/**
 * Public verify-endpoint `transaction` block (ADR-014 §3 / ADR-018 §5).
 *
 * Mirror of `render_transaction_block` / `TransactionBlock`. The block is the
 * ONLY AC-1 shape that crosses the public surface, and it enforces the privacy
 * invariant: it NEVER carries `instrument_hash`, `network_id`,
 * `network_signature`, the full attestation records, or `plan_hash`. Those
 * stay inside the signed bundle for offline verification. The public surface
 * returns only the consumer-relevant summary + a tri-state verdict.
 *
 * Tri-state `verified`:
 *  - `true`  — verified; `verificationReason` MUST be null.
 *  - `false` — definitive failure; `verificationReason` names it.
 *  - `null` + reason `ac1_counterparty_check_unavailable` — the substrate-error
 *    tri-state (rule 9's resolver was unreachable); NOT a definitive false.
 *  - `null` + no reason — no AC-1 record bound to this evidence.
 */

import type {
  AC1Reason,
  CounterpartyKind,
  Network,
  TransactionKind,
  TransactionProofRecord,
  TransactionVerificationResult,
} from "./types.js";

export interface TransactionBlock {
  intent: { kind: TransactionKind; amount: number; currency: string };
  counterparty: { id: string; kind: CounterpartyKind };
  network: Network;
  verified: boolean | null;
  verification_reason: AC1Reason | null;
}

/**
 * Build the public `transaction` block from a record + its verification result.
 * Returns `null` when there is no AC-1 record (the endpoint omits the block).
 * Throws when `record` is present but `result` is missing — the endpoint must
 * verify before rendering.
 */
export function renderTransactionBlock(
  record: TransactionProofRecord | null,
  result: TransactionVerificationResult | null,
): TransactionBlock | null {
  if (record === null) return null;
  if (result === null) {
    throw new Error("renderTransactionBlock: result is required when record is provided");
  }

  let verified: boolean | null;
  let reason: AC1Reason | null;
  if (result.valid) {
    verified = true;
    reason = null;
  } else if (result.reason === "ac1_counterparty_check_unavailable") {
    // Substrate-error tri-state: structurally valid, but rule 9's substrate
    // was unreachable. verified=null (not false), reason carried.
    verified = null;
    reason = result.reason;
  } else {
    verified = false;
    reason = result.reason ?? null;
  }

  const p = record.payload;
  return {
    intent: { kind: p.intent.kind, amount: p.intent.amount, currency: p.intent.currency },
    counterparty: { id: p.counterparty.id, kind: p.counterparty.kind },
    network: p.network_receipt.network,
    verified,
    verification_reason: reason,
  };
}

/** The fields that MUST NEVER appear on the public transaction block (ADR-018 §5). */
export const FORBIDDEN_PUBLIC_FIELDS: readonly string[] = [
  "instrument_hash",
  "network_id",
  "network_signature",
  "plan_hash",
  "principal_attestation",
  "agent_attestation",
  "device_attestation",
];
