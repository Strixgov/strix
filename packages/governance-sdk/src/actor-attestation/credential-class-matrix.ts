/**
 * Credential-class allow-set — AA-1 PR 1C.3
 *
 * The AA-PRE-2 cross-check matrix lives here as the single source of truth.
 * Both signer (1C.2) and verifier (1C.3) MUST consume this module — the
 * cross-check cannot have two independent implementations. If the signer
 * accepts a pair the verifier later rejects (or vice versa), an
 * agent-stamped attestation can pass-then-fail in the same release.
 *
 * Source of truth: `docs/architecture/actor-attestation-v1.md`
 * §"Signer preconditions" → AA-PRE-2 and §"Verifier rules" → rule 5.
 *
 * Locked 5-pair allow-set (any `(actor, credential)` pair NOT in this
 * table is rejected). Reordering or adding pairs is a contract change —
 * coordinate with a gate report.
 *
 *   agent  + agent_token       — agent self-attestation
 *   human  + session           — human session cookie
 *   human  + dev_impersonation — dev-only; production callers re-check
 *                                NODE_ENV and reject unconditionally
 *   system + service_token     — STRIX_INTERNAL_TOKEN class
 *   system + internal          — cron, reconciliation watchdog
 *
 * Note: `dev_impersonation` is permitted at the matrix level for `human`.
 * The production-only rejection (AA-PRE-2 second clause) is the caller's
 * responsibility — the matrix is type-level, not env-aware.
 *
 * This file is the new home of the cross-check; 1C.2's signer re-points
 * its `credentialClassMatchesActor` import here. The legacy export in
 * `src/attestation/types.ts` stays for backwards compatibility but
 * delegates internally; both call sites now share one source of truth.
 *
 * The plan (§2.5 table heading) referred to "8 valid (actorType,
 * credentialClass) pairs"; the contract enumerates 5. The contract wins.
 * Any future expansion of `CredentialClass` or `ActorType` MUST update
 * this matrix in the same PR — there is no env knob.
 *
 * Cross-repo source of truth: `credential-class-matrix.snapshot.json`
 * (sibling file). The snapshot mirrors this matrix byte-for-byte and is
 * the canonical artifact downstream consumers (notably the Python
 * `solo-builder-core` repo's `_VALID_PAIRS` constant) MUST consume.
 * `tests/credential-class-matrix.test.ts` fails closed on any drift
 * between this file and the snapshot. Cross-repo coherence resolved
 * 2026-05-13 (confirmed Python-side was enforcing the stale ADR-015
 * 8-pair set; narrowed to 5 in the Python repo via the parity PR
 * referenced from `docs/gates/AA-1-PR-1F-IMPLEMENTATION-PLAN.md` §3.3).
 */

import type { ActorType, CredentialClass } from "../attestation/types.js";

/**
 * The valid `(actorType, credentialClass)` pairs. The matrix is frozen
 * structurally (`as const` plus a `readonly` element type) so a future
 * refactor cannot mutate it at runtime.
 *
 * Field-order in this constant has no semantic meaning — lookups go
 * through `isCredentialClassConsistent`, not array index — but the
 * declaration order mirrors the contract doc for reviewer parity.
 */
export const CREDENTIAL_CLASS_MATRIX: ReadonlyArray<
  readonly [ActorType, CredentialClass]
> = Object.freeze([
  ["agent", "agent_token"],
  ["human", "session"],
  ["human", "dev_impersonation"],
  ["system", "service_token"],
  ["system", "internal"],
] as const);

/**
 * Returns `true` iff `(actor, credential)` is in the AA-PRE-2 allow-set.
 *
 * Pure function: no env reads, no I/O. The production-only
 * `dev_impersonation` rejection lives at the caller (the signer's
 * `isProduction` flag, or the verifier's environment-aware caller in
 * 1D). This module is intentionally environment-agnostic so the same
 * matrix runs in tests, dev, and production.
 *
 * Implementation: switch over `actor` rather than a Map lookup. A switch
 * keeps the allow-set visible in code review and lets the type checker
 * detect a missing `ActorType` case if the enum ever grows. A Map
 * keyed by `${actor}:${credential}` would silently accept additions.
 */
export function isCredentialClassConsistent(
  actor: ActorType,
  credential: CredentialClass,
): boolean {
  switch (actor) {
    case "agent":
      return credential === "agent_token";
    case "human":
      return credential === "session" || credential === "dev_impersonation";
    case "system":
      return credential === "service_token" || credential === "internal";
  }
}
