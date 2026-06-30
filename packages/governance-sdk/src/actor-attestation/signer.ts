/**
 * Actor Attestation Signer — AA-1 PR 1C.2
 *
 * Mints `actor_attestation_v1` records. Called from the SE v1 evidence
 * write transaction on the strix-platform side (entry point:
 * `apps/strix-console/src/lib/aa1/sign-on-evidence-write.ts`).
 *
 * Preconditions (AA-PRE-1..6 from
 * `docs/architecture/actor-attestation-v1.md` §"Signer preconditions"):
 *
 *   AA-PRE-1: For `claimedActorType == "agent"`, a valid Ed25519 sig
 *             exists, kid resolves in registry, key not revoked.
 *   AA-PRE-2: `credentialClass` consistent with `claimedActorType`.
 *             Production-only: `dev_impersonation` rejected unconditionally.
 *   AA-PRE-3: `payloadHash` echoes evidence record's `evidenceHash`.
 *   AA-PRE-4: `attestationCreatedAt` strict RFC3339, ≥ evidence.createdAt,
 *             within bounded clock-skew window (5 min).
 *   AA-PRE-5: `(evidenceId, attestationId)` unique. Append-only.
 *   AA-PRE-6: For agent claims, registry entry's agentId equals
 *             evidence.actorId.
 *
 * A single failed check aborts the signing and aborts the parent SE v1
 * transaction.
 *
 * **Load-bearing — no platform-key fallback.** The signer never falls
 * back to `STRIX_SIGNING_PRIVATE_KEY` for agent attestations. If the
 * agent's private key is unavailable, the signer throws
 * `ATTESTATION_SIGNING_UNAVAILABLE` and the caller decides whether to
 * fail-close (HIGH/CRITICAL) or degrade (medium/low). The platform key
 * is reserved for SE v1 evidence + governance receipts (plan §2.4).
 */

import { createHash, sign as cryptoSign, type KeyObject } from "node:crypto";
import { canonicalizeJSON } from "./scj-v1-mirror.js";
import { isStrictRfc3339Mirror } from "../agents/loader.js";
import {
  type ActorAttestationPayload,
  type ActorAttestationSignedEnvelope,
  type ActorType,
  type CredentialClass,
} from "../attestation/types.js";
// AA-PRE-2 cross-check is now centralized in `credential-class-matrix.ts`
// (1C.3 plan §3.2 — single source of truth shared with the verifier). The
// matrix is consulted as a precondition gate; it is NOT part of the
// canonical payload, so this import re-point is a byte-no-op for 1C.2's
// locked signer goldens (plan §5.2).
import { isCredentialClassConsistent } from "./credential-class-matrix.js";
import type { AgentKeyRegistry } from "../agents/registry.js";

// ─── Errors ─────────────────────────────────────────────────────────────────

export const ACTOR_ATTESTATION_SIGNER_ERRORS = {
  // Preconditions
  PRE_1_AGENT_KEY_UNRESOLVED: "AA_PRE_1_AGENT_KEY_UNRESOLVED",
  PRE_1_AGENT_KEY_REVOKED: "AA_PRE_1_AGENT_KEY_REVOKED",
  PRE_2_CREDENTIAL_CLASS_MISMATCH: "AA_PRE_2_CREDENTIAL_CLASS_MISMATCH",
  PRE_2_DEV_IMPERSONATION_IN_PROD: "AA_PRE_2_DEV_IMPERSONATION_IN_PROD",
  PRE_3_PAYLOAD_HASH_MISMATCH: "AA_PRE_3_PAYLOAD_HASH_MISMATCH",
  PRE_4_TIMESTAMP_INVALID: "AA_PRE_4_TIMESTAMP_INVALID",
  PRE_5_DUPLICATE_ATTESTATION: "AA_PRE_5_DUPLICATE_ATTESTATION",
  PRE_6_AGENT_ID_MISMATCH: "AA_PRE_6_AGENT_ID_MISMATCH",

  // Infrastructure
  SIGNING_UNAVAILABLE: "ATTESTATION_SIGNING_UNAVAILABLE",
  PAYLOAD_INVALID: "ATTESTATION_PAYLOAD_INVALID",
} as const;

export type ActorAttestationSignerErrorCode =
  (typeof ACTOR_ATTESTATION_SIGNER_ERRORS)[keyof typeof ACTOR_ATTESTATION_SIGNER_ERRORS];

export class ActorAttestationSignerError extends Error {
  readonly code: ActorAttestationSignerErrorCode;
  constructor(code: ActorAttestationSignerErrorCode, detail?: string) {
    super(`${code}${detail ? ": " + detail : ""}`);
    this.code = code;
    this.name = "ActorAttestationSignerError";
  }
}

// ─── Clock-skew window (plan: 5 minutes) ────────────────────────────────────

/**
 * Maximum delta between `evidence.createdAt` and `attestationCreatedAt`.
 * Matches the execution-token TTL window — the attestation is meant to
 * be minted in the same operational moment as the evidence record.
 */
export const ATTESTATION_CLOCK_SKEW_SECONDS = 300;

// ─── Inputs ─────────────────────────────────────────────────────────────────

/**
 * Decision/evidence context the signer needs to evaluate preconditions.
 * The caller (sign-on-evidence-write) supplies this from the evidence
 * row being persisted in the SE v1 transaction.
 */
export interface EvidenceContextForAttestation {
  /** Joins SE v1 ↔ AA-1. Equals `decision_evidence.decisionId` (= signed-payload evidenceId). */
  evidenceId: string;
  proposalId: string;
  /** The byte-form `evidenceHash` SE v1 just signed. */
  evidenceHash: string;
  storedActorType: ActorType;
  storedActorId: string;
  /** SE v1 evidence row's createdAt (RFC 3339 strict). */
  createdAt: string;
  /** Persisted on the attestation row's signed envelope. SE-12 / SE-14 parity. */
  environment: string;
  /** Persisted on the attestation row's signed envelope. */
  tenantId: string;
}

export interface SignActorAttestationInput {
  evidence: EvidenceContextForAttestation;
  credentialClass: CredentialClass;
  /** Caller-supplied (`attestationId` generator is the caller's job — typically a ULID). */
  attestationId: string;
  /** Strict RFC 3339. */
  attestationCreatedAt: string;
  /**
   * Production flag — set true to enforce the AA-PRE-2 "no dev_impersonation
   * in prod" rule. Caller wires this from `NODE_ENV === 'production'`.
   */
  isProduction: boolean;
}

export interface SignActorAttestationContext {
  /**
   * Agent-key registry from `resolveAgentKeyRegistry`. Required only when
   * `evidence.storedActorType === 'agent'` — for human/system actors we
   * never resolve a kid.
   *
   * When `storedActorType === 'agent'` and this is null, the signer
   * throws `SIGNING_UNAVAILABLE` (matches the chain-verifier-unavailable
   * posture). The caller's job is to make sure the registry is reachable
   * before invoking the signer.
   */
  registry: AgentKeyRegistry | null;
  /**
   * The agent's Ed25519 private key. Required for agent attestations;
   * MUST NOT be the platform key. Caller validates this and supplies
   * null when the agent has no key (signer throws SIGNING_UNAVAILABLE).
   *
   * NEVER `STRIX_SIGNING_PRIVATE_KEY`. The platform key is for SE v1
   * evidence + governance receipts; using it here would collapse
   * provenance, operational identity, and AA-PRE-6.
   */
  agentPrivateKey: KeyObject | null;
  /**
   * The kid that owns `agentPrivateKey`. Must equal a registry entry's
   * kid; the signer cross-checks for AA-PRE-1 + AA-PRE-6.
   */
  agentKid: string | null;
  /**
   * Optional pre-existing-attestation lookup for AA-PRE-5. The caller
   * (sign-on-evidence-write) typically wires this to the unique
   * constraint on `actor_attestations(evidence_id)` — i.e., this is
   * usually null, and AA-PRE-5 is enforced by the DB constraint
   * instead. Pass a function when you want pre-flight rejection
   * (useful for shadow writes or testing).
   */
  existingAttestationCheck?: (
    evidenceId: string,
    attestationId: string,
  ) => Promise<boolean>;
  /**
   * Revocation check. When `storedActorType === 'agent'`, the signer
   * consults this with the agent's kid. Returns `true` ⇔ the key is
   * revoked at the moment the attestation is being signed.
   */
  isAgentKeyRevoked?: (kid: string) => boolean;
}

// ─── Output ─────────────────────────────────────────────────────────────────

/**
 * The fully-formed attestation record, ready to persist to
 * `actor_attestations`. The signer does NOT touch the database — the
 * caller (sign-on-evidence-write) owns the INSERT inside the SE v1
 * transaction.
 */
export interface SignActorAttestationResult {
  envelope: ActorAttestationSignedEnvelope;
  /** Base64 Ed25519 signature over SCJ v1 of the 11-field envelope. */
  signature: string;
  /** Hex SHA-256 of SCJ v1 of the 9-field payload. */
  canonicalPayloadHash: string;
  /** Echo of input for caller's convenience. */
  signatureAlgorithm: "Ed25519";
  schemaVersion: 1;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Sign an actor attestation. Enforces AA-PRE-1..6 + canonicalization.
 *
 * The returned envelope + signature is the input to the
 * `actor_attestations` INSERT.
 */
export async function signActorAttestation(
  input: SignActorAttestationInput,
  context: SignActorAttestationContext,
): Promise<SignActorAttestationResult> {
  // AA-PRE-2 — credential class consistent with claimed actor type.
  // We evaluate this BEFORE PRE-1 so callers see the most useful error
  // (a credential-class mismatch usually means the call site is wrong;
  // a missing agent key usually means infra is wrong).
  if (
    !isCredentialClassConsistent(input.evidence.storedActorType, input.credentialClass)
  ) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_2_CREDENTIAL_CLASS_MISMATCH,
      `storedActorType=${input.evidence.storedActorType} credentialClass=${input.credentialClass}`,
    );
  }

  // AA-PRE-2 (production override) — dev_impersonation NEVER signs in prod.
  if (input.credentialClass === "dev_impersonation" && input.isProduction) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_2_DEV_IMPERSONATION_IN_PROD,
    );
  }

  // AA-PRE-4 — timestamps. Strict RFC 3339; attestationCreatedAt >=
  // evidence.createdAt; within clock-skew window.
  if (!isStrictRfc3339Mirror(input.attestationCreatedAt)) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_4_TIMESTAMP_INVALID,
      `attestationCreatedAt not strict RFC3339: ${input.attestationCreatedAt}`,
    );
  }
  if (!isStrictRfc3339Mirror(input.evidence.createdAt)) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_4_TIMESTAMP_INVALID,
      `evidence.createdAt not strict RFC3339: ${input.evidence.createdAt}`,
    );
  }
  const attMs = Date.parse(input.attestationCreatedAt);
  const evMs = Date.parse(input.evidence.createdAt);
  if (!Number.isFinite(attMs) || !Number.isFinite(evMs)) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_4_TIMESTAMP_INVALID,
      "non-finite timestamp after RFC3339 check (host runtime regression?)",
    );
  }
  if (attMs < evMs) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_4_TIMESTAMP_INVALID,
      `attestationCreatedAt(${input.attestationCreatedAt}) < evidence.createdAt(${input.evidence.createdAt})`,
    );
  }
  if (attMs - evMs > ATTESTATION_CLOCK_SKEW_SECONDS * 1000) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_4_TIMESTAMP_INVALID,
      `attestationCreatedAt - evidence.createdAt > ${ATTESTATION_CLOCK_SKEW_SECONDS}s (replay window)`,
    );
  }

  // AA-PRE-5 — pre-flight duplicate check (when caller wires it).
  if (context.existingAttestationCheck) {
    const exists = await context.existingAttestationCheck(
      input.evidence.evidenceId,
      input.attestationId,
    );
    if (exists) {
      throw new ActorAttestationSignerError(
        ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_5_DUPLICATE_ATTESTATION,
        `(evidenceId=${input.evidence.evidenceId}, attestationId=${input.attestationId})`,
      );
    }
  }

  // Per plan §2.2, the signer is invoked ONLY for `actorType === 'agent'`
  // when the AA-1 flag is on. Non-agent paths are handled at the
  // sign-on-evidence-write entry point (it short-circuits before calling
  // the signer). This is a defensive guard — if a future caller forgets
  // the short-circuit, we want a loud failure, not a silent unsigned row.
  if (input.evidence.storedActorType !== "agent") {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PAYLOAD_INVALID,
      `signer invoked for non-agent actor (${input.evidence.storedActorType}). ` +
        `Caller must short-circuit before reaching the signer (plan §2.2).`,
    );
  }

  // AA-PRE-1: registry available + kid resolves.
  if (context.registry === null) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.SIGNING_UNAVAILABLE,
      "agent attestation requires registry; got null",
    );
  }
  if (context.agentKid === null) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.SIGNING_UNAVAILABLE,
      "agent attestation requires agentKid; got null",
    );
  }
  const entry = context.registry.resolveByKid(context.agentKid);
  if (entry === null) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_1_AGENT_KEY_UNRESOLVED,
      context.agentKid,
    );
  }
  // AA-PRE-1: revocation check.
  if (context.isAgentKeyRevoked && context.isAgentKeyRevoked(context.agentKid)) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_1_AGENT_KEY_REVOKED,
      context.agentKid,
    );
  }
  // AA-PRE-6: registry entry's agentId must equal evidence.actorId.
  if (entry.agentId !== input.evidence.storedActorId) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_6_AGENT_ID_MISMATCH,
      `registry.agentId=${entry.agentId} evidence.actorId=${input.evidence.storedActorId}`,
    );
  }
  // Hard refuse if the caller didn't supply a private key. The signer
  // NEVER falls back to a platform key — plan §2.4.
  if (context.agentPrivateKey === null) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.SIGNING_UNAVAILABLE,
      "agent attestation requires agentPrivateKey; got null. " +
        "No platform-key fallback is permitted (plan §2.4).",
    );
  }

  // Build the 9-field payload (locked order).
  const payload: ActorAttestationPayload = {
    schemaVersion: 1,
    attestationId: input.attestationId,
    evidenceId: input.evidence.evidenceId,
    proposalId: input.evidence.proposalId,
    payloadHash: input.evidence.evidenceHash,
    claimedActorType: input.evidence.storedActorType,
    attestationKid: context.agentKid,
    credentialClass: input.credentialClass,
    attestationCreatedAt: input.attestationCreatedAt,
  };

  // AA-PRE-3 — the payload's payloadHash MUST echo evidence.evidenceHash.
  // (Trivially true here since we just constructed it from the input,
  // but the assertion documents the invariant.)
  if (payload.payloadHash !== input.evidence.evidenceHash) {
    throw new ActorAttestationSignerError(
      ACTOR_ATTESTATION_SIGNER_ERRORS.PRE_3_PAYLOAD_HASH_MISMATCH,
    );
  }

  // Canonical payload hash (the bookkeeping column added by M1).
  const canonicalPayload = canonicalizeJSON(payload);
  const canonicalPayloadHash = createHash("sha256")
    .update(canonicalPayload, "utf-8")
    .digest("hex");

  // The 11-field envelope (= payload + environment + tenantId). The
  // verifier reads environment + tenantId from the stored row, never
  // from `process.env` (SE-14 parity).
  const envelope: ActorAttestationSignedEnvelope = {
    ...payload,
    environment: input.evidence.environment,
    tenantId: input.evidence.tenantId,
  };

  // Sign the canonical 11-field envelope with the agent's OWN key.
  // NEVER the platform key (plan §2.4).
  const canonicalEnvelope = canonicalizeJSON(envelope);
  const sigBytes = cryptoSign(
    null,
    Buffer.from(canonicalEnvelope, "utf-8"),
    context.agentPrivateKey,
  );
  const signature = sigBytes.toString("base64");

  return {
    envelope,
    signature,
    canonicalPayloadHash,
    signatureAlgorithm: "Ed25519",
    schemaVersion: 1,
  };
}
