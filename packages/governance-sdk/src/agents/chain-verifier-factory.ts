/**
 * Chain Verifier Factory — AA-1 PR 1C.2
 *
 * Produces a `ChainVerifier` (DI-compatible with `loader.ts`) by
 * soft-importing `solo-builder-core/dist/operational-key-attestation`
 * and adapting `verifyOperationalKeyAttestation` into the SDK's
 * mirror-typed shape.
 *
 * Why soft-import (plan §2.3, load-bearing):
 *   - `@strixgov/sdk` is published independently from
 *     `solo-builder-core`. A hard import would force every SDK consumer
 *     to also depend on sbc, which is a private workspace package and
 *     never published to npm.
 *   - Dynamic `import('solo-builder-core/dist/...')` resolves at runtime
 *     in workspaces where sbc is built, fails cleanly elsewhere. Tests
 *     inject a stub `ChainVerifier` directly via DI; they never load
 *     the real sbc.
 *
 * Failure semantics (load-bearing, plan §2.3):
 *   - Import failure → `CHAIN_VERIFIER_UNAVAILABLE` with reason
 *     `dependency_missing`. NEVER silent success.
 *   - Adapter / runtime exception → `CHAIN_VERIFIER_UNAVAILABLE` with
 *     reason `verifier_exception`.
 *
 * Downstream signer treats `CHAIN_VERIFIER_UNAVAILABLE` like a missing
 * signing key:
 *   - HIGH/CRITICAL → throws `ATTESTATION_SIGNING_UNAVAILABLE`, rolls back
 *     the evidence transaction.
 *   - MEDIUM/LOW → degrade with warning (no attestation written).
 *
 * The verifier in PR 1C.3 will emit `actorClassVerified=null` with
 * `verifier_unavailable` rather than `verified=true` for any record
 * produced under these conditions.
 */

import type {
  ChainVerifier,
  ChainVerificationOutcome,
  OperationalKeyAttestationMirror,
  Ed25519JwkMirror,
} from "./loader.js";

// ─── Errors ─────────────────────────────────────────────────────────────────

export const CHAIN_VERIFIER_ERRORS = {
  UNAVAILABLE: "CHAIN_VERIFIER_UNAVAILABLE",
} as const;

export type ChainVerifierUnavailableReason =
  | "dependency_missing"
  | "verifier_exception"
  | "pinned_roots_unavailable";

export class ChainVerifierUnavailableError extends Error {
  readonly code = CHAIN_VERIFIER_ERRORS.UNAVAILABLE;
  constructor(
    readonly reason: ChainVerifierUnavailableReason,
    readonly detail: string,
  ) {
    super(`CHAIN_VERIFIER_UNAVAILABLE (${reason}): ${detail}`);
    this.name = "ChainVerifierUnavailableError";
  }
}

// ─── sbc binding shape (locked) ─────────────────────────────────────────────
//
// We DO NOT import these types from solo-builder-core. The locked
// shape mirror lives in `loader.ts`; the factory's job is to translate
// between the sbc real types and the loader's mirror types at the
// boundary, validate the response, and surface adapter failures with a
// stable code.

interface SbcPinnedRootLookup {
  resolveRoot(rootKid: string): unknown;
}

interface SbcVerifyOptions {
  referenceTime?: string;
}

interface SbcAttestationVerificationResult {
  valid: boolean;
  reasonCode: string | null;
  reasonDetail: string | null;
}

type SbcVerifyOperationalKeyAttestation = (
  attestation: {
    attestedKid: string;
    attestedJwk: Ed25519JwkMirror;
    notBefore: string;
    notAfter: string;
    attestationSig: string;
    rootKid: string;
  },
  pinnedRoots: SbcPinnedRootLookup,
  options?: SbcVerifyOptions,
) => SbcAttestationVerificationResult;

interface SbcOperationalKeyAttestationModule {
  verifyOperationalKeyAttestation: SbcVerifyOperationalKeyAttestation;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export interface CreateDefaultChainVerifierOptions {
  /**
   * Pinned-root lookup. In production the strix-platform side binds this
   * to sbc's `pinned-roots.ts` registry. Tests inject a stub.
   *
   * Marked optional only to keep the signature flexible; in practice
   * every caller MUST provide one — calling without throws with
   * `pinned_roots_unavailable`.
   */
  pinnedRoots?: SbcPinnedRootLookup;
  /**
   * Override for the dynamic-import path. Tests use this to redirect
   * the import at a stub module that mimics sbc's surface.
   *
   * Default: `"solo-builder-core/dist/operational-key-attestation"`.
   */
  importPath?: string;
}

/**
 * Produce a `ChainVerifier` bound to sbc's
 * `verifyOperationalKeyAttestation`. The factory itself is async — the
 * dynamic import resolves at first call, not at factory-create time, so
 * callers that hold a `ChainVerifier` reference don't pay the import
 * cost until they verify.
 *
 * Returned verifier is synchronous (`ChainVerifier` signature is
 * synchronous, matching the loader's interface). The async wiring
 * happens up front in this function before the closure is returned.
 */
export async function createDefaultChainVerifier(
  opts: CreateDefaultChainVerifierOptions = {},
): Promise<ChainVerifier> {
  if (opts.pinnedRoots === undefined) {
    throw new ChainVerifierUnavailableError(
      "pinned_roots_unavailable",
      "createDefaultChainVerifier requires a pinnedRoots lookup; tests inject a stub, " +
        "production binds to solo-builder-core/src/pinned-roots.ts",
    );
  }
  const pinnedRoots = opts.pinnedRoots;

  const importPath =
    opts.importPath ?? "solo-builder-core/dist/operational-key-attestation";

  let mod: SbcOperationalKeyAttestationModule;
  try {
    // Soft import. We cast once here at the boundary; the cast is
    // load-bearing — any drift between the SDK's mirror types and sbc's
    // real types will surface as adapter-time failures rather than
    // silent type mismatches.
    // Both bundler-ignore comments are needed: `@vite-ignore` for Vite-
    // based consumers (verifier package), `webpackIgnore: true` for
    // Next.js / webpack consumers (Console). Either alone would leave
    // one bundler trying to statically resolve `solo-builder-core/dist/`
    // and failing the build (the dist is not always present at
    // type-check time; the soft-import is fail-closed at runtime).
    mod = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ importPath
    )) as unknown as SbcOperationalKeyAttestationModule;
  } catch (e) {
    throw new ChainVerifierUnavailableError(
      "dependency_missing",
      `failed to import "${importPath}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  if (typeof mod.verifyOperationalKeyAttestation !== "function") {
    throw new ChainVerifierUnavailableError(
      "dependency_missing",
      `module "${importPath}" does not export verifyOperationalKeyAttestation`,
    );
  }

  const verify = mod.verifyOperationalKeyAttestation;

  // The returned closure is the synchronous `ChainVerifier` shape the
  // loader expects. Adapter failures become `valid: false` with a
  // stable reason code so the loader can record them per-entry rather
  // than aborting the whole load.
  return (
    attestation: OperationalKeyAttestationMirror,
    referenceTime: string,
  ): ChainVerificationOutcome => {
    let result: SbcAttestationVerificationResult;
    try {
      result = verify(
        {
          attestedKid: attestation.attestedKid,
          attestedJwk: attestation.attestedJwk,
          notBefore: attestation.notBefore,
          notAfter: attestation.notAfter,
          attestationSig: attestation.attestationSig,
          rootKid: attestation.rootKid,
        },
        pinnedRoots,
        { referenceTime },
      );
    } catch (e) {
      return {
        valid: false,
        reasonCode: "CHAIN_VERIFIER_EXCEPTION",
        reasonDetail: e instanceof Error ? e.message : String(e),
      };
    }

    return {
      valid: result.valid,
      reasonCode: result.reasonCode,
      reasonDetail: result.reasonDetail,
    };
  };
}
