/**
 * Agent-kid revocation check — AA-1 PR 1C.3.
 *
 * Thin SDK-side wrapper around the CP-K-001 signed-revocation-list
 * primitive (`solo-builder-core/src/signed-revocation-list.ts`). Scoped
 * to agent kids — the same revocation-list shape works for both
 * platform-operational kids and agent kids, so we mirror the data shape
 * and the lookup discipline here without taking a hard sbc dependency
 * (same posture as the SCJ v1 mirror in `scj-v1-mirror.ts` and the
 * `isStrictRfc3339Mirror` in `agents/loader.ts`).
 *
 * **OB-3 parity — load-bearing.** A signature is accepted iff its
 * `attestationCreatedAt` is strictly EARLIER than the revocation entry's
 * `revokedAt` for the same kid. At or after the revocation timestamp,
 * the signature is rejected. This preserves the EU AI Act 2-year
 * retention property: historical records signed before a compromise
 * remain verifiable; only forward-dated records fail.
 *
 * **Fail-closed on non-RFC3339 input.** A non-strict-RFC3339 reference
 * time or revocation timestamp is treated as "cannot determine
 * revocation" → the kid is reported as revoked. Prefers a false-positive
 * revocation over silently accepting a malformed timestamp. Mirror of
 * `signed-revocation-list.ts:isKidRevokedBefore`'s Codex-review P2 fix.
 *
 * **Layering note.** This module does NOT verify the root signature on
 * the revocation list. The caller (1D) is responsible for invoking sbc's
 * `verifySignedRevocationList` upstream and only passing a verified list
 * here. The signature on `SignedRevocationList.signature` is preserved
 * so 1D can persist + re-verify, but `isAgentKidRevokedAtOrAfter` reads
 * only `entries`.
 *
 * Source: `docs/architecture/actor-attestation-v1.md` §"Verifier rules"
 * rule 3; `docs/gates/AA-1-PR-1C3-IMPLEMENTATION-PLAN.md` §2.7, §3.1.
 */

import { isStrictRfc3339Mirror } from "../agents/loader.js";

// ─── Mirror types ───────────────────────────────────────────────────────────
//
// Byte-equivalent to `solo-builder-core/src/signed-revocation-list.ts`
// `RevocationEntry` / `SignedRevocationList`. Field order and types are
// load-bearing — a future sbc change MUST land here in lockstep.

export const REVOCATION_LIST_VERSION_MIRROR = 1 as const;

export interface RevocationEntryMirror {
  /** The operational/agent kid being revoked. */
  kid: string;
  /**
   * Strict RFC 3339 wall-clock time at which the kid is revoked.
   * Signatures created strictly before this instant remain valid.
   */
  revokedAt: string;
  /** Optional free-form reason; informational only. */
  reason?: string;
}

/**
 * Mirror of `solo-builder-core/src/signed-revocation-list.ts:SignedRevocationList`.
 * The verifier consumes already-root-verified lists (1D does the upstream
 * verify call); `isAgentKidRevokedAtOrAfter` reads only `entries`.
 */
export interface SignedRevocationList {
  version: typeof REVOCATION_LIST_VERSION_MIRROR;
  entries: readonly RevocationEntryMirror[];
  signedAt: string;
  rootKid: string;
  /** Base64 Ed25519 signature (verified upstream by the caller). */
  signature: string;
}

/**
 * The empty revocation list. Use as the safe default when no revocations
 * are known; matches the semantics of "no kid is revoked". Preserved
 * `Object.freeze` to prevent accidental mutation by a downstream caller.
 *
 * The `signedAt` / `rootKid` / `signature` fields carry placeholder
 * sentinels — this constant is meant for tests and the safe-default
 * path; production callers pass a real root-verified list.
 */
export const EMPTY_REVOCATION_LIST: SignedRevocationList = Object.freeze({
  version: REVOCATION_LIST_VERSION_MIRROR,
  entries: Object.freeze([]) as readonly RevocationEntryMirror[],
  signedAt: "1970-01-01T00:00:00Z",
  rootKid: "<empty>",
  signature: "",
});

// ─── Lookup primitive ───────────────────────────────────────────────────────

/**
 * Is `kid` revoked as of an instant at or before `referenceTime`?
 *
 * Returns:
 *   - `false` ⇔ no revocation entry exists for `kid`, OR the entry's
 *     `revokedAt` is strictly LATER than `referenceTime` (signature
 *     pre-dates revocation — OB-3 parity).
 *   - `true`  ⇔ a revocation entry exists with `revokedAt <= referenceTime`
 *     (signature is at or after the revocation instant), OR either
 *     timestamp fails strict-RFC3339 parsing (fail-closed).
 *
 * Behavior is byte-equivalent to `solo-builder-core/src/signed-revocation-list.ts:isKidRevokedBefore`.
 * The misleadingly-named sbc function returns `true` when the kid is
 * revoked at/before `referenceTime` — this wrapper renames it to make
 * the AT-OR-AFTER semantics explicit at the call site.
 *
 * @param list           Pre-verified revocation list.
 * @param kid            The attestation's `attestationKid`.
 * @param referenceTime  The attestation's `attestationCreatedAt`. Strict
 *                       RFC 3339 only.
 */
export function isAgentKidRevokedAtOrAfter(
  list: SignedRevocationList,
  kid: string,
  referenceTime: string,
): boolean {
  // Build the lookup map. Done inline rather than via a Map cache to
  // keep the function pure and stateless; the verifier calls this at
  // most once per attestation per request.
  let earliestRevokedAt: string | null = null;
  for (const entry of list.entries) {
    if (entry.kid !== kid) continue;
    if (
      earliestRevokedAt === null ||
      entry.revokedAt < earliestRevokedAt
    ) {
      earliestRevokedAt = entry.revokedAt;
    }
  }
  if (earliestRevokedAt === null) return false;

  // Fail-closed on non-RFC3339 input. Prefers a false-positive
  // revocation over silently accepting a malformed timestamp. Mirror
  // of `isKidRevokedBefore`'s Codex-review P2 fix.
  if (!isStrictRfc3339Mirror(referenceTime)) return true;
  if (!isStrictRfc3339Mirror(earliestRevokedAt)) return true;

  const refMs = Date.parse(referenceTime);
  const revMs = Date.parse(earliestRevokedAt);
  if (!Number.isFinite(refMs) || !Number.isFinite(revMs)) {
    // Defense-in-depth: a strict-RFC3339 string should always parse,
    // but if a host runtime regresses we still fail closed.
    return true;
  }
  // Revoked iff revocation happened AT OR BEFORE the reference time.
  return revMs <= refMs;
}
