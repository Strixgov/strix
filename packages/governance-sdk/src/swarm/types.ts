/**
 * Agent Swarm v1 (the Delegation Kernel) — canonical payload + envelope types.
 *
 * Contract: `docs/architecture/agent-swarm-v1.md` contractVersion 0.2.0.
 *
 * Three signed artifacts, each canonicalized through SCJ v1 (CJ-1) and signed
 * Ed25519. Field SETS are the contract (SCJ sorts keys, so byte-stability comes
 * from the field set + values, not source order); adding/removing a field is a
 * schema-version event. Every signed envelope = payload + `environment` +
 * `tenantId`, captured at signing time and read from the stored row at verify
 * time, never from `process.env` (SE-14 parity).
 *
 *   - swarm_run_v1            — the authority anchor (13 payload fields)
 *   - swarm_delegation_v1     — the delegation edge (16 payload fields); the
 *                               novel primitive, signed by the DELEGATOR's
 *                               AA-1 agent key
 *   - swarm_action_evidence_v1 — the attribution sibling joined to SE v1 (10
 *                               payload fields)
 */

import type { RiskLevel } from "./attenuation.js";

// ─── swarm_run_v1 ───────────────────────────────────────────────────────────

/** Authority-anchor payload (13 fields, see contract §"swarm_run_v1"). */
export interface SwarmRunPayload {
  schemaVersion: 1;
  swarmRunId: string;
  /** The APPROVED decision that opened the run (SW-1). */
  rootDecisionId: string;
  /** The signed approval artifact proving who authorized (SW-1). */
  rootApprovalId: string;
  /** The human/operator principal the run acts for (SW-6 quorum anchor). */
  rootActorId: string;
  /** Maximal capability set ANY agent in the run may exercise (sorted). */
  capabilityCeiling: string[];
  riskCeiling: RiskLevel;
  /** Maximal scope (the attenuation root). SCJ-canonical. */
  scopeCeiling: Record<string, unknown>;
  /** SW-5 root budget; null = unbounded run. */
  budgetCeiling: number | null;
  maxDepth: number;
  maxFanout: number;
  openedAt: string;
  expiresAt: string;
}

export interface SwarmRunEnvelope extends SwarmRunPayload {
  environment: string;
  tenantId: string;
}

// ─── swarm_delegation_v1 (the delegation edge) ──────────────────────────────

/** Delegation-edge payload (16 fields, see contract §"swarm_delegation_v1"). */
export interface SwarmDelegationPayload {
  schemaVersion: 1;
  delegationId: string;
  swarmRunId: string;
  /** null iff the parent is the run root; forms the delegationPath (SW-4). */
  parentDelegationId: string | null;
  /** 1 at the first hop; MUST be ≤ run.maxDepth (SW-7). */
  depth: number;
  /** Issuing agent's AA-1 identity — the signer of this edge. */
  delegatorAgentId: string;
  /** Receiving agent's AA-1 identity. */
  delegateeAgentId: string;
  /** MUST be ⊆ the parent's effective capability set (SW-2). Sorted. */
  capabilitySubset: string[];
  /** MUST be ≤ parent riskCeiling (SW-2). */
  riskCeiling: RiskLevel;
  /** MUST narrow parent scope (SW-2). SCJ-canonical. */
  scopeSubset: Record<string, unknown>;
  /** SW-5: max governed actions under this edge; MUST be ≤ parent budget. null only if unbounded all the way up. */
  budget: number | null;
  /** SHA-256(SCJ v1(task descriptor)); binds the edge to ONE task (ST-2). */
  taskHash: string;
  /** Single-use per (swarmRunId, delegateeAgentId) — replay defense. */
  nonce: string;
  notBefore: string;
  /** MUST be ≤ parent notAfter AND ≤ run.expiresAt (SW-2 TTL attenuation). */
  notAfter: string;
  issuedAt: string;
}

export interface SwarmDelegationEnvelope extends SwarmDelegationPayload {
  environment: string;
  tenantId: string;
}

// ─── swarm_action_evidence_v1 (attribution sibling) ─────────────────────────

/** Attribution sibling payload (10 fields). Joined to SE v1 by evidenceId. */
export interface SwarmActionEvidencePayload {
  schemaVersion: 1;
  swarmActionId: string;
  /** Joins to the SE v1 record (and transitively to AA-1). */
  evidenceId: string;
  swarmRunId: string;
  /** Ordered delegationIds, root→executor; reconstructs the lineage (SW-4). */
  delegationPath: string[];
  delegationDepth: number;
  proposerAgentId: string;
  /** The SINGLE accountable executor (SW-4); AA-1 attested. */
  executingAgentId: string;
  /** Echoes the executing delegation's taskHash (ST-2). */
  taskHash: string;
  /** ≥ the SE v1 record's createdAt. */
  createdAt: string;
}

export interface SwarmActionEvidenceEnvelope extends SwarmActionEvidencePayload {
  environment: string;
  tenantId: string;
}

// ─── Stable integrity reason codes (public wire contract) ───────────────────

/** Mirrors `docs/architecture/agent-swarm-v1.md` §"swarmIntegrityReason". */
export const SWARM_INTEGRITY_REASONS = [
  "SWARM_VERIFIED",
  "SWARM_UNROOTED",
  "SWARM_PATH_BROKEN",
  "SWARM_AMPLIFICATION_DETECTED",
  "SWARM_DEPTH_EXCEEDED",
  "SWARM_FANOUT_EXCEEDED",
  "SWARM_ORPHAN_SIDE_EFFECT",
  "SWARM_TASK_HASH_MISMATCH",
  "SWARM_BUDGET_EXCEEDED",
  "SWARM_DELEGATION_REPLAYED",
  "SWARM_SELF_QUORUM",
  "SWARM_EXPIRED",
  "SWARM_TOKEN_INHERITED",
  "SWARM_LEGACY_NON_SWARM",
] as const;

export type SwarmIntegrityReason = (typeof SWARM_INTEGRITY_REASONS)[number];
