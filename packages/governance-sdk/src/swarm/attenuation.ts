/**
 * @strixgov/sdk — Agent Swarm v1: delegation attenuation algebra (SW-2)
 *
 * Contract: `docs/architecture/agent-swarm-v1.md` contractVersion 0.1.0.
 *
 * This is the testable heart of the Agent Swarm moat. A swarm is a directed
 * delegation graph; SW-2 ("monotonic attenuation") says a delegation edge may
 * only ever NARROW authority — never widen it. This module is the pure
 * function that decides whether a child's authority is a subset of its
 * parent's, with no I/O, no signing, and no schema dependency. Every other
 * swarm surface (the delegator-signed `swarm_delegation_v1` edge, the
 * persistence layer, the proof surface) wraps this algebra.
 *
 * Two load-bearing properties this module guarantees:
 *
 *   1. Attenuation is a SUBSET relation, not an equality relation. A child may
 *      drop capabilities, tighten scope, lower risk, and shorten TTL. It may
 *      never add a capability, relax a scope constraint, raise risk, or extend
 *      TTL. The empty authority is a valid (do-nothing) attenuation.
 *
 *   2. Attenuation is evaluated ROOT-DOWN over a path, never per-edge in
 *      isolation. `attenuatesPath` recomputes the effective authority at each
 *      hop, so an amplification three hops deep is caught even when every
 *      individual edge looked locally plausible — the same "recompute from the
 *      trail, never trust the stored claim" discipline as K-BIND-1.
 *
 * No cryptography lives here. Whether the EDGE is authentic (signed by the
 * delegator's AA-1 key) is the verifier's job; whether the edge is ADMISSIBLE
 * (subset of its parent) is this module's job. Keeping them separate is what
 * makes the moat testable in isolation.
 */

/** Risk ladder. Mirrors `graph/types.ts` RiskLevel; kept local so the swarm
 *  attenuation algebra carries no runtime coupling to the capability graph. */
export type RiskLevel = "low" | "medium" | "high" | "critical";

const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * The authority an actor holds at a point in the delegation graph. The run
 * root and every delegation edge both expose authority in this shape, so the
 * same subset check applies uniformly at every hop.
 */
export interface SwarmAuthority {
  /** Capabilities the holder may exercise. Order-insensitive; treated as a set. */
  capabilities: readonly string[];
  /** Maximum risk any action under this authority may carry. */
  riskCeiling: RiskLevel;
  /**
   * Scope constraints. Each value is interpreted as a constraint:
   *   - array  → an enumeration of allowed values (narrowing = subset)
   *   - object → a nested constraint map (narrowing = recursive)
   *   - scalar → a pinned value (narrowing = unchanged; cannot be re-pinned)
   * A child may ADD keys (new constraints) but may never DROP or RELAX a
   * parent key.
   */
  scope: Readonly<Record<string, unknown>>;
  /** Validity window start, strict RFC 3339. */
  notBefore: string;
  /** Validity window end, strict RFC 3339. */
  notAfter: string;
  /**
   * SW-5 (Exhaustible). The maximum number of governed actions that may be
   * exercised under this authority — authority as a consumable resource, not a
   * flag. `undefined` means no budget constraint is introduced at this node
   * (the node inherits whatever bound, if any, its ancestors imposed). A child
   * may TIGHTEN the budget (or introduce one), never loosen it: you cannot
   * delegate more uses than you hold.
   */
  budget?: number;
}

/**
 * Granular reason a child failed to attenuate its parent. All of the
 * amplification variants map to the public `SWARM_AMPLIFICATION_DETECTED`
 * integrity code (see `toSwarmIntegrityReason`); the granular code is for
 * diagnostics and tests, not the wire contract.
 */
export type AttenuationReason =
  | "ATTENUATION_OK"
  | "CAPABILITY_AMPLIFIED" // child holds a capability the parent did not
  | "RISK_AMPLIFIED" // child riskCeiling > parent riskCeiling
  | "SCOPE_RELAXED" // child dropped or widened a parent scope constraint
  | "TTL_EXTENDED" // child validity window not contained in parent's
  | "TTL_UNPARSEABLE" // a timestamp was not strict-RFC-3339-parseable (fail closed)
  | "BUDGET_AMPLIFIED"; // SW-5: child budget unbounded-under-bounded, > parent, or invalid

export interface AttenuationResult {
  /** True iff the child's authority is a subset of the parent's at every axis. */
  readonly held: boolean;
  readonly reason: AttenuationReason;
  /**
   * When `held` is false, a human-readable pointer to the offending axis/key.
   * Never part of any signed payload — diagnostics only.
   */
  readonly detail?: string;
}

const OK: AttenuationResult = { held: true, reason: "ATTENUATION_OK" };

/**
 * SW-2 single-hop check: does `child` attenuate (narrow) `parent`?
 *
 * Pure. Order-insensitive on capabilities. Fail-closed on unparseable
 * timestamps. Returns the FIRST failing axis (capabilities → risk → scope →
 * TTL) so callers get a stable, deterministic reason.
 */
export function attenuates(
  parent: SwarmAuthority,
  child: SwarmAuthority,
): AttenuationResult {
  // 1. Capabilities narrow: child ⊆ parent.
  const parentCaps = new Set(parent.capabilities);
  for (const cap of child.capabilities) {
    if (!parentCaps.has(cap)) {
      return {
        held: false,
        reason: "CAPABILITY_AMPLIFIED",
        detail: `capability "${cap}" not held by parent`,
      };
    }
  }

  // 2. Risk does not rise.
  if (RISK_RANK[child.riskCeiling] > RISK_RANK[parent.riskCeiling]) {
    return {
      held: false,
      reason: "RISK_AMPLIFIED",
      detail: `child risk "${child.riskCeiling}" exceeds parent "${parent.riskCeiling}"`,
    };
  }

  // 3. Scope narrows.
  const scope = scopeNarrows(parent.scope, child.scope, "");
  if (!scope.held) return scope;

  // 4. TTL does not extend: child window ⊆ parent window.
  const pStart = parseInstant(parent.notBefore);
  const pEnd = parseInstant(parent.notAfter);
  const cStart = parseInstant(child.notBefore);
  const cEnd = parseInstant(child.notAfter);
  if (pStart === null || pEnd === null || cStart === null || cEnd === null) {
    return {
      held: false,
      reason: "TTL_UNPARSEABLE",
      detail: "a validity-window timestamp was not strict-RFC-3339-parseable",
    };
  }
  if (cStart < pStart || cEnd > pEnd) {
    return {
      held: false,
      reason: "TTL_EXTENDED",
      detail: "child validity window is not contained in parent's",
    };
  }

  // 5. Budget does not amplify (SW-5). You cannot delegate more uses than you
  //    hold, and you cannot go unbounded beneath a bounded parent.
  const budget = budgetNarrows(parent.budget, child.budget);
  if (!budget.held) return budget;

  return OK;
}

function budgetNarrows(
  parentBudget: number | undefined,
  childBudget: number | undefined,
): AttenuationResult {
  // Parent imposes no budget → child may introduce any (tightening) or none.
  if (parentBudget === undefined) {
    if (childBudget !== undefined && !isValidBudget(childBudget)) {
      return budgetAmplified("child budget is not a non-negative integer");
    }
    return OK;
  }
  // Parent is bounded. Child MUST be bounded and ≤ parent (unbounded-under-
  // bounded is the classic amplification, fail closed).
  if (childBudget === undefined) {
    return budgetAmplified("child is unbounded beneath a budgeted parent");
  }
  if (!isValidBudget(childBudget)) {
    return budgetAmplified("child budget is not a non-negative integer");
  }
  if (childBudget > parentBudget) {
    return budgetAmplified(
      `child budget ${childBudget} exceeds parent budget ${parentBudget}`,
    );
  }
  return OK;
}

function budgetAmplified(detail: string): AttenuationResult {
  return { held: false, reason: "BUDGET_AMPLIFIED", detail: `budget: ${detail}` };
}

function isValidBudget(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/**
 * SW-5 runtime exhaustion check. Authority decays: each governed action under
 * a delegation consumes one unit of its budget; at zero the authority is
 * exhausted and further proposals are denied. The verifier re-derives this by
 * counting the actions attributed to a delegation and comparing to its budget
 * — it never trusts a stored "remaining" counter (K-BIND-1 discipline).
 *
 * Returns the public integrity code directly: `SWARM_VERIFIED` while budget
 * remains (or is unbounded), `SWARM_BUDGET_EXCEEDED` once consumption passes
 * the budget. Fails closed on a malformed budget.
 */
export function checkBudget(
  budget: number | undefined,
  consumed: number,
): {
  ok: boolean;
  remaining: number | null;
  integrity: "SWARM_VERIFIED" | "SWARM_BUDGET_EXCEEDED";
} {
  if (budget === undefined) {
    return { ok: true, remaining: null, integrity: "SWARM_VERIFIED" };
  }
  if (!isValidBudget(budget) || !isValidBudget(consumed)) {
    return { ok: false, remaining: 0, integrity: "SWARM_BUDGET_EXCEEDED" };
  }
  const remaining = budget - consumed;
  return remaining >= 0
    ? { ok: true, remaining, integrity: "SWARM_VERIFIED" }
    : { ok: false, remaining: 0, integrity: "SWARM_BUDGET_EXCEEDED" };
}

/**
 * SW-2 path check: recompute effective authority ROOT-DOWN and require every
 * hop to attenuate the hop above it. `edges` are ordered root→executor (the
 * `delegationPath` on a `swarm_action_evidence_v1` record). `root` is the
 * `swarm_run_v1` ceiling.
 *
 * Catches multi-hop amplification that per-edge checks miss: each edge is
 * checked against the ACCUMULATED parent, not just the edge declared above it.
 */
export function attenuatesPath(
  root: SwarmAuthority,
  edges: readonly SwarmAuthority[],
): { held: boolean; reason: AttenuationReason; failedAtIndex: number } {
  let effectiveParent = root;
  for (let i = 0; i < edges.length; i++) {
    const result = attenuates(effectiveParent, edges[i]!);
    if (!result.held) {
      return { held: false, reason: result.reason, failedAtIndex: i };
    }
    effectiveParent = edges[i]!;
  }
  return { held: true, reason: "ATTENUATION_OK", failedAtIndex: -1 };
}

/**
 * Maps a granular attenuation failure to the public, stable swarm-integrity
 * reason code (`docs/architecture/agent-swarm-v1.md` §"swarmIntegrityReason").
 * Every amplification axis collapses to one wire code; the granular reason
 * stays for diagnostics. Adding/renaming a public code is a breaking change.
 */
export function toSwarmIntegrityReason(
  reason: AttenuationReason,
): "SWARM_VERIFIED" | "SWARM_AMPLIFICATION_DETECTED" {
  return reason === "ATTENUATION_OK"
    ? "SWARM_VERIFIED"
    : "SWARM_AMPLIFICATION_DETECTED";
}

// ─── Scope narrowing ──────────────────────────────────────────────────────

function scopeNarrows(
  parent: Readonly<Record<string, unknown>>,
  child: Readonly<Record<string, unknown>>,
  path: string,
): AttenuationResult {
  // Every parent constraint must still be present and at least as tight in the
  // child. Dropping a parent key relaxes authority → amplification.
  for (const key of Object.keys(parent)) {
    const here = path ? `${path}.${key}` : key;
    if (!(key in child)) {
      return {
        held: false,
        reason: "SCOPE_RELAXED",
        detail: `scope constraint "${here}" dropped by child`,
      };
    }
    const v = valueNarrows(parent[key], child[key], here);
    if (!v.held) return v;
  }
  // Extra keys in the child are ADDED constraints — narrowing, always allowed.
  return OK;
}

function valueNarrows(
  parentVal: unknown,
  childVal: unknown,
  path: string,
): AttenuationResult {
  // Array constraint = enumeration of allowed values. Child must be a subset.
  if (Array.isArray(parentVal)) {
    if (!Array.isArray(childVal)) {
      return relaxed(path, "expected child to refine an enumeration");
    }
    const allowed = new Set(parentVal.map(stableKey));
    for (const item of childVal) {
      if (!allowed.has(stableKey(item))) {
        return relaxed(path, `value ${JSON.stringify(item)} outside parent enumeration`);
      }
    }
    return OK;
  }

  // Object constraint = nested map. Recurse.
  if (isPlainObject(parentVal)) {
    if (!isPlainObject(childVal)) {
      return relaxed(path, "expected child to refine a nested constraint object");
    }
    return scopeNarrows(parentVal, childVal, path);
  }

  // Scalar constraint = a pinned value. The child may not change it.
  if (stableKey(parentVal) !== stableKey(childVal)) {
    return relaxed(path, "pinned scalar constraint changed by child");
  }
  return OK;
}

function relaxed(path: string, why: string): AttenuationResult {
  return { held: false, reason: "SCOPE_RELAXED", detail: `scope "${path}": ${why}` };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Stable comparison key for primitives/values inside enumerations. */
function stableKey(v: unknown): string {
  return typeof v === "string" ? `s:${v}` : `j:${JSON.stringify(v)}`;
}

/**
 * Minimal strict-RFC-3339 instant parse. Returns epoch ms, or null if the
 * string is not an RFC-3339 date-time with an explicit offset / Z. We do NOT
 * fall back to permissive `Date.parse` semantics — an unparseable timestamp is
 * a fail-closed amplification, mirroring `solo-builder-core/src/rfc3339.ts`
 * discipline (false-positive rejection beats silent acceptance).
 */
function parseInstant(s: unknown): number | null {
  if (typeof s !== "string") return null;
  // RFC 3339 date-time: YYYY-MM-DDThh:mm:ss(.frac)?(Z|±hh:mm)
  const RFC3339 =
    /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
  if (!RFC3339.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}
