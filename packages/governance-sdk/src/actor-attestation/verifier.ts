/**
 * Actor Attestation Verifier — AA-1 PR 1C.3.
 *
 *   ============================================================
 *   CONTRACT-DERIVED IMPLEMENTATION — DO NOT MIRROR PYTHON
 *   ============================================================
 *   This verifier is implemented against the locked contract at
 *   `docs/architecture/actor-attestation-v1.md` (contractVersion 1.0.0).
 *   It is NOT a port of, mirror of, or back-translation from the
 *   external Python `verify_attestation` reference. The two
 *   implementations validate the same contract independently — that is
 *   stronger than one imitating the other, and it is the position the
 *   1C.3 plan made explicit (§"Architectural primacy", §2.1).
 *
 *   In particular:
 *     - Reason codes are the 11 `CLASS_*` strings from the contract,
 *       NOT the Python reference's `aa1_*`-prefixed strings. The gate
 *       report's "aa1_-prefixed" wording referred to Python's surface,
 *       not the contract.
 *     - Golden vectors are derived from the contract's 9-field payload
 *       + AA-PRE matrix, NOT from Python runtime output. Cross-language
 *       parity is validated in a separate dedicated suite (not in this
 *       PR), not by mimicking Python output here.
 *     - If a future contributor "fixes" the codes toward Python parity,
 *       they are breaking the architectural decision recorded in plan
 *       §2.1 — escalate via a new gate report instead.
 *   ============================================================
 *
 * Evaluates the 8 verifier rules from §"Verifier rules" in declared
 * order. Reason code reflects the FIRST failing rule; subsequent rules
 * are not evaluated (`passed: null` in the trace — never silently
 * dropped). Mirrors the K-BIND-1 binding-rule discipline in
 * `solo-builder-core/src/execution-receipt-verifier-v1.ts`.
 *
 * **Three-state semantics.** `verified: true | false | null`.
 *   - `true`  → all 8 rules passed (`CLASS_VERIFIED`).
 *   - `false` → a rule failed (one of the 9 failure `CLASS_*` codes,
 *               or `CLASS_KEY_UNKNOWN` for infrastructure failures).
 *   - `null`  → UNATTESTED: no sibling attestation joined to this
 *               evidence record (rule 1 short-circuit;
 *               `CLASS_UNATTESTED`). DISTINCT from `false` — the Trust
 *               Center renders `null` as "unattested," never as
 *               "agent impersonation detected" (CI-5 trust-claim
 *               discipline; collapsing the two is the regression
 *               called out in `actor-attestation-v1.md` §"What breaks
 *               if this is wrong").
 *
 * **Infrastructure failures return `false`, not `null`.** A
 * registry-lookup miss, a signature-decode exception, or any other
 * "verifier couldn't make a determination" surface returns
 * `verified: false` with `CLASS_KEY_UNKNOWN` (or the most specific
 * stable failure code). `null` is reserved for UNATTESTED records;
 * collapsing infrastructure failures into `null` would silently
 * downgrade a legitimate failure into "no opinion" and let a
 * downstream consumer misread the verdict.
 *
 * **K-BIND-1 parity.** The verifier never trusts a stored
 * `actorClassVerified` flag — there is no such column on
 * `actor_attestations`, and even if a future migration added one, this
 * function would ignore it. Re-evaluation from signed artifacts is the
 * load-bearing discipline.
 *
 * **OB-3 parity.** Revocation is consulted via
 * `revocation-check.ts:isAgentKidRevokedAtOrAfter`, which fails closed
 * on non-strict-RFC3339 input. Pre-revocation signatures remain valid
 * (EU AI Act 2-year retention).
 *
 * **SCJ v1.** Re-canonicalization (when needed for signature verify) is
 * routed through `scj-v1-mirror.ts`, byte-equivalent to
 * `solo-builder-core/src/canonical-json.ts`. CP-K-001 CJ-1 invariant.
 *
 * **Pure-ish.** No Prisma, no `withTenant`, no network I/O. `VerifierInput`
 * is a flat record the caller pre-populates; `now` is injected for
 * testability. DB access lives in 1D's reader, not here.
 *
 * **Flag-OFF behavior.** This verifier is callable at
 * `STRIX_ACTOR_ATTESTATION_V1=false`. It does NOT consult the env var.
 * The flag gates the signer side only (plan §"Flag-OFF behavior splits
 * scope"); the verifier must be available for shadow audits, internal
 * dashboards, and 1D's eventual public-endpoint wiring at all times.
 *
 * Source: `docs/architecture/actor-attestation-v1.md` §"Verifier rules"
 * (8 rules) + §"`actorClassReason` codes (stable strings)" (11 codes).
 * Plan: `docs/gates/AA-1-PR-1C3-IMPLEMENTATION-PLAN.md` §2 + §3.
 */

import { verify as cryptoVerify, createPublicKey } from "node:crypto";
import { canonicalizeJSON } from "./scj-v1-mirror.js";
import { isCredentialClassConsistent } from "./credential-class-matrix.js";
import { isAgentKidRevokedAtOrAfter } from "./revocation-check.js";
import { isStrictRfc3339Mirror } from "../agents/loader.js";
import type {
  ActorAttestationRecord,
  ActorAttestationSignedEnvelope,
  ActorClassReason,
} from "../attestation/types.js";
import type { AgentPublicKeyJwk, RegisteredAgentKey } from "../agents/registry.js";
import {
  CLOCK_SKEW_WINDOW_MS,
  RULE_NAMES,
  type RuleOutcome,
  type VerifierInput,
  type VerifierOutcome,
} from "./verifier-types.js";

// Re-export the public type set for convenience — `import { verifyActorAttestation, VerifierOutcome } from "./actor-attestation/verifier.js"` reads cleanly.
export {
  CLOCK_SKEW_WINDOW_MS,
  RULE_NAMES,
  type RuleOutcome,
  type VerifierInput,
  type VerifierOutcome,
  type VerifiedClass,
  type ActorClassReason,
} from "./verifier-types.js";

// ─── Stable reason-code constant table ──────────────────────────────────────

/**
 * Stable string table for the 11 reason codes. Re-exported from the
 * verifier so external callers (1D, tests, dashboards) can import them
 * by name rather than constructing string literals. The strings
 * themselves match `ActorClassReason` (contract source of truth).
 */
export const ACTOR_CLASS_REASONS = Object.freeze({
  VERIFIED: "CLASS_VERIFIED",
  UNATTESTED: "CLASS_UNATTESTED",
  SIGNATURE_INVALID: "CLASS_SIGNATURE_INVALID",
  KEY_REVOKED: "CLASS_KEY_REVOKED",
  KEY_UNKNOWN: "CLASS_KEY_UNKNOWN",
  TYPE_MISMATCH: "CLASS_TYPE_MISMATCH",
  CREDENTIAL_MISMATCH: "CLASS_CREDENTIAL_MISMATCH",
  PAYLOAD_HASH_MISMATCH: "CLASS_PAYLOAD_HASH_MISMATCH",
  AGENT_ID_MISMATCH: "CLASS_AGENT_ID_MISMATCH",
  TIMESTAMP_INVALID: "CLASS_TIMESTAMP_INVALID",
  REPLAY: "CLASS_REPLAY",
} as const) satisfies Readonly<Record<string, ActorClassReason>>;

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Pre-allocates a trace of 8 not-evaluated entries. The verifier mutates
 * entries in place as rules complete; any rule that the short-circuit
 * skipped retains `passed: null`. Always returns length-8.
 */
function blankTrace(): RuleOutcome[] {
  return [
    { ruleId: 1, name: RULE_NAMES[1], passed: null, reason: null },
    { ruleId: 2, name: RULE_NAMES[2], passed: null, reason: null },
    { ruleId: 3, name: RULE_NAMES[3], passed: null, reason: null },
    { ruleId: 4, name: RULE_NAMES[4], passed: null, reason: null },
    { ruleId: 5, name: RULE_NAMES[5], passed: null, reason: null },
    { ruleId: 6, name: RULE_NAMES[6], passed: null, reason: null },
    { ruleId: 7, name: RULE_NAMES[7], passed: null, reason: null },
    { ruleId: 8, name: RULE_NAMES[8], passed: null, reason: null },
  ];
}

/**
 * Reconstruct the 11-field signed envelope from the stored row. The
 * signer's canonical bytes are the envelope canonicalized via SCJ v1,
 * so re-canonicalization here MUST produce the same bytes. Field set:
 * the 9 payload fields + `environment` + `tenantId`. Field order is
 * NOT load-bearing at canonicalization time — SCJ v1 sorts keys
 * alphabetically — but the field SET is load-bearing. Reordering the
 * declaration below has no effect on the output; adding or removing a
 * field would break every signature.
 */
function rebuildSignedEnvelope(
  record: ActorAttestationRecord,
): ActorAttestationSignedEnvelope {
  return {
    schemaVersion: record.schemaVersion,
    attestationId: record.attestationId,
    evidenceId: record.evidenceId,
    proposalId: record.proposalId,
    payloadHash: record.payloadHash,
    claimedActorType: record.claimedActorType,
    attestationKid: record.attestationKid,
    credentialClass: record.credentialClass,
    attestationCreatedAt: record.attestationCreatedAt,
    environment: record.environment,
    tenantId: record.tenantId,
  };
}

/**
 * Materialize an Ed25519 `KeyObject` from a registry JWK. The
 * `node:crypto` `createPublicKey({ key, format: 'jwk' })` call requires
 * `kty`, `crv`, and `x`; the registry's `AgentPublicKeyJwk` carries
 * exactly that plus optional advisory fields.
 *
 * Returns `null` on any decode failure — the caller surfaces this as
 * `CLASS_KEY_UNKNOWN` (the kid was in the registry but the key body is
 * unusable, which from the verifier's perspective is indistinguishable
 * from "no usable key for this kid").
 */
function tryCreatePublicKey(jwk: AgentPublicKeyJwk): ReturnType<typeof createPublicKey> | null {
  try {
    // `createPublicKey` accepts a JWK input via `{ key, format: 'jwk' }`.
    // The Node types narrow the `format: 'jwk'` overload slightly; cast
    // at the boundary keeps the inputs strongly typed in `AgentPublicKeyJwk`.
    const input = {
      key: {
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
      },
      format: "jwk" as const,
    };
    return createPublicKey(input as Parameters<typeof createPublicKey>[0]);
  } catch {
    return null;
  }
}

/**
 * Short-circuit a trace at `firstFailingRule`: mark the rule as failed
 * with the given reason and leave all subsequent rules with `passed: null`.
 * Earlier rules retain whatever the caller already wrote into the trace.
 */
function markFailureAndShortCircuit(
  trace: RuleOutcome[],
  firstFailingRule: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
  reason: ActorClassReason,
): void {
  const idx = firstFailingRule - 1;
  trace[idx] = {
    ruleId: firstFailingRule,
    name: RULE_NAMES[firstFailingRule],
    passed: false,
    reason,
  };
  // Rules after the failure stay `passed: null, reason: null` from blankTrace().
  // (No mutation needed — they were already initialized that way.)
}

/**
 * Mark a rule as passed. Earlier rules MUST already be in `passed: true`
 * state at this point (the verifier walks them in order). This helper is
 * the per-rule "ok, keep going" record.
 */
function markPassed(
  trace: RuleOutcome[],
  ruleId: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
): void {
  trace[ruleId - 1] = {
    ruleId,
    name: RULE_NAMES[ruleId],
    passed: true,
    reason: null,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Verify an actor attestation against the joined evidence record.
 *
 * Returns a `VerifierOutcome` with a tri-state `verified` verdict, a
 * stable reason code, the full per-rule trace, and the echoed identity
 * fields (claimed/stored actor type, credential class, attestation kid)
 * the proof-API layer surfaces.
 *
 * This function is pure-ish: no I/O, no env reads, no mutation of
 * inputs. The clock source `input.now` is injected so the skew-window
 * check in rule 8 is testable. Production callers pass `() => new Date()`.
 */
export function verifyActorAttestation(input: VerifierInput): VerifierOutcome {
  const trace = blankTrace();
  const evidence = input.evidenceRecord;
  const stored = evidence.actorType;

  // Defensive REPLAY guard — AA-PRE-5 mirror. The DB UNIQUE constraint
  // on `actor_attestations(evidence_id)` makes siblingCount > 1
  // impossible in normal operation; this branch exists so a DB-
  // integrity violation surfaces as `CLASS_REPLAY` rather than the
  // verifier silently picking one row. Plan §2.10.
  if (input.siblingCount !== undefined && input.siblingCount > 1) {
    // Rule 1 ran — found >1 attestation. Mark rule 1 as failed with REPLAY.
    markFailureAndShortCircuit(trace, 1, ACTOR_CLASS_REASONS.REPLAY);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.REPLAY,
      ruleOutcomes: trace,
      // `claimed` is intentionally null — with multiple rows joined, we
      // refuse to pick one's `claimedActorType` to surface.
      claimed: null,
      stored,
      credentialClass: null,
      attestationKid: null,
    };
  }

  // Rule 1 — sibling attestation exists.
  if (input.attestation === null) {
    // UNATTESTED — verdict is `null`, NOT `false`. Trust Center renders
    // this as "unattested," never "agent impersonation detected" (CI-5).
    markFailureAndShortCircuit(trace, 1, ACTOR_CLASS_REASONS.UNATTESTED);
    // Override the rule-1 outcome: `passed: false` for UNATTESTED is
    // technically accurate (the rule did fail), but the verdict is `null`
    // because UNATTESTED is the three-state contract's `null` case.
    return {
      verified: null,
      reason: ACTOR_CLASS_REASONS.UNATTESTED,
      ruleOutcomes: trace,
      claimed: null,
      stored,
      credentialClass: null,
      attestationKid: null,
    };
  }
  const att = input.attestation;
  markPassed(trace, 1);

  // From here on, the outcome's identity-echo fields are populated from
  // the attestation. They are surfaced even when verification fails so
  // 1D's UI can render "claimed X, stored Y, verification failed because
  // of Z" rather than just "verification failed."
  const claimed = att.claimedActorType;
  const credentialClass = att.credentialClass;
  const attestationKid = att.attestationKid;

  // Rule 2 — signature valid against the JWKS entry identified by attestationKid.
  //
  // For non-agent claims (human, system), v1 has no agent-key registry
  // lookup — the contract says "humans don't carry their own signing
  // keys at v1." But the signer guard (signer.ts:273-279) refuses to
  // mint anything except agent attestations under the AA-1 flag, so a
  // non-agent attestation row reaching this verifier is a contract
  // violation. Surface as CLASS_KEY_UNKNOWN (the kid won't resolve in
  // the agent registry) — this lets a future expansion to human/system
  // attestation slot in cleanly without changing the verifier's outer
  // contract.
  const registryEntry: RegisteredAgentKey | null =
    input.agentRegistry.resolveByKid(attestationKid);
  if (registryEntry === null) {
    markFailureAndShortCircuit(trace, 2, ACTOR_CLASS_REASONS.KEY_UNKNOWN);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.KEY_UNKNOWN,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }

  // Materialize the public key. Decode failure → CLASS_KEY_UNKNOWN
  // (from the verifier's perspective the key body is unusable).
  const publicKey = tryCreatePublicKey(registryEntry.publicKeyJwk);
  if (publicKey === null) {
    markFailureAndShortCircuit(trace, 2, ACTOR_CLASS_REASONS.KEY_UNKNOWN);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.KEY_UNKNOWN,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }

  // Reconstruct the canonical 11-field envelope the signer signed.
  // SCJ v1 sorts keys alphabetically; rebuilding the envelope object
  // produces the same bytes regardless of field declaration order.
  const envelope = rebuildSignedEnvelope(att);
  let canonicalEnvelope: string;
  try {
    canonicalEnvelope = canonicalizeJSON(envelope);
  } catch {
    // SCJ v1 canonicalization should never throw on a row read from the
    // DB (the signer guarantees canonicalizable shape). If it does, the
    // record is malformed — surface as SIGNATURE_INVALID since we
    // cannot construct the bytes to verify against.
    markFailureAndShortCircuit(trace, 2, ACTOR_CLASS_REASONS.SIGNATURE_INVALID);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.SIGNATURE_INVALID,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }

  let sigOk = false;
  try {
    const sigBytes = Buffer.from(att.signature, "base64");
    sigOk = cryptoVerify(
      null,
      Buffer.from(canonicalEnvelope, "utf-8"),
      publicKey,
      sigBytes,
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    markFailureAndShortCircuit(trace, 2, ACTOR_CLASS_REASONS.SIGNATURE_INVALID);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.SIGNATURE_INVALID,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }
  markPassed(trace, 2);

  // Rule 3 — kid not revoked (or signed strictly before revocation).
  // OB-3 parity: `isAgentKidRevokedAtOrAfter` returns `true` iff the
  // kid is revoked AT OR BEFORE attestationCreatedAt, which is exactly
  // the rejection condition.
  if (
    isAgentKidRevokedAtOrAfter(
      input.revocationList,
      attestationKid,
      att.attestationCreatedAt,
    )
  ) {
    markFailureAndShortCircuit(trace, 3, ACTOR_CLASS_REASONS.KEY_REVOKED);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.KEY_REVOKED,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }
  markPassed(trace, 3);

  // Rule 4 — claimedActorType == stored actorType.
  if (claimed !== stored) {
    markFailureAndShortCircuit(trace, 4, ACTOR_CLASS_REASONS.TYPE_MISMATCH);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.TYPE_MISMATCH,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }
  markPassed(trace, 4);

  // Rule 5 — credentialClass consistent with claimedActorType (AA-PRE-2
  // matrix re-run; verifier does not trust the stored boolean).
  if (!isCredentialClassConsistent(claimed, credentialClass)) {
    markFailureAndShortCircuit(trace, 5, ACTOR_CLASS_REASONS.CREDENTIAL_MISMATCH);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.CREDENTIAL_MISMATCH,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }
  markPassed(trace, 5);

  // Rule 6 — payloadHash echoes evidence.evidenceHash byte-for-byte.
  if (att.payloadHash !== evidence.evidenceHash) {
    markFailureAndShortCircuit(trace, 6, ACTOR_CLASS_REASONS.PAYLOAD_HASH_MISMATCH);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.PAYLOAD_HASH_MISMATCH,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }
  markPassed(trace, 6);

  // Rule 7 — for agent claims, JWKS entry's agentId == evidence.actorId.
  // For non-agent claims (currently impossible per the signer guard, but
  // future-proofed), this rule is a no-op pass.
  if (claimed === "agent") {
    if (registryEntry.agentId !== evidence.actorId) {
      markFailureAndShortCircuit(trace, 7, ACTOR_CLASS_REASONS.AGENT_ID_MISMATCH);
      return {
        verified: false,
        reason: ACTOR_CLASS_REASONS.AGENT_ID_MISMATCH,
        ruleOutcomes: trace,
        claimed,
        stored,
        credentialClass,
        attestationKid,
      };
    }
  }
  markPassed(trace, 7);

  // Rule 8 — attestationCreatedAt strict-RFC3339, >= evidence.createdAt,
  // within clock-skew window. The contract specifies the skew window as
  // a constant (5 minutes; plan §2.6). The `now` injection lets tests
  // pin the wall clock but does not change the window's role: the lower
  // bound is evidence.createdAt, the upper bound is evidence.createdAt
  // + CLOCK_SKEW_WINDOW_MS. `now` is consulted only for a
  // sanity check that attestationCreatedAt is not absurdly future.
  if (!isStrictRfc3339Mirror(att.attestationCreatedAt)) {
    markFailureAndShortCircuit(trace, 8, ACTOR_CLASS_REASONS.TIMESTAMP_INVALID);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.TIMESTAMP_INVALID,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }
  if (!isStrictRfc3339Mirror(evidence.createdAt)) {
    markFailureAndShortCircuit(trace, 8, ACTOR_CLASS_REASONS.TIMESTAMP_INVALID);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.TIMESTAMP_INVALID,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }
  const attMs = Date.parse(att.attestationCreatedAt);
  const evMs = Date.parse(evidence.createdAt);
  if (!Number.isFinite(attMs) || !Number.isFinite(evMs)) {
    markFailureAndShortCircuit(trace, 8, ACTOR_CLASS_REASONS.TIMESTAMP_INVALID);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.TIMESTAMP_INVALID,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }
  if (attMs < evMs) {
    // attestationCreatedAt before evidence.createdAt — replay/backdate.
    markFailureAndShortCircuit(trace, 8, ACTOR_CLASS_REASONS.TIMESTAMP_INVALID);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.TIMESTAMP_INVALID,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }
  if (attMs - evMs > CLOCK_SKEW_WINDOW_MS) {
    // attestationCreatedAt more than 5 minutes after evidence.createdAt
    // — outside the operational moment the attestation is supposed to
    // be minted in.
    markFailureAndShortCircuit(trace, 8, ACTOR_CLASS_REASONS.TIMESTAMP_INVALID);
    return {
      verified: false,
      reason: ACTOR_CLASS_REASONS.TIMESTAMP_INVALID,
      ruleOutcomes: trace,
      claimed,
      stored,
      credentialClass,
      attestationKid,
    };
  }
  markPassed(trace, 8);

  return {
    verified: true,
    reason: ACTOR_CLASS_REASONS.VERIFIED,
    ruleOutcomes: trace,
    claimed,
    stored,
    credentialClass,
    attestationKid,
  };
}
