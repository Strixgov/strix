/**
 * Capability reservation registry (mirror of `solo_builder.capabilities`).
 *
 * Three-state lifecycle is collapsed to the two states the verifier cares
 * about — RESERVED vs ACTIVE (ADR-003). Defaults match the Python source of
 * truth (`solo_builder.capabilities.RESERVED_CAPABILITIES`): AA-1 and MC-1 are
 * ACTIVE; CP-K-001, AA-2 and AC-1 remain RESERVED until their cross-repo
 * runtime lands (held-PR promotion pattern). The registry is process-global
 * like the Python one; `setStatus` is how a runtime or the conformance harness
 * promotes a capability.
 *
 * CP-K-001 (`execution_receipt_v1`) is exported here so SDK callers reference
 * the constant instead of typing the string (solo-builder-core#66 AT#4 — the
 * two reserved IDs that ticket named are CP-K-001 and AA-1). It is RESERVED in
 * both registries; the TS verifiers (AC-1 / MC-1 / proof-bundle) never gate on
 * it, so its presence is reservation/parity bookkeeping, not a verifier path.
 *
 * MC-1 (`mcp_proof_v1`) promotion gate — earned 2026-06-02: a real receipt
 * signed by the production operational key (`strix-prod-2026-06`) verifies
 * against the live public JWKS at /.well-known/strix-jwks.json with no Strix
 * account, passing every rule; before this flip the only failing rule was this
 * capability gate (rule 2). The RESERVED → ACTIVE flip below is the single,
 * deliberate change that lets a production Tool Action Receipt return VERIFIED.
 * Promoted concurrently with the Python registry (solo_builder.capabilities)
 * and shipped in @strixgov/sdk@0.4.0.
 */

export const CP_K_001 = "CP-K-001";
export const AA_1 = "AA-1";
export const AA_2 = "AA-2";
export const AC_1 = "AC-1";
export const MC_1 = "MC-1";

export enum ReservationStatus {
  RESERVED = "reserved",
  ACTIVE = "active",
}

const DEFAULT_STATUS: ReadonlyArray<[string, ReservationStatus]> = [
  [CP_K_001, ReservationStatus.RESERVED],
  [AA_1, ReservationStatus.ACTIVE],
  [AA_2, ReservationStatus.RESERVED],
  [AC_1, ReservationStatus.RESERVED],
  [MC_1, ReservationStatus.ACTIVE],
];

const STATUS = new Map<string, ReservationStatus>(DEFAULT_STATUS);

/** Stable error fragment when a capability is cited but not ACTIVE (ADR-003). */
export const CAPABILITY_RESERVED_NOT_ACTIVE = "capability_reserved_not_active";

/** Current status for a capability id, or null when the id is unknown. */
export function lookupStatus(id: string): ReservationStatus | null {
  return STATUS.get(id) ?? null;
}

/**
 * Mirror of `capabilities.policy_decision_error`: `null` iff the id is known
 * AND ACTIVE; otherwise the stable `CAPABILITY_RESERVED_NOT_ACTIVE` fragment.
 * A reserved-but-not-active (or unknown) capability cited in a signed record
 * fails verification — the held-PR promotion gate, enforced.
 */
export function policyDecisionError(id: string): string | null {
  return lookupStatus(id) === ReservationStatus.ACTIVE ? null : CAPABILITY_RESERVED_NOT_ACTIVE;
}

/** Promote/demote a capability (runtime + conformance harness use). */
export function setStatus(id: string, status: ReservationStatus): void {
  STATUS.set(id, status);
}

/** Snapshot the full registry — pair with `restoreStatus` for test isolation. */
export function snapshotStatus(): Map<string, ReservationStatus> {
  return new Map(STATUS);
}

export function restoreStatus(snapshot: Map<string, ReservationStatus>): void {
  STATUS.clear();
  for (const [k, v] of snapshot) STATUS.set(k, v);
}
