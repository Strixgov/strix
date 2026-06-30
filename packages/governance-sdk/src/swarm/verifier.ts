/**
 * Agent Swarm v1 (Delegation Kernel) — verifier.
 *
 * Contract: `docs/architecture/agent-swarm-v1.md` contractVersion 0.2.0.
 *
 * Re-derives the `swarm` integrity block (SW-1…SW-5) from the signed artifacts.
 * It NEVER trusts a stored integrity flag — every property is recomputed from
 * the signed bytes (K-BIND-1 discipline), exactly like the AA-1 verifier.
 *
 * Key resolution is dependency-injected (mirrors AA-1's chain-verifier-factory)
 * so the verifier is pure and testable offline: a third party supplies the
 * delegators' public keys (from the public JWKS) and re-runs this with no Strix
 * tooling — the property that makes the delegation graph independently
 * verifiable.
 */

import { verify as cryptoVerify, type KeyObject } from "node:crypto";
import { canonicalizeJSON } from "../actor-attestation/scj-v1-mirror.js";
import { attenuatesPath, checkBudget, type SwarmAuthority } from "./attenuation.js";
import type {
  SwarmRunEnvelope,
  SwarmDelegationEnvelope,
  SwarmActionEvidenceEnvelope,
  SwarmIntegrityReason,
} from "./types.js";

/** Resolve a delegator agent's Ed25519 public key (e.g. from the public JWKS). */
export type DelegatorKeyResolver = (delegatorAgentId: string) => KeyObject | null;

export interface SwarmChainVerifyInput {
  run: SwarmRunEnvelope;
  /** Did run.rootDecisionId resolve to an APPROVED decision + valid approval? (SW-1) */
  rootDecisionApproved: boolean;
  /** The agent the run root authorized to act at depth 1 (delegatee of the root). */
  rootAuthorizedAgentId: string;
  /** Ordered root→executor. */
  edges: SwarmDelegationEnvelope[];
  /** base64 Ed25519 signatures, index-aligned with `edges`. */
  signatures: string[];
  resolveDelegatorPublicKey: DelegatorKeyResolver;
  /** Optional wall clock for window checks; omit to skip the expiry check. */
  now?: Date;
}

export interface SwarmChainVerifyResult {
  verified: boolean;
  reason: SwarmIntegrityReason;
  /** Index of the offending edge, or -1. */
  failedAtIndex: number;
  /** Convenience booleans for the proof-surface `swarm` block. */
  rooted: boolean;
  pathVerified: boolean;
  attenuationHeld: boolean;
}

function fail(
  reason: SwarmIntegrityReason,
  failedAtIndex: number,
  partial: Partial<SwarmChainVerifyResult> = {},
): SwarmChainVerifyResult {
  return {
    verified: false,
    reason,
    failedAtIndex,
    rooted: partial.rooted ?? false,
    pathVerified: partial.pathVerified ?? false,
    attenuationHeld: partial.attenuationHeld ?? false,
  };
}

function runAuthority(run: SwarmRunEnvelope): SwarmAuthority {
  return {
    capabilities: run.capabilityCeiling,
    riskCeiling: run.riskCeiling,
    scope: run.scopeCeiling,
    notBefore: run.openedAt,
    notAfter: run.expiresAt,
    budget: run.budgetCeiling === null ? undefined : run.budgetCeiling,
  };
}

function edgeAuthority(e: SwarmDelegationEnvelope): SwarmAuthority {
  return {
    capabilities: e.capabilitySubset,
    riskCeiling: e.riskCeiling,
    scope: e.scopeSubset,
    notBefore: e.notBefore,
    notAfter: e.notAfter,
    budget: e.budget === null ? undefined : e.budget,
  };
}

/** Verify one edge's Ed25519 signature against the delegator's public key. */
function edgeSignatureValid(
  edge: SwarmDelegationEnvelope,
  signature: string,
  publicKey: KeyObject,
): boolean {
  const canonical = canonicalizeJSON(edge);
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonical, "utf-8"),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Verify a delegation chain root→executor. Returns the integrity verdict for
 * the `swarm` proof block. Evaluated in the contract's rule order; the first
 * failing rule sets the reason.
 */
export function verifySwarmDelegationChain(
  input: SwarmChainVerifyInput,
): SwarmChainVerifyResult {
  // Rule 1 — SW-1 rooting.
  if (
    !input.rootDecisionApproved ||
    !input.run.rootDecisionId ||
    !input.run.rootApprovalId ||
    !input.run.rootActorId
  ) {
    return fail("SWARM_UNROOTED", -1);
  }

  if (input.edges.length !== input.signatures.length) {
    return fail("SWARM_PATH_BROKEN", -1, { rooted: true });
  }

  const nowMs = input.now ? input.now.getTime() : null;
  const runStart = Date.parse(input.run.openedAt);
  const runEnd = Date.parse(input.run.expiresAt);

  // Rules 2/4/9 — per edge: signature, lineage, depth, window.
  let expectedDelegator = input.rootAuthorizedAgentId;
  for (let i = 0; i < input.edges.length; i++) {
    const edge = input.edges[i]!;

    // Rule 2 — signature by the delegator's key + lineage.
    const pub = input.resolveDelegatorPublicKey(edge.delegatorAgentId);
    if (pub === null || !edgeSignatureValid(edge, input.signatures[i]!, pub)) {
      return fail("SWARM_PATH_BROKEN", i, { rooted: true });
    }
    if (edge.delegatorAgentId !== expectedDelegator) {
      return fail("SWARM_PATH_BROKEN", i, { rooted: true });
    }

    // Rule 4 — depth.
    if (edge.depth !== i + 1) {
      return fail("SWARM_PATH_BROKEN", i, { rooted: true });
    }
    if (edge.depth > input.run.maxDepth) {
      return fail("SWARM_DEPTH_EXCEEDED", i, { rooted: true });
    }

    // Rule 9 — window: edge contained in the run, and (if now given) live.
    const eStart = Date.parse(edge.notBefore);
    const eEnd = Date.parse(edge.notAfter);
    if (eStart < runStart || eEnd > runEnd) {
      return fail("SWARM_EXPIRED", i, { rooted: true, pathVerified: false });
    }
    if (nowMs !== null && (nowMs < eStart || nowMs > eEnd)) {
      return fail("SWARM_EXPIRED", i, { rooted: true });
    }

    expectedDelegator = edge.delegateeAgentId;
  }

  // Rule 3 — SW-2/SW-5 attenuation, recomputed root-down.
  const path = attenuatesPath(
    runAuthority(input.run),
    input.edges.map(edgeAuthority),
  );
  if (!path.held) {
    return fail("SWARM_AMPLIFICATION_DETECTED", path.failedAtIndex, {
      rooted: true,
      pathVerified: true,
      attenuationHeld: false,
    });
  }

  return {
    verified: true,
    reason: "SWARM_VERIFIED",
    failedAtIndex: -1,
    rooted: true,
    pathVerified: true,
    attenuationHeld: true,
  };
}

// ─── SW-4 attribution + SW-5 runtime budget ─────────────────────────────────

export interface ActionAttributionInput {
  action: SwarmActionEvidenceEnvelope;
  /** The verified edges (root→executor) the action claims to descend from. */
  edges: SwarmDelegationEnvelope[];
  /**
   * Re-derived count of governed actions already attributed to the executing
   * delegation (SW-5). The verifier counts; it never reads a stored counter.
   */
  consumedUnderExecutingEdge: number;
}

export interface ActionAttributionResult {
  verified: boolean;
  reason: SwarmIntegrityReason;
}

/**
 * SW-4 + SW-5: confirm a governed action resolves to a single executor with an
 * unbroken delegation path, the right task, and budget remaining.
 */
export function verifyActionAttribution(
  input: ActionAttributionInput,
): ActionAttributionResult {
  const { action, edges } = input;

  // SW-4 — the path must match the verified edges exactly, root→executor.
  const edgeIds = edges.map((e) => e.delegationId);
  if (
    action.delegationPath.length !== edgeIds.length ||
    action.delegationPath.some((id, i) => id !== edgeIds[i])
  ) {
    return { verified: false, reason: "SWARM_ORPHAN_SIDE_EFFECT" };
  }
  const executingEdge = edges[edges.length - 1];
  if (!executingEdge || action.executingAgentId !== executingEdge.delegateeAgentId) {
    return { verified: false, reason: "SWARM_ORPHAN_SIDE_EFFECT" };
  }

  // ST-2 — task binding.
  if (action.taskHash !== executingEdge.taskHash) {
    return { verified: false, reason: "SWARM_TASK_HASH_MISMATCH" };
  }

  // SW-5 — runtime budget (re-derived consumption ≤ budget).
  const budget = checkBudget(
    executingEdge.budget === null ? undefined : executingEdge.budget,
    input.consumedUnderExecutingEdge,
  );
  if (!budget.ok) {
    return { verified: false, reason: "SWARM_BUDGET_EXCEEDED" };
  }

  return { verified: true, reason: "SWARM_VERIFIED" };
}
