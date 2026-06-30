/**
 * Agent Key Loader — AA-1 PR 1C.1b
 *
 * Hydrates an `AgentKeyRegistry` from declared input entries. Each entry
 * carries an `OperationalKeyAttestation` (OB-1) that MUST chain to a
 * pinned root before the entry is admitted to the registry. Entries that
 * fail any check are rejected per-entry — never all-or-nothing — and
 * surfaced in `result.rejected` for ops dashboards.
 *
 * **Trust posture (Resolution A operationally closed 2026-05-12).**
 * The loader runs against a SINGLE pinned root set. Academy now proxies
 * the canonical Strix JWKS byte-for-byte, so there is one trust root and
 * one operational-key chain. If a future change ever bifurcates this
 * posture (Resolution B), this module is the single point where
 * multi-root resolution would land. ADR-011 (Python `solo-builder-core`
 * repo) is the cross-repo authority for that decision.
 *
 * **Scope of this PR (1C.1b).**
 *   - Loader contract (input shape + result shape + error codes).
 *   - Reference implementation that calls a caller-supplied chain
 *     verifier (DI). No hard import from `solo-builder-core/` — the
 *     strix-platform side wires the real `verifyOperationalKeyAttestation`
 *     when the signer (PR 1C.2) lands.
 *   - Empty-default behavior when `STRIX_ACTOR_ATTESTATION_V1` is off.
 *
 * **Out of scope (later slices).**
 *   - PR 1C.2 (signer) — wires `verifyOperationalKeyAttestation` from
 *     `solo-builder-core/src/operational-key-attestation.ts`, chooses
 *     the entry source (env/DB), and integrates the loader into the
 *     evidence-write transaction.
 *   - PR 1C.3 (verifier) — consumes the same registry surface that this
 *     loader produces.
 *   - PRs 1D / 1E / 1F — receipt wiring, flag flip, invariant promotion.
 *
 * Held until the gates above clear; see
 * `docs/gates/GATE-REPORT-ACTOR-ATTESTATION-V1.md` §J.
 */

import {
  AgentIdMismatchError,
  AgentKidCollisionError,
  AgentKidFormatError,
  EMPTY_AGENT_KEY_REGISTRY,
  InMemoryAgentKeyRegistry,
  type AgentKeyRegistry,
  type AgentPublicKeyJwk,
  type RegisteredAgentKey,
} from "./registry.js";

// ─── Local mirror types ──────────────────────────────────────────────────────
//
// We intentionally re-declare the small slice of types we need from
// `solo-builder-core/src/operational-key-attestation.ts` rather than
// importing them directly. Reasons:
//
//   1. The SDK is a `@strixgov/sdk` consumer-facing package and adding a
//      hard dependency on a workspace sibling complicates publish/build.
//   2. Today, NO file in `apps/strix-console/src/` imports from
//      `solo-builder-core/`. 1C.1b should not be the file that first
//      forces that bootstrap — that's a separate architectural decision
//      worth its own ADR.
//   3. Dependency injection keeps the loader testable without a real
//      Ed25519 keypair or pinned-root registry.
//
// These types MUST stay byte-equivalent to the source-of-truth shape in
// `solo-builder-core/src/operational-key-attestation.ts`. The strix-
// platform-side adapter (1C.2) will cast the real types to these
// declared shapes; any drift is caught at the call site.

/** Mirror of `solo-builder-core/src/operational-key-attestation.ts:Ed25519Jwk`. */
export interface Ed25519JwkMirror {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

/**
 * Mirror of `solo-builder-core/src/operational-key-attestation.ts:OperationalKeyAttestation`.
 *
 * Field set is locked at sbc-v1 contractVersion 1. Reordering or adding
 * fields is a breaking change to the OB-1 trust chain — coordinate via
 * CP-K-001's "Naming freeze" rules before touching.
 */
export interface OperationalKeyAttestationMirror {
  attestedKid: string;
  attestedJwk: Ed25519JwkMirror;
  notBefore: string;
  notAfter: string;
  attestationSig: string;
  rootKid: string;
}

/**
 * Result of a chain-verification call. Mirror of `solo-builder-core`'s
 * `AttestationVerificationResult`, minus the reconstructed public key —
 * the loader doesn't need the operational public key (we already have
 * the JWK on the entry). The `reasonCode` payload is opaque to the
 * loader; it's surfaced verbatim in `rejected[].detail` so dashboards
 * can grep for sbc error codes.
 */
export interface ChainVerificationOutcome {
  valid: boolean;
  reasonCode: string | null;
  reasonDetail: string | null;
}

/**
 * The chain verifier function the loader calls. The strix-platform-side
 * adapter (1C.2) is expected to bind this to
 * `verifyOperationalKeyAttestation(attestation, pinnedRoots, { referenceTime })`
 * from `solo-builder-core`.
 *
 * `referenceTime` is the loader's `registeredAt` — we want the chain to
 * have been valid AT registration. Verifier-time `attestationCreatedAt`
 * checks happen at PR 1C.3 against each individual attestation, not here.
 */
export type ChainVerifier = (
  attestation: OperationalKeyAttestationMirror,
  referenceTime: string,
) => ChainVerificationOutcome;

/**
 * Revocation lookup the loader consults BEFORE admitting an entry. The
 * platform-side adapter (1C.2) is expected to bind this to
 * `isKidRevokedBefore(revocationList, kid, referenceTime)` from
 * `solo-builder-core/src/signed-revocation-list.ts`.
 *
 * Pre-registration revocation rejects the entry. Post-registration
 * revocation is enforced PER-ATTESTATION by the verifier in PR 1C.3 —
 * the loader cannot retroactively un-load entries, by design.
 */
export type RevocationCheck = (kid: string, referenceTime: string) => boolean;

// ─── Loader error codes (additive to the SDK registry's three) ───────────────

/**
 * Stable error codes the loader emits. Three codes already exist in
 * `registry.ts` and surface as-is when `InMemoryAgentKeyRegistry.add()`
 * throws (AGENT_KID_FORMAT / AGENT_ID_MISMATCH / AGENT_KID_COLLISION).
 * The codes below are the loader-only additions.
 *
 * Mirror discipline: adding, renaming, or reusing a code is a public
 * contract break. The platform JWKS endpoint surfaces these verbatim
 * in operational dashboards.
 */
export const AGENT_LOADER_ERRORS = {
  REGISTERED_AT_NOT_RFC3339: "AGENT_REGISTERED_AT_NOT_RFC3339",
  ATTESTATION_KID_MISMATCH: "AGENT_ATTESTATION_KID_MISMATCH",
  ATTESTATION_JWK_MISMATCH: "AGENT_ATTESTATION_JWK_MISMATCH",
  ATTESTATION_CHAIN_INVALID: "AGENT_ATTESTATION_CHAIN_INVALID",
  ROOT_ATTESTATION_KID_MISMATCH: "AGENT_ROOT_ATTESTATION_KID_MISMATCH",
  KEY_REVOKED_BEFORE_REGISTRATION: "AGENT_KEY_REVOKED_BEFORE_REGISTRATION",
} as const;

export type AgentLoaderErrorCode =
  (typeof AGENT_LOADER_ERRORS)[keyof typeof AGENT_LOADER_ERRORS];

// ─── Input + result shapes ───────────────────────────────────────────────────

/**
 * A single declared agent-key entry. The loader resolves the
 * `attestation` chain BEFORE admitting this to the registry. The
 * source (env, DB, ops console) is the caller's choice; the loader
 * doesn't care.
 */
export interface AgentKeyEntryInput {
  agentId: string;
  kid: string;
  publicKeyJwk: AgentPublicKeyJwk;
  /** Strict RFC 3339, validated by the loader. */
  registeredAt: string;
  /**
   * Pinned-root kid that signed the operational-key attestation. MUST
   * equal `attestation.rootKid`; mismatch is rejected. Stored on the
   * resulting `RegisteredAgentKey` so consumers can audit the chain
   * without re-running cryptography.
   */
  rootAttestationKid: string;
  /** OB-1 operational-key attestation. Chain-verified at load time. */
  attestation: OperationalKeyAttestationMirror;
}

export interface RejectedEntry {
  kid: string;
  agentId: string;
  code: AgentLoaderErrorCode | "AGENT_KID_FORMAT" | "AGENT_ID_MISMATCH" | "AGENT_KID_COLLISION";
  detail: string;
}

export interface LoadAgentKeysOptions {
  entries: ReadonlyArray<AgentKeyEntryInput>;
  /**
   * Caller-supplied chain verifier. Bind to
   * `verifyOperationalKeyAttestation` from `solo-builder-core` on the
   * platform side. The loader treats `valid: false` as rejection and
   * surfaces `reasonCode` + `reasonDetail` verbatim.
   */
  chainVerifier: ChainVerifier;
  /**
   * Caller-supplied revocation check. Bind to `isKidRevokedBefore` from
   * `solo-builder-core/src/signed-revocation-list.ts` on the platform
   * side. Optional; if omitted, no pre-registration revocation check is
   * performed (per-attestation revocation still applies at verify time
   * in PR 1C.3).
   */
  revocationCheck?: RevocationCheck;
  /**
   * Explicit override for the `STRIX_ACTOR_ATTESTATION_V1` flag. Useful
   * for tests + the JWKS endpoint when it consults the flag elsewhere.
   * When omitted, the flag is read from `process.env`.
   */
  flagOverride?: "on" | "off";
}

export interface LoadAgentKeysResult {
  /**
   * The hydrated registry. Empty (resolves every kid to null) when the
   * flag is off, when input is empty, or when every entry was rejected.
   */
  registry: AgentKeyRegistry;
  /** Entries that passed all checks and were admitted to the registry. */
  loaded: ReadonlyArray<RegisteredAgentKey>;
  /** Entries rejected, with the failure code + detail. Per-entry. */
  rejected: ReadonlyArray<RejectedEntry>;
}

// ─── Flag check ──────────────────────────────────────────────────────────────

/**
 * Read the `STRIX_ACTOR_ATTESTATION_V1` flag. Pinned to the exact string
 * "true" — anything else (unset, "1", "yes", "TRUE") is OFF. Matches the
 * fail-closed default discipline elsewhere in the codebase.
 *
 * Exported so the JWKS endpoint can short-circuit without spinning up a
 * loader call.
 */
export function isAgentAttestationFlagOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.STRIX_ACTOR_ATTESTATION_V1 === "true";
}

/**
 * Read the `STRIX_AA1_REVOCATION_DISTRIBUTION` flag.
 *
 * Gates the AA-1 PR 1F precondition P2 revocation-list distribution
 * surface. When ON, `aa1-context-loader` fetches the platform's signed
 * revocation list from `/.well-known/strix-revocation-list.json` and
 * root-verifies it before handing it to the SDK verifier; if either step
 * fails the loader surfaces `REVOCATION_LIST_UNAVAILABLE` and the route
 * handler emits an `actorClass` block with `verified: null + reason:
 * CLASS_REVOCATION_CHECK_UNAVAILABLE`.
 *
 * When OFF (default), the loader uses the empty revocation list, which
 * is the safe default for environments that have not deployed the
 * distribution surface yet — the verifier's rule 3 short-circuits to
 * "not revoked" because the list is empty.
 *
 * Pinned to the exact string "true" — same discipline as
 * `isAgentAttestationFlagOn`. Anything else (unset, "1", "yes", "TRUE")
 * is OFF.
 */
export function isRevocationDistributionFlagOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.STRIX_AA1_REVOCATION_DISTRIBUTION === "true";
}

// ─── Strict RFC 3339 — local mirror ──────────────────────────────────────────
//
// Same posture as the type mirrors above. `solo-builder-core/src/rfc3339.ts`
// is the source-of-truth canonical parser, but we mirror just the predicate
// rather than take a hard dependency. Mirror discipline: stay byte-equivalent
// to `isStrictRfc3339`.

const STRICT_RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Strict RFC 3339 timestamp predicate. Mirror of
 * `solo-builder-core/src/rfc3339.ts:isStrictRfc3339`. Local copy so the
 * SDK has no hard sbc dependency; mirror invariant verified by a test
 * in `tests/agent-key-loader.test.ts` that compares against a known
 * fixture set.
 */
export function isStrictRfc3339Mirror(input: string): boolean {
  if (typeof input !== "string") return false;
  const match = STRICT_RFC3339_PATTERN.exec(input);
  if (!match) return false;
  // Date.parse on a strict-RFC3339 string returns NaN only for impossible
  // calendar dates (Feb 30, etc.). Run it to catch those.
  const ts = Date.parse(input);
  return Number.isFinite(ts);
}

// ─── Loader implementation ───────────────────────────────────────────────────

/**
 * Hydrate an `AgentKeyRegistry` from declared entries. See module
 * docstring for the trust posture and per-PR scope notes.
 *
 * Failure semantics (each entry, in order):
 *   1. `registeredAt` must be strict RFC 3339.
 *   2. `attestation.attestedKid` must equal the entry's `kid`.
 *   3. `attestation.attestedJwk.x` must equal the entry's `publicKeyJwk.x`.
 *   4. `attestation.rootKid` must equal the entry's `rootAttestationKid`.
 *   5. `chainVerifier(attestation, registeredAt)` must return `valid: true`.
 *   6. If `revocationCheck` is provided, it must return `false` for
 *      `(kid, registeredAt)` — i.e., the kid is NOT revoked before
 *      registration.
 *   7. The SDK registry's structural invariants must hold at `add()`
 *      time (kid format, agentId/kid agreement, kid uniqueness).
 *
 * Any failure rejects the entry only — the remaining entries still
 * load. This mirrors the offline-bundle producer-side discipline (every
 * sister record validated independently; one bad record doesn't
 * invalidate the bundle).
 */
export function loadAgentKeyRegistry(
  opts: LoadAgentKeysOptions,
): LoadAgentKeysResult {
  const flagOn =
    opts.flagOverride === "on" ||
    (opts.flagOverride !== "off" && isAgentAttestationFlagOn());

  if (!flagOn || opts.entries.length === 0) {
    return {
      registry: EMPTY_AGENT_KEY_REGISTRY,
      loaded: [],
      rejected: [],
    };
  }

  const registry = new InMemoryAgentKeyRegistry();
  const loaded: RegisteredAgentKey[] = [];
  const rejected: RejectedEntry[] = [];

  for (const entry of opts.entries) {
    const reject = (
      code: RejectedEntry["code"],
      detail: string,
    ): void => {
      rejected.push({ kid: entry.kid, agentId: entry.agentId, code, detail });
    };

    // 1. registeredAt strict RFC 3339
    if (!isStrictRfc3339Mirror(entry.registeredAt)) {
      reject(
        AGENT_LOADER_ERRORS.REGISTERED_AT_NOT_RFC3339,
        `registeredAt=${entry.registeredAt}`,
      );
      continue;
    }

    // 2. attestation kid agreement
    if (entry.attestation.attestedKid !== entry.kid) {
      reject(
        AGENT_LOADER_ERRORS.ATTESTATION_KID_MISMATCH,
        `entry.kid=${entry.kid} attestation.attestedKid=${entry.attestation.attestedKid}`,
      );
      continue;
    }

    // 3. attestation JWK agreement (same key, not just same kid)
    if (entry.attestation.attestedJwk.x !== entry.publicKeyJwk.x) {
      reject(
        AGENT_LOADER_ERRORS.ATTESTATION_JWK_MISMATCH,
        `publicKeyJwk.x differs from attestation.attestedJwk.x`,
      );
      continue;
    }

    // 4. root attestation kid agreement
    if (entry.attestation.rootKid !== entry.rootAttestationKid) {
      reject(
        AGENT_LOADER_ERRORS.ROOT_ATTESTATION_KID_MISMATCH,
        `entry.rootAttestationKid=${entry.rootAttestationKid} attestation.rootKid=${entry.attestation.rootKid}`,
      );
      continue;
    }

    // 5. OB-1 chain verification at registeredAt
    const chain = opts.chainVerifier(entry.attestation, entry.registeredAt);
    if (!chain.valid) {
      const detail = chain.reasonDetail
        ? `${chain.reasonCode}: ${chain.reasonDetail}`
        : (chain.reasonCode ?? "chain invalid");
      reject(AGENT_LOADER_ERRORS.ATTESTATION_CHAIN_INVALID, detail);
      continue;
    }

    // 6. pre-registration revocation
    if (opts.revocationCheck && opts.revocationCheck(entry.kid, entry.registeredAt)) {
      reject(
        AGENT_LOADER_ERRORS.KEY_REVOKED_BEFORE_REGISTRATION,
        `kid ${entry.kid} revoked before registeredAt=${entry.registeredAt}`,
      );
      continue;
    }

    // 7. SDK registry add — enforces structural invariants
    const registered: RegisteredAgentKey = {
      agentId: entry.agentId,
      kid: entry.kid,
      publicKeyJwk: entry.publicKeyJwk,
      registeredAt: entry.registeredAt,
      rootAttestationKid: entry.rootAttestationKid,
    };
    try {
      registry.add(registered);
      loaded.push(registered);
    } catch (e: unknown) {
      if (e instanceof AgentKidFormatError) {
        reject("AGENT_KID_FORMAT", e.message);
      } else if (e instanceof AgentIdMismatchError) {
        reject("AGENT_ID_MISMATCH", e.message);
      } else if (e instanceof AgentKidCollisionError) {
        reject("AGENT_KID_COLLISION", e.message);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        reject(AGENT_LOADER_ERRORS.ATTESTATION_CHAIN_INVALID, `unexpected: ${msg}`);
      }
    }
  }

  return { registry, loaded, rejected };
}

/**
 * Stable handle to the "flag off / empty input" result. The JWKS
 * endpoint uses this when short-circuiting so it has a typed reference
 * rather than constructing an inline literal.
 */
export const EMPTY_AGENT_KEY_LOAD_RESULT: LoadAgentKeysResult = Object.freeze({
  registry: EMPTY_AGENT_KEY_REGISTRY,
  loaded: [],
  rejected: [],
});
