/**
 * Actor Attestation v1 — canonical type definitions.
 *
 * Implements the locked schema from `docs/architecture/actor-attestation-v1.md`
 * (contractVersion 1.0.0, frozen 2026-05-11).
 *
 * **Field order is load-bearing.** Reordering the 9 fields of
 * `ActorAttestationPayload` invalidates every existing attestation that
 * will ever be signed against this schema. The serializer (SCJ v1 from
 * `solo-builder-core/src/canonical-json.ts`) walks fields in declaration
 * order; reordering changes the canonical bytes and breaks signatures.
 *
 * This file is schema-only. Signer, verifier, and runtime behavior are out
 * of scope for PR 1A; they ship in PRs 1C–1F per the rollout staircase in
 * the architecture doc.
 */

/**
 * Actor classes recognized by the kernel. Unchanged by AA-1 (we *verify*
 * this enum, we don't extend it). Source of truth: SE v1 13-field payload.
 */
export type ActorType = "agent" | "human" | "system";

/**
 * Credential class observed at the auth boundary. The auth middleware
 * (`apps/strix-console/src/lib/middleware/require-auth.ts`) is the
 * **single source of truth** for this value — never read it from a
 * request header (a header would be forgeable).
 *
 * - `agent_token`        — minted from the agent-onboarding flow; bears an aid claim
 * - `service_token`      — STRIX_INTERNAL_TOKEN class; service-to-service
 * - `session`            — human session cookie
 * - `dev_impersonation`  — STRIX_DEV_IMPERSONATION (production must reject)
 * - `internal`           — internal-only callers (cron, reconciliation watchdog)
 */
export type CredentialClass =
  | "agent_token"
  | "service_token"
  | "session"
  | "dev_impersonation"
  | "internal";

/**
 * The 9-field locked payload. Order is canonical and load-bearing.
 *
 * Serialization rule: SCJ v1 (`solo-builder-core/src/canonical-json.ts`).
 * The signature covers an 11-field document = these 9 fields plus
 * `environment` and `tenantId`, captured at signing time and read from
 * the stored record at verify time (SE-12 / SE-14 parity — never from
 * `process.env`).
 */
export interface ActorAttestationPayload {
  /** Schema version. Hard-pinned to `1` for AA-1. */
  schemaVersion: 1;

  /** Globally unique attestation ID. ULID-shaped, prefixed `att_`. */
  attestationId: string;

  /** Joins to the SE v1 evidence record. Prefixed `evi_`. */
  evidenceId: string;

  /** Matches the proposal/decision ID on the joined evidence record. */
  proposalId: string;

  /**
   * Echo of the SE v1 record's `evidenceHash`, prefixed `sha256:`.
   * Immutable join key — the attestation cannot bind to one evidence
   * record while referencing a different payload (AA-PRE-3).
   */
  payloadHash: string;

  /** Actor class being attested. Must equal the evidence record's stored `actorType`. */
  claimedActorType: ActorType;

  /**
   * JWKS key identifier of the signing key. For agents, format is
   * `agent-<agentId>-<YYYY-MM>` (e.g., `agent-content-001-2026-05`).
   */
  attestationKid: string;

  /**
   * Credential class observed at the auth boundary. Verifier re-runs the
   * AA-PRE-2 cross-check with `claimedActorType`; it never trusts a
   * stored boolean.
   */
  credentialClass: CredentialClass;

  /**
   * Strict RFC 3339 timestamp. Validated by the same parser as CP-K-001
   * (`solo-builder-core/src/rfc3339.ts`). Must be ≥ evidence record's
   * `createdAt` and within the bounded clock-skew window (default 5 min).
   */
  attestationCreatedAt: string;
}

/**
 * The signed envelope = 9-field payload + `environment` + `tenantId`.
 *
 * Both extra fields are captured at signing time. The verifier reads them
 * from the stored record (database row) — never from `process.env` or
 * request headers. This is the SE-14 discipline extended to AA-1.
 */
export interface ActorAttestationSignedEnvelope extends ActorAttestationPayload {
  /** Captured at signing time. Verifier reads from stored record. */
  environment: string;

  /** Captured at signing time. Verifier reads from stored record. */
  tenantId: string;
}

/**
 * The complete persisted attestation record = signed envelope +
 * cryptographic signature. This is the shape stored in the
 * `actor_attestations` table and returned by the registry.
 */
export interface ActorAttestationRecord extends ActorAttestationSignedEnvelope {
  /** Base64-encoded Ed25519 signature over the canonicalized 11-field envelope. */
  signature: string;

  /** Database write timestamp (separate from `attestationCreatedAt`). */
  createdAt: string;
}

/**
 * Stable verifier-output reason codes. **Public contract** — adding,
 * renaming, or reusing any code is a breaking change. Mirror the
 * CP-K-001 `BindingReason` discipline.
 *
 * **`CLASS_REVOCATION_CHECK_UNAVAILABLE` is substrate-state, not a
 * verifier-rule outcome.** All other codes are emitted by the verifier's
 * eight rules over a fully-resolved input set. This one is emitted by
 * the platform-side AA-1 wiring (`aa1-context-loader`) when the
 * revocation distribution surface is unreachable or the served list
 * fails root-signature verification — i.e. the verifier could not
 * honestly compute rule 3. The block is surfaced as
 * `verified: null + reason: CLASS_REVOCATION_CHECK_UNAVAILABLE` to
 * preserve ADR-014 §1 "no server-side verdict" (a verdict was not
 * computed) and ADR-015 §5 tri-state semantics. Trust Center renders
 * this as "Cannot verify — revocation surface unavailable," NEVER as
 * "verification failed" (which would assert a verdict that wasn't run).
 *
 * Source: AA-1 PR 1F precondition P2; plan §3.2 + the open design call
 * resolved to option (a) per session 2026-05-13.
 */
export type ActorClassReason =
  | "CLASS_VERIFIED"
  | "CLASS_UNATTESTED"
  | "CLASS_SIGNATURE_INVALID"
  | "CLASS_KEY_REVOKED"
  | "CLASS_KEY_UNKNOWN"
  | "CLASS_TYPE_MISMATCH"
  | "CLASS_CREDENTIAL_MISMATCH"
  | "CLASS_PAYLOAD_HASH_MISMATCH"
  | "CLASS_AGENT_ID_MISMATCH"
  | "CLASS_TIMESTAMP_INVALID"
  | "CLASS_REPLAY"
  | "CLASS_REVOCATION_CHECK_UNAVAILABLE";

/**
 * Top-level block emitted by the verifier into both the SDK response and
 * the public `/api/public/verify` response. Unchanged shape regardless of
 * surface — byte-identical between the two consumers (PR 1D).
 *
 * `verified: null` indicates a pre-AA-1 record with no sibling attestation;
 * the Trust Center MUST render `null` as "unattested," never as "verified."
 */
export interface ActorClassBlock {
  /** What the attestation claimed. `null` if no attestation exists. */
  claimed: ActorType | null;

  /** What the joined evidence record stored. */
  stored: ActorType;

  /** Verification outcome. `null` for legacy records (no attestation). */
  verified: boolean | null;

  /** Stable reason code; see `ActorClassReason`. */
  reason: ActorClassReason;

  /** Echo of the credential class from the attestation, when present. */
  credentialClass: CredentialClass | null;

  /** JWKS key identifier of the attestation signer, when present. */
  attestationKid: string | null;
}

/**
 * Enum-style frozen lookup for the AA-PRE-2 cross-check. Returns `true`
 * iff `(claimedActorType, credentialClass)` is a permitted pair.
 *
 * AA-1 PR 1C.3 centralized the cross-check matrix in
 * `actor-attestation/credential-class-matrix.ts` so the signer (1C.2) and
 * the verifier (1C.3) share a single source of truth. This export is
 * preserved as a thin alias for backwards compatibility with the SDK
 * barrel (`@strixgov/sdk`). New code should import
 * `isCredentialClassConsistent` from the matrix module directly.
 *
 * The implementation deliberately is NOT delegated via dynamic import —
 * the inline switch preserves byte-output parity with 1C.2's locked
 * signer goldens (plan §5.2) by avoiding any new module-graph edge that
 * might affect bundling.
 *
 * Note: `dev_impersonation` is permitted for `human` here at the type
 * level. The runtime check in PR 1C must additionally reject it
 * unconditionally in production environments (see signer precondition
 * AA-PRE-2 detail).
 */
export function credentialClassMatchesActor(
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
