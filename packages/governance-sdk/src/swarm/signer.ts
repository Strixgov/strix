/**
 * Agent Swarm v1 (Delegation Kernel) — signers.
 *
 * Contract: `docs/architecture/agent-swarm-v1.md` contractVersion 0.2.0.
 *
 * Mints the three signed artifacts. Mirrors the AA-1 signer idiom
 * (`src/actor-attestation/signer.ts`): pure function, no DB, no key loading —
 * the caller supplies the private key and persists the result inside the SE v1
 * transaction. SCJ v1 canonicalization (CJ-1) + Ed25519, byte-for-byte
 * compatible with the AA-1 / ISCG signers so the same verifier primitives
 * apply.
 *
 * Load-bearing rules enforced here at mint time (the rest is the verifier's job):
 *   - SW-2 / SW-5: a delegation MUST attenuate its parent (capability ⊆,
 *     risk ≤, scope narrows, TTL contained, budget ≤). Amplification aborts.
 *   - SW-1: a delegation is bound to a swarmRunId; the run carries the human root.
 *   - SW-3: there is NO token field on any swarm artifact. A delegation is not
 *     an execution grant — the type system makes a token unrepresentable.
 *   - The delegation edge is signed by the DELEGATOR's key (ST-10): a delegatee
 *     cannot forge an inbound edge. The caller supplies the delegator's key.
 */

import { createHash, sign as cryptoSign, type KeyObject } from "node:crypto";
import { canonicalizeJSON } from "../actor-attestation/scj-v1-mirror.js";
import { isStrictRfc3339Mirror } from "../agents/loader.js";
import {
  attenuates,
  type RiskLevel,
  type SwarmAuthority,
} from "./attenuation.js";
import type {
  SwarmRunPayload,
  SwarmRunEnvelope,
  SwarmDelegationPayload,
  SwarmDelegationEnvelope,
  SwarmActionEvidencePayload,
  SwarmActionEvidenceEnvelope,
} from "./types.js";

// ─── Errors ─────────────────────────────────────────────────────────────────

export const SWARM_SIGNER_ERRORS = {
  TIMESTAMP_INVALID: "SWARM_SIGN_TIMESTAMP_INVALID",
  WINDOW_INVALID: "SWARM_SIGN_WINDOW_INVALID",
  ROOT_UNAUTHORIZED: "SWARM_SIGN_ROOT_UNAUTHORIZED",
  DEPTH_EXCEEDED: "SWARM_SIGN_DEPTH_EXCEEDED",
  AMPLIFICATION: "SWARM_SIGN_AMPLIFICATION",
  LINEAGE_INVALID: "SWARM_SIGN_LINEAGE_INVALID",
  SIGNING_UNAVAILABLE: "SWARM_SIGN_SIGNING_UNAVAILABLE",
  PAYLOAD_INVALID: "SWARM_SIGN_PAYLOAD_INVALID",
} as const;

export type SwarmSignerErrorCode =
  (typeof SWARM_SIGNER_ERRORS)[keyof typeof SWARM_SIGNER_ERRORS];

export class SwarmSignerError extends Error {
  readonly code: SwarmSignerErrorCode;
  /** When an amplification aborts, the granular attenuation reason. */
  readonly attenuationReason?: string;
  constructor(code: SwarmSignerErrorCode, detail?: string, attenuationReason?: string) {
    super(`${code}${detail ? ": " + detail : ""}`);
    this.code = code;
    this.attenuationReason = attenuationReason;
    this.name = "SwarmSignerError";
  }
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function sha256Hex(canonical: string): string {
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

function signEnvelope(envelope: unknown, privateKey: KeyObject): {
  canonicalPayloadHash: string;
  signature: string;
} {
  const canonicalEnvelope = canonicalizeJSON(envelope);
  const sig = cryptoSign(null, Buffer.from(canonicalEnvelope, "utf-8"), privateKey);
  return {
    canonicalPayloadHash: sha256Hex(canonicalEnvelope),
    signature: sig.toString("base64"),
  };
}

function requireStrictWindow(notBefore: string, notAfter: string): void {
  if (!isStrictRfc3339Mirror(notBefore) || !isStrictRfc3339Mirror(notAfter)) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.TIMESTAMP_INVALID,
      `window not strict RFC3339: [${notBefore}, ${notAfter}]`,
    );
  }
  if (Date.parse(notAfter) <= Date.parse(notBefore)) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.WINDOW_INVALID,
      `notAfter must be after notBefore`,
    );
  }
}

/** Convert a payload's `budget: number | null` to the algebra's `budget?: number`. */
function toAuthority(a: {
  capabilities: string[];
  riskCeiling: RiskLevel;
  scope: Record<string, unknown>;
  notBefore: string;
  notAfter: string;
  budget: number | null;
}): SwarmAuthority {
  return {
    capabilities: a.capabilities,
    riskCeiling: a.riskCeiling,
    scope: a.scope,
    notBefore: a.notBefore,
    notAfter: a.notAfter,
    budget: a.budget === null ? undefined : a.budget,
  };
}

// ─── swarm_run_v1 ───────────────────────────────────────────────────────────

export interface SignSwarmRunInput {
  payload: SwarmRunPayload;
  environment: string;
  tenantId: string;
  /** SW-1: the run may only be minted once its root decision is EXECUTED. */
  rootDecisionExecuted: boolean;
}

export interface SignSwarmRunResult {
  envelope: SwarmRunEnvelope;
  signature: string;
  canonicalPayloadHash: string;
  signatureAlgorithm: "Ed25519";
}

/** Mint the authority anchor. Signed by the platform operational key. */
export function signSwarmRun(
  input: SignSwarmRunInput,
  operationalPrivateKey: KeyObject | null,
): SignSwarmRunResult {
  const p = input.payload;
  if (!input.rootDecisionExecuted) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.ROOT_UNAUTHORIZED,
      "swarm_run_v1 requires an EXECUTED root decision (SW-1)",
    );
  }
  if (!p.rootDecisionId || !p.rootApprovalId || !p.rootActorId) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.ROOT_UNAUTHORIZED,
      "missing rootDecisionId / rootApprovalId / rootActorId (SW-1)",
    );
  }
  if (!Number.isInteger(p.maxDepth) || p.maxDepth < 1 ||
      !Number.isInteger(p.maxFanout) || p.maxFanout < 1) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.PAYLOAD_INVALID,
      "maxDepth and maxFanout must be positive integers (SW-7)",
    );
  }
  requireStrictWindow(p.openedAt, p.expiresAt);
  if (operationalPrivateKey === null) {
    throw new SwarmSignerError(SWARM_SIGNER_ERRORS.SIGNING_UNAVAILABLE, "swarm_run_v1");
  }
  const envelope: SwarmRunEnvelope = {
    ...p,
    environment: input.environment,
    tenantId: input.tenantId,
  };
  const { canonicalPayloadHash, signature } = signEnvelope(envelope, operationalPrivateKey);
  return { envelope, signature, canonicalPayloadHash, signatureAlgorithm: "Ed25519" };
}

// ─── swarm_delegation_v1 (the delegation edge) ──────────────────────────────

export interface SignSwarmDelegationInput {
  payload: SwarmDelegationPayload;
  environment: string;
  tenantId: string;
  /**
   * The effective authority of the PARENT — the parent edge, or the run root
   * for depth=1. The minted edge MUST attenuate this (SW-2 + SW-5).
   */
  parentAuthority: SwarmAuthority;
  /** Parent depth (run root = 0); the edge's depth MUST equal parentDepth + 1. */
  parentDepth: number;
  /** run.maxDepth — the edge's depth MUST be ≤ this (SW-7). */
  maxDepth: number;
  /**
   * For depth>1, the delegatorAgentId MUST equal the parent edge's
   * delegateeAgentId (an agent re-delegates only authority it received).
   * Pass the run-root's authorized agent for depth=1.
   */
  parentDelegateeAgentId: string;
}

export interface SignSwarmDelegationResult {
  envelope: SwarmDelegationEnvelope;
  signature: string;
  canonicalPayloadHash: string;
  signatureAlgorithm: "Ed25519";
}

/**
 * Mint a delegation edge. Signed by the DELEGATOR's AA-1 private key (ST-10):
 * the caller resolves the delegator's key; there is no platform-key fallback.
 */
export function signSwarmDelegation(
  input: SignSwarmDelegationInput,
  delegatorPrivateKey: KeyObject | null,
): SignSwarmDelegationResult {
  const p = input.payload;

  // Lineage (SW-4 / SW-PRE-2): the delegator must be the party that received
  // the parent authority.
  if (p.delegatorAgentId !== input.parentDelegateeAgentId) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.LINEAGE_INVALID,
      `delegatorAgentId(${p.delegatorAgentId}) ≠ parent delegatee(${input.parentDelegateeAgentId})`,
    );
  }

  // Depth (SW-7).
  if (p.depth !== input.parentDepth + 1) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.PAYLOAD_INVALID,
      `depth(${p.depth}) must equal parentDepth+1(${input.parentDepth + 1})`,
    );
  }
  if (p.depth > input.maxDepth) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.DEPTH_EXCEEDED,
      `depth(${p.depth}) > maxDepth(${input.maxDepth})`,
    );
  }

  requireStrictWindow(p.notBefore, p.notAfter);
  if (!isStrictRfc3339Mirror(p.issuedAt)) {
    throw new SwarmSignerError(SWARM_SIGNER_ERRORS.TIMESTAMP_INVALID, `issuedAt: ${p.issuedAt}`);
  }

  // SW-2 + SW-5: the edge MUST attenuate the parent authority. This is the
  // load-bearing mint-time check — amplification never gets signed.
  const childAuthority = toAuthority({
    capabilities: p.capabilitySubset,
    riskCeiling: p.riskCeiling,
    scope: p.scopeSubset,
    notBefore: p.notBefore,
    notAfter: p.notAfter,
    budget: p.budget,
  });
  const result = attenuates(input.parentAuthority, childAuthority);
  if (!result.held) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.AMPLIFICATION,
      result.detail ?? result.reason,
      result.reason,
    );
  }

  if (delegatorPrivateKey === null) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.SIGNING_UNAVAILABLE,
      "delegation edge requires the delegator's key; no platform-key fallback (ST-10)",
    );
  }

  const envelope: SwarmDelegationEnvelope = {
    ...p,
    environment: input.environment,
    tenantId: input.tenantId,
  };
  const { canonicalPayloadHash, signature } = signEnvelope(envelope, delegatorPrivateKey);
  return { envelope, signature, canonicalPayloadHash, signatureAlgorithm: "Ed25519" };
}

// ─── swarm_action_evidence_v1 (attribution sibling) ─────────────────────────

export interface SignSwarmActionEvidenceInput {
  payload: SwarmActionEvidencePayload;
  environment: string;
  tenantId: string;
}

export interface SignSwarmActionEvidenceResult {
  envelope: SwarmActionEvidenceEnvelope;
  signature: string;
  canonicalPayloadHash: string;
  signatureAlgorithm: "Ed25519";
}

/** Mint the attribution sibling. Signed by the platform operational key. */
export function signSwarmActionEvidence(
  input: SignSwarmActionEvidenceInput,
  operationalPrivateKey: KeyObject | null,
): SignSwarmActionEvidenceResult {
  const p = input.payload;
  if (p.delegationPath.length !== p.delegationDepth) {
    throw new SwarmSignerError(
      SWARM_SIGNER_ERRORS.PAYLOAD_INVALID,
      `delegationPath length(${p.delegationPath.length}) ≠ delegationDepth(${p.delegationDepth})`,
    );
  }
  if (!isStrictRfc3339Mirror(p.createdAt)) {
    throw new SwarmSignerError(SWARM_SIGNER_ERRORS.TIMESTAMP_INVALID, `createdAt: ${p.createdAt}`);
  }
  if (operationalPrivateKey === null) {
    throw new SwarmSignerError(SWARM_SIGNER_ERRORS.SIGNING_UNAVAILABLE, "swarm_action_evidence_v1");
  }
  const envelope: SwarmActionEvidenceEnvelope = {
    ...p,
    environment: input.environment,
    tenantId: input.tenantId,
  };
  const { canonicalPayloadHash, signature } = signEnvelope(envelope, operationalPrivateKey);
  return { envelope, signature, canonicalPayloadHash, signatureAlgorithm: "Ed25519" };
}
