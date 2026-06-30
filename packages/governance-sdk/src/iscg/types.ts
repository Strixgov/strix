/**
 * Instance-Scoped Capability Grants v1 (ISCG) — canonical type definitions.
 *
 * Implements the locked bearer-assertion schema from
 * `docs/architecture/instance-scoped-capability-grants-v1.md`
 * (contractVersion 0.2.0 — SIM-1 findings applied; pre-launch draft).
 *
 * **Field order is load-bearing.** Reordering the 11 fields of
 * `BearerAssertionPayload` invalidates every signed assertion against
 * this schema. The serializer (SCJ v1 mirror, byte-equivalent to
 * `solo-builder-core/src/canonical-json.ts`) walks fields in declaration
 * order; reordering changes the canonical bytes and breaks signatures.
 *
 * This file is types-only. Signer, verifier, and runtime behavior live in
 * sibling modules; the verifier hasn't shipped yet (CP-CAP-009 rollout
 * step 2).
 */

// ─── Primitive enums ────────────────────────────────────────────────────────

/**
 * Principal classes that may hold an instance-scoped capability grant.
 * Mirrors `PrincipalType` in `apps/strix-console/prisma/schema.prisma`.
 */
export type IscgPrincipalType = "OPERATOR" | "AGENT" | "SERVICE";

/**
 * Verifier evaluation mode. Affects ONLY the revocation precondition
 * (see ISCG-2a / ISCG-2b in the architecture doc). Every other check
 * is mode-invariant.
 *
 * - `LIVE`       — live capability check at request time. Revocation
 *                  evaluated against `now`. ISCG-2a.
 * - `HISTORICAL` — verifying a stored bearer-assertion reference
 *                  (offline bundle, retention audit, evidence replay).
 *                  Revocation evaluated against `assertion.iat` per
 *                  OB-3. ISCG-2b.
 *
 * The signer is mode-agnostic; the field exists in the verifier's API
 * and is documented here so the type surface enumerates it once.
 */
export type IscgVerifyContext = "LIVE" | "HISTORICAL";

// ─── Constants (mirror the architecture doc's locked values) ────────────────

/** Default freshness window for bearer assertions, in seconds. */
export const BEARER_ASSERTION_DEFAULT_TTL_SECONDS = 300;

/** Hard cap on freshness window. Signer refuses to mint above this. */
export const BEARER_ASSERTION_MAX_TTL_SECONDS = 900;

/** Default tolerance for future `iat` values, in seconds (F-3 fix). */
export const BEARER_ASSERTION_CLOCK_SKEW_SECONDS_DEFAULT = 60;

/** Hard cap on clock-skew tolerance. */
export const BEARER_ASSERTION_CLOCK_SKEW_SECONDS_MAX = 300;

/** Minimum entropy (in bits) for the `nonce` field (F-2 fix). */
export const BEARER_ASSERTION_NONCE_MIN_BITS = 128;

// ─── The 11-field canonical payload ────────────────────────────────────────

/**
 * The 11-field locked payload. Order is canonical and load-bearing.
 *
 * Serialization rule: SCJ v1 (the SDK-side mirror of
 * `solo-builder-core/src/canonical-json.ts`). SCJ v1 sorts keys when
 * canonicalizing objects, so declaration order in TypeScript does not
 * affect the output — but the *field set itself* is the contract, and
 * adding, removing, or renaming any field is a contract-version-bump
 * event.
 *
 * Wire form: `base64url(SCJ v1(payload)) + "." + base64url(signature)`,
 * presented as the `X-Strix-Instance-Assertion` HTTP header.
 */
export interface BearerAssertionPayload {
  /** Schema version. Hard-pinned to `1` for ISCG v1 (0.2.0). */
  schemaVersion: 1;

  /**
   * Ed25519 key ID. Must match `grant.instanceId`. Reuse with AA-1
   * agent operational keys is intentional — see architecture doc
   * §"Kid reuse with AA-1".
   */
  kid: string;

  /** Tenant identifier. Must match the request's authenticated tenant. */
  tenantId: string;

  /**
   * Environment binding (F-7). Bound into the signed payload because the
   * grant's `environment` is the source of truth, never `process.env` at
   * verify time (SE-14 parity). Must match `grant.environment`.
   */
  environment: string;

  /** Principal type. Must match `grant.principalType`. (F-5) */
  principalType: IscgPrincipalType;

  /** Principal identifier. Must match `grant.principalId`. (F-5) */
  principalId: string;

  /** Capability. Exact-match, no wildcards. Must match `grant.capability`. */
  capability: string;

  /**
   * SHA-256 of the canonical request descriptor, prefixed `sha256:`.
   * The descriptor schema is pinned per `VerifyContext` (F-1 fix):
   *
   *   LIVE      — { method, pathTemplate, routeParams, capability, scope }
   *   HISTORICAL — { capability, scope, contextId }
   *
   * Verifier MUST construct the descriptor from the route table, never
   * from `req.url` parsing.
   */
  requestHash: string;

  /**
   * Single-use nonce (F-2). At least 128 bits, base64url-encoded. The
   * verifier records `(kid, nonce)` for `ASSERTION_TTL` and rejects a
   * second sighting with `INSTANCE_ASSERTION_NONCE_REPLAYED`. The same
   * nonce MAY be reused across different `kid`s (the table is per-kid).
   */
  nonce: string;

  /**
   * Issued-at timestamp. Strict RFC 3339 via `isStrictRfc3339Mirror`.
   * Signer enforces `iat <= now + CLOCK_SKEW_TOLERANCE` (F-3).
   */
  iat: string;

  /**
   * Expiry timestamp. Strict RFC 3339. Signer enforces
   * `exp <= iat + ASSERTION_TTL` and refuses `exp - iat > 900s`.
   */
  exp: string;
}

/**
 * The bearer-assertion signed envelope = canonical payload + Ed25519
 * signature over its SCJ v1 serialization.
 *
 * The signature is base64-encoded for ergonomics. The wire-level
 * `X-Strix-Instance-Assertion` header uses base64URL for both halves.
 */
export interface BearerAssertionSignedEnvelope extends BearerAssertionPayload {
  /** Base64-encoded Ed25519 signature over `canonicalizeJSON(payload)`. */
  signature: string;
}

// ─── Verifier reason codes (stable strings — public contract) ───────────────

/**
 * Stable verifier-output reason codes. **Public contract** — adding,
 * renaming, or reusing any code is a breaking change. Mirror the
 * CP-K-001 `BindingReason` discipline.
 *
 * Codes ending in `_MISMATCH`, `_MISSING`, `_MALFORMED`, `_EXPIRED`,
 * `_TTL_EXCEEDED`, `_IN_FUTURE`, `_REPLAYED`, `_NOT_FOUND`,
 * `_OUT_OF_WINDOW`, `_UNTRUSTED_ROOT`, `_REVOKED`, `_SIGNATURE_INVALID`,
 * `_REQUEST_HASH_MISMATCH` are emitted by the verifier at the
 * corresponding precondition's failure point. There is no aggregate or
 * generic deny code — every failure has a stable address.
 */
export type InstanceDenyReason =
  | "INSTANCE_ASSERTION_MISSING"
  | "INSTANCE_ASSERTION_MALFORMED"
  | "INSTANCE_KID_MISMATCH"
  | "INSTANCE_TENANT_MISMATCH"
  | "INSTANCE_ENVIRONMENT_MISMATCH"
  | "INSTANCE_PRINCIPAL_MISMATCH"
  | "INSTANCE_CAPABILITY_MISMATCH"
  | "INSTANCE_ASSERTION_EXPIRED"
  | "INSTANCE_ASSERTION_IAT_IN_FUTURE"
  | "INSTANCE_ASSERTION_TTL_EXCEEDED"
  | "INSTANCE_ASSERTION_NONCE_REPLAYED"
  | "INSTANCE_ATTESTATION_NOT_FOUND"
  | "INSTANCE_ATTESTATION_OUT_OF_WINDOW"
  | "INSTANCE_ATTESTATION_UNTRUSTED_ROOT"
  | "INSTANCE_KID_REVOKED"
  | "INSTANCE_ASSERTION_SIGNATURE_INVALID"
  | "INSTANCE_REQUEST_HASH_MISMATCH";

/**
 * Field list as a runtime-readable tuple. Used by the
 * `assertCanonicalPayloadShape()` helper in the signer to defend against
 * shape drift in untyped callers.
 *
 * **Order MUST match the declared order of `BearerAssertionPayload`.**
 * SCJ v1 sorts keys lexicographically when serializing — so the runtime
 * order is not what the signature covers — but keeping this tuple in
 * declared order means a code-review can grep both and confirm they
 * match without reading TypeScript declaration semantics.
 */
export const BEARER_ASSERTION_FIELDS_V1 = [
  "schemaVersion",
  "kid",
  "tenantId",
  "environment",
  "principalType",
  "principalId",
  "capability",
  "requestHash",
  "nonce",
  "iat",
  "exp",
] as const satisfies ReadonlyArray<keyof BearerAssertionPayload>;
