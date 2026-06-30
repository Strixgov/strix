/**
 * Actor Attestation Verifier — type-level contract (AA-1 PR 1C.3).
 *
 * Locked types for the verifier surface. The verifier itself lives in
 * `verifier.ts`; the matrix lives in `credential-class-matrix.ts`; this
 * module is intentionally implementation-free so other modules (including
 * 1D's data-access reader) can import the type contract without dragging
 * in the verifier's runtime dependencies.
 *
 * **Three-state semantics — load-bearing.** `VerifiedClass = true | false | null`
 * encodes the contract's tri-state truth claim:
 *   - `true`  — all 8 verifier rules passed → `CLASS_VERIFIED`
 *   - `false` — verification ran and a rule failed → one of the failing
 *               `CLASS_*` codes
 *   - `null`  — UNATTESTED: no sibling `actor_attestation_v1` record was
 *               found for this evidence record. Distinct from `false` —
 *               collapsing the two is the CI-5 trust-claim violation called
 *               out in `actor-attestation-v1.md` §"What breaks if this is
 *               wrong" (would surface "agent impersonation detected" for
 *               every legacy record).
 *
 * Anywhere downstream that narrows `VerifiedClass` to `boolean` is a
 * regression — type-system enforcement is the first line of defense
 * before the runtime check in the verifier.
 *
 * Source: `docs/architecture/actor-attestation-v1.md` contractVersion 1.0.0
 * and `docs/gates/AA-1-PR-1C3-IMPLEMENTATION-PLAN.md` §2.2, §2.3, §5.4.
 */

import type {
  ActorAttestationRecord,
  ActorClassReason,
  ActorType,
  CredentialClass,
} from "../attestation/types.js";
import type { AgentKeyRegistry } from "../agents/registry.js";
import type { SignedRevocationList } from "./revocation-check.js";

// ─── Three-state verdict ────────────────────────────────────────────────────

/**
 * Verifier verdict. Three states, exactly:
 *   - `true`  → `CLASS_VERIFIED` (rules 1–8 all passed)
 *   - `false` → a rule failed; pair with one of the failure `CLASS_*` codes
 *   - `null`  → UNATTESTED (rule 1 short-circuit: no sibling attestation)
 *
 * The `null` state is NOT a marker for "verifier errored out." Infrastructure
 * failures (registry unavailable, etc.) return `false` with `CLASS_KEY_UNKNOWN`
 * so the audit trail records a deterministic rule outcome.
 */
export type VerifiedClass = true | false | null;

// Re-export the stable reason codes for convenience. The canonical
// declaration lives in `attestation/types.ts` (frozen in PR 1A).
export type { ActorClassReason } from "../attestation/types.js";

// ─── Per-rule outcome trace ─────────────────────────────────────────────────

/**
 * Outcome of a single verifier rule. Always emitted for every rule, even
 * when an earlier rule short-circuited. A short-circuited rule has
 * `passed: null` — that is how "not evaluated" is represented; the rule
 * is never silently dropped from the trace. Mirrors the K-BIND-1 verifier
 * pattern in `solo-builder-core/src/execution-receipt-verifier-v1.ts`.
 */
export interface RuleOutcome {
  ruleId: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  name: string;
  /** `true` when the rule passed; `false` when it failed; `null` when not evaluated (short-circuit). */
  passed: boolean | null;
  /** Stable reason code when the rule failed; `null` otherwise. */
  reason: ActorClassReason | null;
}

/**
 * Canonical rule names. Frozen at module load — used both for trace
 * `name` fields and for human-readable error reporting. The 8 rules
 * mirror `docs/architecture/actor-attestation-v1.md` §"Verifier rules".
 */
export const RULE_NAMES = Object.freeze({
  1: "sibling_attestation_exists",
  2: "signature_valid",
  3: "key_not_revoked",
  4: "actor_type_matches",
  5: "credential_class_consistent",
  6: "payload_hash_matches",
  7: "agent_id_matches",
  8: "timestamp_valid",
} as const) satisfies Readonly<Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, string>>;

export type RuleName = (typeof RULE_NAMES)[keyof typeof RULE_NAMES];

// ─── Verifier input ─────────────────────────────────────────────────────────

/**
 * Evidence record fields the verifier reads. Mirrors the SE v1 columns 1D's
 * `EvidenceContextRef`-style reader will pre-populate. Field set deliberately
 * narrow — anything not used by a rule does not appear here.
 */
export interface VerifierEvidenceContext {
  /** Joins SE v1 ↔ AA-1. */
  evidenceId: string;
  /** Stored actor identity from the SE v1 record. Compared against the agent registry's `agentId` (rule 7). */
  actorId: string;
  /** Stored actor class. Compared against `attestation.claimedActorType` (rule 4). */
  actorType: ActorType;
  /** Echoed by `attestation.payloadHash` (rule 6). */
  evidenceHash: string;
  /** Strict RFC 3339 (SE-12 / SE-14 parity). Lower bound for `attestationCreatedAt` (rule 8). */
  createdAt: string;
  tenantId: string;
  environment: string;
}

/**
 * Verifier input. A flat record the caller pre-populates from the DB
 * read (1D's job). The verifier itself does no I/O: no Prisma, no
 * `withTenant`, no network. Pre-population means the verifier can run
 * in any environment (unit tests, dashboards, shadow audits) without
 * a database connection.
 */
export interface VerifierInput {
  /** SE v1 record fields the verifier reads. */
  evidenceRecord: VerifierEvidenceContext;
  /**
   * Sibling attestation row joined on `evidenceId`. `null` means no
   * sibling exists → rule 1 short-circuits to `CLASS_UNATTESTED`.
   *
   * When non-null, this is the full row as stored in `actor_attestations`
   * (envelope + signature + DB createdAt). The verifier consumes the
   * stored signature byte-for-byte; it does NOT re-canonicalize the
   * payload to find a signature elsewhere.
   */
  attestation: ActorAttestationRecord | null;
  /**
   * Pre-resolved agent registry. Lookup-only — the verifier never adds
   * entries. Provide `EMPTY_AGENT_KEY_REGISTRY` (or any registry whose
   * `resolveByKid` returns `null`) to force rule 2 / 7 to surface
   * `CLASS_KEY_UNKNOWN` for every kid.
   *
   * 1D wires this from `resolveAgentKeyRegistry` (registry-source.ts).
   * Tests inject `InMemoryAgentKeyRegistry` directly.
   */
  agentRegistry: AgentKeyRegistry;
  /**
   * Pre-resolved revocation list (already root-verified before this
   * point — the verifier does not re-verify the list's own signature).
   * Provide an empty entry set to model "no revocations."
   */
  revocationList: SignedRevocationList;
  /**
   * Optional defense-in-depth: number of attestation rows joined for this
   * evidenceId. The DB UNIQUE constraint on `actor_attestations(evidence_id)`
   * guarantees this is ≤ 1 in normal operation. When the caller wires
   * this and it exceeds 1, the verifier short-circuits with `CLASS_REPLAY`
   * before evaluating any cryptographic rule. AA-PRE-5 parity.
   *
   * Omit (or pass `1`/`0`) when the caller's read path already guarantees
   * uniqueness via the constraint. See plan §2.10.
   */
  siblingCount?: number;
  /**
   * Clock source for skew-window evaluation in rule 8. Injected so tests
   * can pin the wall clock. Production callers pass `() => new Date()`.
   * Plan §5.4.
   */
  now: () => Date;
}

// ─── Verifier outcome ───────────────────────────────────────────────────────

/**
 * Full verifier output. The shape 1D will surface (modulo public-API
 * redaction) into the `actorClass` block on `/api/public/verify`. The
 * SDK consumer (tests, dashboards) gets the full per-rule trace; 1D
 * may project a narrower public surface — but the canonical shape lives
 * here, not in a Console-side translator.
 */
export interface VerifierOutcome {
  /** Tri-state verdict. Type-system enforced; never collapsed to boolean. */
  verified: VerifiedClass;
  /** Stable code (`CLASS_*`) describing the verdict's cause. */
  reason: ActorClassReason;
  /**
   * Per-rule trace in declared order. ALWAYS length 8. Rules not
   * evaluated (because an earlier rule short-circuited) have
   * `passed: null` rather than being omitted.
   */
  ruleOutcomes: RuleOutcome[];
  /**
   * What the attestation claimed. `null` when no attestation row was
   * joined (rule 1 short-circuit). Echoed for proof-API parity.
   */
  claimed: ActorType | null;
  /** What the joined evidence record stored. */
  stored: ActorType;
  /**
   * Credential class observed by the auth boundary. `null` when no
   * attestation row was joined.
   */
  credentialClass: CredentialClass | null;
  /**
   * JWKS kid of the attestation signer. `null` when no attestation row
   * was joined.
   */
  attestationKid: string | null;
}

// ─── Module-private constants ───────────────────────────────────────────────

/**
 * Clock-skew window for AA-PRE-4 / rule 8. 5 minutes — same window as
 * execution-token TTL. **Not env-tunable**: a future change requires a
 * gate-report bump per plan §2.6, NOT an environment-variable override.
 *
 * Exported so tests can pin the constant explicitly. Production callers
 * should not consume this — the verifier consumes it directly.
 */
export const CLOCK_SKEW_WINDOW_MS = 5 * 60 * 1000;
