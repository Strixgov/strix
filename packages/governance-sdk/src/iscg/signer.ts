/**
 * Bearer Assertion Signer — CP-CAP-009 PR #1 (ISCG rollout step 1).
 *
 * Mints `bearer_assertion_v1` envelopes against contractVersion 0.2.0.
 * Signs the 11-field canonical payload from
 * `docs/architecture/instance-scoped-capability-grants-v1.md` with the
 * bearer's instance Ed25519 private key.
 *
 * Preconditions (numbered against the signer's call-time checks; these
 * are NOT the verifier's 16 preconditions — those run on the receive
 * side. These check that the SIGNER refuses to mint a bad assertion):
 *
 *   S-PRE-1: feature flag `STRIX_INSTANCE_SCOPED_GRANTS_V1=true` (sign-time gate)
 *   S-PRE-2: all required fields present and non-empty
 *   S-PRE-3: `iat` and `exp` strict RFC 3339 (via `isStrictRfc3339Mirror`)
 *   S-PRE-4: `iat <= now + CLOCK_SKEW_TOLERANCE` (F-3; defends against future-iat exploit)
 *   S-PRE-5: `exp > iat` (basic ordering)
 *   S-PRE-6: `exp - iat <= MAX_TTL` (defends against unbounded freshness window)
 *   S-PRE-7: `nonce` length ≥ NONCE_MIN_BITS (F-2; defends against birthday collisions)
 *   S-PRE-8: `requestHash` matches `sha256:<64 hex>` shape
 *   S-PRE-9: signing key is Ed25519
 *
 * A single failed check throws `BearerAssertionSignerError` with a stable
 * `code` — the caller decides whether to retry, surface the failure, or
 * fall back to a principal-scoped path (when `grant.instanceId IS NULL`).
 *
 * **The signer does NOT verify** that `kid` corresponds to `privateKey`'s
 * public counterpart. That linkage is provisioning-side (the bearer
 * runtime is trusted to hold the private key it claims to hold); the
 * verifier-side check is precondition #15 (Ed25519 signature verify
 * against the attestation's stored JWK). If the signer's `kid` doesn't
 * actually correspond to its private key, the verifier rejects the
 * envelope at signature verify — which is the correct failure mode.
 *
 * **Flag-gated, no production callers yet.** The flag check returns a
 * stable error rather than silently succeeding so test harnesses can
 * assert the gate is in place.
 */

import {
  createPrivateKey,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

import { canonicalizeJSON } from "../actor-attestation/scj-v1-mirror.js";
import { isStrictRfc3339Mirror } from "../agents/loader.js";

import {
  BEARER_ASSERTION_CLOCK_SKEW_SECONDS_DEFAULT,
  BEARER_ASSERTION_CLOCK_SKEW_SECONDS_MAX,
  BEARER_ASSERTION_DEFAULT_TTL_SECONDS,
  BEARER_ASSERTION_FIELDS_V1,
  BEARER_ASSERTION_MAX_TTL_SECONDS,
  BEARER_ASSERTION_NONCE_MIN_BITS,
  type BearerAssertionPayload,
  type BearerAssertionSignedEnvelope,
  type IscgPrincipalType,
} from "./types.js";

// ─── Errors ─────────────────────────────────────────────────────────────────

export const BEARER_ASSERTION_SIGNER_ERRORS = {
  FEATURE_FLAG_OFF: "BEARER_ASSERTION_FEATURE_FLAG_OFF",
  FIELD_MISSING: "BEARER_ASSERTION_FIELD_MISSING",
  UNKNOWN_FIELD: "BEARER_ASSERTION_UNKNOWN_FIELD",
  TIMESTAMP_INVALID: "BEARER_ASSERTION_TIMESTAMP_INVALID",
  IAT_IN_FUTURE: "BEARER_ASSERTION_IAT_IN_FUTURE",
  ORDER_INVALID: "BEARER_ASSERTION_ORDER_INVALID",
  TTL_EXCEEDED: "BEARER_ASSERTION_TTL_EXCEEDED",
  NONCE_TOO_SHORT: "BEARER_ASSERTION_NONCE_TOO_SHORT",
  NONCE_NOT_BASE64URL: "BEARER_ASSERTION_NONCE_NOT_BASE64URL",
  REQUEST_HASH_SHAPE: "BEARER_ASSERTION_REQUEST_HASH_SHAPE",
  KEY_NOT_ED25519: "BEARER_ASSERTION_KEY_NOT_ED25519",
  KEY_NOT_PRIVATE: "BEARER_ASSERTION_KEY_NOT_PRIVATE",
  CLOCK_SKEW_OUT_OF_RANGE: "BEARER_ASSERTION_CLOCK_SKEW_OUT_OF_RANGE",
} as const;

export type BearerAssertionSignerErrorCode =
  (typeof BEARER_ASSERTION_SIGNER_ERRORS)[keyof typeof BEARER_ASSERTION_SIGNER_ERRORS];

export class BearerAssertionSignerError extends Error {
  readonly code: BearerAssertionSignerErrorCode;
  readonly field?: string;

  constructor(code: BearerAssertionSignerErrorCode, message: string, field?: string) {
    super(message);
    this.name = "BearerAssertionSignerError";
    this.code = code;
    this.field = field;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface SignBearerAssertionInput {
  /**
   * Ed25519 private key held by the bearer runtime. The signer does NOT
   * verify the public counterpart matches `payload.kid` — that linkage
   * is established by the operational-key attestation row written at
   * provisioning time and re-checked by the verifier (precondition #12).
   */
  privateKey: KeyObject;

  /** The 11-field canonical payload. Field set is validated; order is irrelevant (SCJ v1 sorts). */
  payload: BearerAssertionPayload;

  /**
   * Override the wall-clock "now" used for S-PRE-4 (future-iat bound).
   * Test-only; production calls leave undefined and the signer reads
   * `Date.now()`. The override is in seconds since epoch.
   */
  nowSeconds?: number;

  /**
   * Override `CLOCK_SKEW_TOLERANCE` (in seconds). Test/operator knob;
   * defaults to `BEARER_ASSERTION_CLOCK_SKEW_SECONDS_DEFAULT`. Hard
   * capped at `BEARER_ASSERTION_CLOCK_SKEW_SECONDS_MAX`.
   */
  clockSkewSeconds?: number;

  /**
   * Override the feature-flag check. Test-only — production callers
   * leave undefined and the gate reads `process.env`.
   */
  featureFlagOverride?: boolean;
}

export interface SignBearerAssertionResult {
  /** The signed envelope = payload + base64 Ed25519 signature. */
  envelope: BearerAssertionSignedEnvelope;

  /**
   * Wire value for the `X-Strix-Instance-Assertion` header:
   * `base64url(SCJ v1(payload)) + "." + base64url(signature)`. The
   * signature is over the canonical bytes; the wire form double-encodes
   * with base64url for HTTP-header safety.
   */
  wireValue: string;

  /**
   * The canonical SCJ v1 bytes that were signed. Exposed for tests and
   * for callers that want to log signature inputs for audit. Production
   * code rarely needs this.
   */
  canonicalBytes: Buffer;
}

/**
 * Mint a signed bearer assertion. Throws `BearerAssertionSignerError`
 * with a stable code on any precondition failure; does not log, retry,
 * or fall back.
 */
export function signBearerAssertion(input: SignBearerAssertionInput): SignBearerAssertionResult {
  // S-PRE-1: feature flag
  const flagOn =
    input.featureFlagOverride ??
    process.env.STRIX_INSTANCE_SCOPED_GRANTS_V1 === "true";
  if (!flagOn) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.FEATURE_FLAG_OFF,
      "Bearer assertion signing is gated on STRIX_INSTANCE_SCOPED_GRANTS_V1=true.",
    );
  }

  // S-PRE-9: key type — must be Ed25519 AND private. The `asymmetricKeyType`
  // check alone passes Ed25519 PUBLIC keys, which would then fail inside
  // `cryptoSign` with a raw TypeError instead of a stable signer error
  // (review comment P2 / r3254791173).
  if (input.privateKey.asymmetricKeyType !== "ed25519") {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.KEY_NOT_ED25519,
      `Bearer assertion signing requires an Ed25519 private key; got ${input.privateKey.asymmetricKeyType ?? "unknown"}.`,
    );
  }
  if (input.privateKey.type !== "private") {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.KEY_NOT_PRIVATE,
      `Bearer assertion signing requires a PRIVATE Ed25519 key; got type='${input.privateKey.type}'.`,
    );
  }

  // S-PRE-2: exact field set — reject any enumerable keys on the input
  // payload that aren't in the locked 11-field contract. Without this
  // check an untyped/casted input could smuggle extra keys into both
  // `canonicalizeJSON(p)` and the spread envelope, minting out-of-contract
  // assertions (review comment P1 / r3254791175).
  const rawPayload = input.payload as unknown as Record<string, unknown>;
  if (rawPayload === null || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.FIELD_MISSING,
      "payload must be a plain object.",
    );
  }
  const allowedFields = new Set<string>(BEARER_ASSERTION_FIELDS_V1);
  for (const key of Object.keys(rawPayload)) {
    if (!allowedFields.has(key)) {
      throw new BearerAssertionSignerError(
        BEARER_ASSERTION_SIGNER_ERRORS.UNKNOWN_FIELD,
        `Bearer assertion payload contains unknown field '${key}'. Only the 11 canonical fields at contract 0.2.0 are accepted.`,
        key,
      );
    }
  }

  // Build a clean projection — defense in depth. Even if the allowlist
  // check above is bypassed in the future, the canonicalizer never sees
  // anything outside the contract.
  const p: BearerAssertionPayload = {
    schemaVersion: input.payload.schemaVersion,
    kid: input.payload.kid,
    tenantId: input.payload.tenantId,
    environment: input.payload.environment,
    principalType: input.payload.principalType,
    principalId: input.payload.principalId,
    capability: input.payload.capability,
    requestHash: input.payload.requestHash,
    nonce: input.payload.nonce,
    iat: input.payload.iat,
    exp: input.payload.exp,
  };

  // S-PRE-2 (continued): field presence + shape on the projected fields.
  assertNonEmptyString(p.kid, "kid");
  assertNonEmptyString(p.tenantId, "tenantId");
  assertNonEmptyString(p.environment, "environment");
  assertPrincipalType(p.principalType);
  assertNonEmptyString(p.principalId, "principalId");
  assertNonEmptyString(p.capability, "capability");
  assertNonEmptyString(p.requestHash, "requestHash");
  assertNonEmptyString(p.nonce, "nonce");
  assertNonEmptyString(p.iat, "iat");
  assertNonEmptyString(p.exp, "exp");
  if (p.schemaVersion !== 1) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.FIELD_MISSING,
      "schemaVersion must equal 1 (the only locked value at contract 0.2.0).",
      "schemaVersion",
    );
  }

  // S-PRE-3: strict RFC 3339
  if (!isStrictRfc3339Mirror(p.iat)) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.TIMESTAMP_INVALID,
      "iat must be strict RFC 3339 (Z-suffixed, no offsets, microsecond precision max).",
      "iat",
    );
  }
  if (!isStrictRfc3339Mirror(p.exp)) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.TIMESTAMP_INVALID,
      "exp must be strict RFC 3339 (Z-suffixed, no offsets, microsecond precision max).",
      "exp",
    );
  }

  // S-PRE-4: iat <= now + CLOCK_SKEW_TOLERANCE
  const clockSkewSeconds = input.clockSkewSeconds ?? BEARER_ASSERTION_CLOCK_SKEW_SECONDS_DEFAULT;
  if (clockSkewSeconds < 0 || clockSkewSeconds > BEARER_ASSERTION_CLOCK_SKEW_SECONDS_MAX) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.CLOCK_SKEW_OUT_OF_RANGE,
      `clockSkewSeconds must be in [0, ${BEARER_ASSERTION_CLOCK_SKEW_SECONDS_MAX}]; got ${clockSkewSeconds}.`,
    );
  }
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const iatSeconds = Math.floor(Date.parse(p.iat) / 1000);
  const expSeconds = Math.floor(Date.parse(p.exp) / 1000);
  if (iatSeconds > nowSeconds + clockSkewSeconds) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.IAT_IN_FUTURE,
      `iat (${p.iat}) is more than CLOCK_SKEW_TOLERANCE (${clockSkewSeconds}s) in the future relative to now.`,
      "iat",
    );
  }

  // S-PRE-5: exp > iat
  if (expSeconds <= iatSeconds) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.ORDER_INVALID,
      `exp (${p.exp}) must be strictly after iat (${p.iat}).`,
    );
  }

  // S-PRE-6: exp - iat <= MAX_TTL
  const ttlSeconds = expSeconds - iatSeconds;
  if (ttlSeconds > BEARER_ASSERTION_MAX_TTL_SECONDS) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.TTL_EXCEEDED,
      `exp - iat = ${ttlSeconds}s exceeds the hard cap of ${BEARER_ASSERTION_MAX_TTL_SECONDS}s.`,
    );
  }

  // S-PRE-7: nonce entropy + encoding
  if (!isBase64UrlNoPadding(p.nonce)) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.NONCE_NOT_BASE64URL,
      "nonce must be base64url-encoded with no padding.",
      "nonce",
    );
  }
  const nonceBits = base64UrlBitLength(p.nonce);
  if (nonceBits < BEARER_ASSERTION_NONCE_MIN_BITS) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.NONCE_TOO_SHORT,
      `nonce must be at least ${BEARER_ASSERTION_NONCE_MIN_BITS} bits; got ${nonceBits}.`,
      "nonce",
    );
  }

  // S-PRE-8: requestHash shape
  if (!/^sha256:[0-9a-f]{64}$/.test(p.requestHash)) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.REQUEST_HASH_SHAPE,
      "requestHash must match shape 'sha256:<64 lowercase hex chars>'.",
      "requestHash",
    );
  }

  // ─── Sign ─────────────────────────────────────────────────────────────────
  const canonical = canonicalizeJSON(p);
  const canonicalBytes = Buffer.from(canonical, "utf8");
  const signature = cryptoSign(null, canonicalBytes, input.privateKey);

  const envelope: BearerAssertionSignedEnvelope = {
    ...p,
    signature: signature.toString("base64"),
  };

  const wireValue =
    canonicalBytes.toString("base64url") + "." + signature.toString("base64url");

  return { envelope, wireValue, canonicalBytes };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.FIELD_MISSING,
      `Required field '${field}' must be a non-empty string.`,
      field,
    );
  }
}

function assertPrincipalType(value: unknown): asserts value is IscgPrincipalType {
  if (value !== "OPERATOR" && value !== "AGENT" && value !== "SERVICE") {
    throw new BearerAssertionSignerError(
      BEARER_ASSERTION_SIGNER_ERRORS.FIELD_MISSING,
      "principalType must be one of 'OPERATOR' | 'AGENT' | 'SERVICE'.",
      "principalType",
    );
  }
}

function isBase64UrlNoPadding(s: string): boolean {
  // base64url alphabet, no padding; allow empty rejected by caller via length
  return /^[A-Za-z0-9_-]+$/.test(s);
}

function base64UrlBitLength(s: string): number {
  // Each base64url char encodes 6 bits. Padding stripped by the regex above.
  return s.length * 6;
}

/**
 * Re-export the canonicalizer for callers that need the byte-exact
 * payload for logging or external verification. Not the right surface
 * for general use — prefer `signBearerAssertion()` and read the
 * `canonicalBytes` from its result.
 */
export { canonicalizeJSON } from "../actor-attestation/scj-v1-mirror.js";

/**
 * Pure key-loader convenience for tests. Production should pass a
 * pre-constructed `KeyObject` to `signBearerAssertion`.
 */
export function loadEd25519PrivateKeyFromPkcs8Der(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}
