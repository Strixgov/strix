/**
 * Agent Bearer Assertion — AA-1 PR 1C.2 (plan §2.5 + §5.3)
 *
 * The bearer assertion is the credential an agent presents on the HTTP
 * `x-strix-agent-token` header. It is a JWS-compact envelope around a
 * 9-field SCJ v1 canonical payload, signed with the agent's own
 * Ed25519 private key. The auth middleware verifies it before stamping
 * `request.credentialClass = 'agent_token'` and populating actorId +
 * tenantId from the signed payload (NEVER from headers).
 *
 * Wire format (plan §5.3 — JWS-compact + SCJ v1 payload):
 *   <b64url(header)>.<b64url(scj_v1(payload))>.<b64url(signature)>
 *
 * Where:
 *   - header   = {"alg":"EdDSA","kid":<kid>,"typ":"strix-agent-token"}
 *                Envelope-only. The kid here is advisory; the trust-bearing
 *                kid is the one inside the signed payload.
 *   - payload  = 9 fields, locked order, SCJ v1 canonicalized:
 *
 *     ```
 *     schemaVersion          (1)
 *     assertionId            "asrt_..."
 *     kid                    "agent-<id>-<YYYY-MM>"   ← trust-bearing
 *     tenantId               string
 *     actorId                string
 *     claimedCredentialClass "agent_token" (locked for v1)
 *     issuedAt               RFC 3339 strict
 *     expiresAt              RFC 3339 strict          (≤ 5 min after issuedAt)
 *     nonce                  base64url 16-byte random ← replay defense
 *     ```
 *
 *   - signature = Ed25519 over `<b64url(header)>.<b64url(scj_v1(payload))>`
 *                 (JWS convention — sig covers the concatenation of the
 *                  encoded parts, NOT the raw payload bytes).
 *
 * Field order is load-bearing. Reordering invalidates every previously
 * signed assertion.
 *
 * **Wire-format note.** The signed payload is the SCJ-v1 canonical JSON,
 * which we then base64url-encode in the middle segment. We intentionally
 * do not put the SCJ canonical bytes directly on the wire (RFC 7515
 * mandates b64url for the JWS-compact form, and intermediaries may
 * mangle non-base64 in the middle segment). The SCJ canonicalization is
 * what makes the cryptographic identity deterministic; the b64url just
 * wraps it for transport.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalizeJSON } from "./scj-v1-mirror.js";
import { isStrictRfc3339Mirror } from "../agents/loader.js";
import type {
  AgentKeyRegistry,
  AgentPublicKeyJwk,
} from "../agents/registry.js";

// ─── Schema (9 fields, locked order — load-bearing) ─────────────────────────

export interface BearerAssertionPayload {
  schemaVersion: 1;
  assertionId: string;
  kid: string;
  tenantId: string;
  actorId: string;
  /** Locked at "agent_token" for v1. */
  claimedCredentialClass: "agent_token";
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface BearerAssertionHeader {
  alg: "EdDSA";
  kid: string;
  typ: "strix-agent-token";
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export const BEARER_ASSERTION_ERRORS = {
  MALFORMED: "BEARER_ASSERTION_MALFORMED",
  HEADER_INVALID: "BEARER_ASSERTION_HEADER_INVALID",
  PAYLOAD_INVALID: "BEARER_ASSERTION_PAYLOAD_INVALID",
  TIMESTAMP_INVALID: "BEARER_ASSERTION_TIMESTAMP_INVALID",
  EXPIRED: "BEARER_ASSERTION_EXPIRED",
  NOT_YET_VALID: "BEARER_ASSERTION_NOT_YET_VALID",
  KID_UNKNOWN: "BEARER_ASSERTION_KID_UNKNOWN",
  SIGNATURE_INVALID: "BEARER_ASSERTION_SIGNATURE_INVALID",
  CLAIM_MISMATCH: "BEARER_ASSERTION_CLAIM_MISMATCH",
  REPLAY: "BEARER_ASSERTION_REPLAY",
  NONCE_STORE_UNAVAILABLE: "BEARER_ASSERTION_NONCE_STORE_UNAVAILABLE",
} as const;

export type BearerAssertionErrorCode =
  (typeof BEARER_ASSERTION_ERRORS)[keyof typeof BEARER_ASSERTION_ERRORS];

export class BearerAssertionError extends Error {
  readonly code: BearerAssertionErrorCode;
  constructor(code: BearerAssertionErrorCode, detail?: string) {
    super(`${code}${detail ? ": " + detail : ""}`);
    this.code = code;
    this.name = "BearerAssertionError";
  }
}

// ─── Constants (plan §5.4) ──────────────────────────────────────────────────

/** 16 bytes (128 bits) of randomness, base64url-encoded (~22 chars). */
const NONCE_BYTES = 16;

/** Default TTL: 5 minutes (matches execution-token TTL). */
export const DEFAULT_TTL_SECONDS = 300;

/** Maximum allowed TTL — assertions valid > 5 min are not accepted. */
export const MAX_TTL_SECONDS = 300;

// ─── b64url helpers (no padding, per RFC 7515) ──────────────────────────────

function b64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return buf.toString("base64url");
}

function b64urlDecodeUtf8(s: string): string {
  return Buffer.from(s, "base64url").toString("utf-8");
}

function b64urlDecodeBytes(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

// ─── Nonce + assertionId generators (test-overridable) ──────────────────────

export interface BearerAssertionGeneratorOptions {
  /** Override for tests. */
  nonceSource?: () => string;
  /** Override for tests. */
  assertionIdSource?: () => string;
  /** Override for tests. */
  nowMs?: () => number;
}

function defaultNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

function defaultAssertionId(): string {
  // 16 random bytes → 22-char base64url. Prefixed `asrt_` for sortability /
  // log grep — same convention as `att_` / `evi_` in the architecture doc.
  return "asrt_" + randomBytes(16).toString("base64url");
}

// ─── Signer ─────────────────────────────────────────────────────────────────

export interface SignAgentBearerAssertionInput {
  kid: string;
  tenantId: string;
  actorId: string;
  /** Agent's Ed25519 private key. NEVER the platform key (plan §2.4). */
  privateKey: KeyObject;
  /** TTL in seconds. Default + max are both 300 (5 min). */
  ttlSeconds?: number;
}

export interface SignedBearerAssertion {
  /** JWS-compact wire form (`header.payload.sig`). */
  token: string;
  /** Parsed payload — handy for callers that need to persist `nonce` etc. */
  payload: BearerAssertionPayload;
}

/**
 * Sign a new bearer assertion. Caller supplies the agent's private key;
 * the SDK never reads keys from disk or env.
 *
 * Throws on invalid inputs (TTL out of range, malformed identifiers).
 */
export function signAgentBearerAssertion(
  input: SignAgentBearerAssertionInput,
  options: BearerAssertionGeneratorOptions = {},
): SignedBearerAssertion {
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.PAYLOAD_INVALID,
      `ttlSeconds out of range: ${ttl} (must be 1..${MAX_TTL_SECONDS})`,
    );
  }
  if (!input.kid || !input.tenantId || !input.actorId) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.PAYLOAD_INVALID,
      "kid, tenantId, actorId are all required",
    );
  }

  const now = options.nowMs ? options.nowMs() : Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttl * 1000).toISOString();

  // ISO-string round-trip — the result is strict RFC 3339 because Date
  // .toISOString() always emits the `YYYY-MM-DDTHH:MM:SS(.sss)Z` form.
  // Belt-and-suspenders: verify strict-RFC3339 before signing so a
  // future Node behavior change can't poison the signature.
  if (!isStrictRfc3339Mirror(issuedAt) || !isStrictRfc3339Mirror(expiresAt)) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.TIMESTAMP_INVALID,
      "Date.toISOString() produced non-strict-RFC3339 (host runtime regression?)",
    );
  }

  const payload: BearerAssertionPayload = {
    schemaVersion: 1,
    assertionId: options.assertionIdSource
      ? options.assertionIdSource()
      : defaultAssertionId(),
    kid: input.kid,
    tenantId: input.tenantId,
    actorId: input.actorId,
    claimedCredentialClass: "agent_token",
    issuedAt,
    expiresAt,
    nonce: options.nonceSource ? options.nonceSource() : defaultNonce(),
  };

  const header: BearerAssertionHeader = {
    alg: "EdDSA",
    kid: input.kid,
    typ: "strix-agent-token",
  };

  // Payload is SCJ v1 canonicalized THEN base64url-encoded. The
  // canonicalization is the trust-bearing part; b64url is transport only.
  const canonicalPayload = canonicalizeJSON(payload);
  const headerB64 = b64urlEncode(canonicalizeJSON(header));
  const payloadB64 = b64urlEncode(canonicalPayload);

  // JWS-compact: signature covers `<headerB64>.<payloadB64>`.
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = cryptoSign(null, Buffer.from(signingInput, "utf-8"), input.privateKey);
  const sigB64 = b64urlEncode(sig);

  return {
    token: `${headerB64}.${payloadB64}.${sigB64}`,
    payload,
  };
}

// ─── Verifier ───────────────────────────────────────────────────────────────

/**
 * Replay-store contract. The auth middleware injects a real implementation
 * backed by Postgres (`agent_bearer_nonces`). Tests inject an in-memory
 * stub. Insert-or-throw on collision — never an upsert.
 */
export interface NonceStore {
  /**
   * Insert (tenantId, nonce) atomically.
   * - Success: returns void.
   * - Collision: throws (any error — caller treats as replay).
   * - Backend unavailable: throws — caller treats as
   *   `NONCE_STORE_UNAVAILABLE` (fail-closed; never silently let a
   *   potential replay through).
   */
  insertOrThrow(input: {
    tenantId: string;
    nonce: string;
    kid: string;
    expiresAt: string;
  }): Promise<void>;
}

export interface VerifyAgentBearerAssertionOptions {
  token: string;
  registry: AgentKeyRegistry;
  nonceStore: NonceStore;
  /** Override for tests. */
  nowMs?: () => number;
}

export interface VerifiedBearerAssertion {
  payload: BearerAssertionPayload;
  /** Echo of the resolved registry entry's agentId — convenient for downstream. */
  resolvedAgentId: string;
}

/**
 * Verify a bearer assertion. Returns the parsed payload on success, throws
 * `BearerAssertionError` with a stable code on any rejection.
 *
 * Verification flow (plan §2.5 steps 2–9; step 1 = "Parse" is the parse
 * block at the top of this function; step 5 chain verification happens
 * at registry-load time, not here):
 *
 *   2. Extract kid from the signed payload (NOT the transport header).
 *   3. Resolve kid against registry.
 *   4. Verify Ed25519 signature.
 *   6. Strict-RFC3339 + clock-skew checks.
 *   7. Nonce replay check (insert-or-throw).
 *   8. claimedCredentialClass === 'agent_token'.
 *   9. (caller) populate request.credentialClass / actorId / tenantId
 *      from the signed payload.
 */
export async function verifyAgentBearerAssertion(
  opts: VerifyAgentBearerAssertionOptions,
): Promise<VerifiedBearerAssertion> {
  const { token, registry, nonceStore } = opts;
  const now = opts.nowMs ? opts.nowMs() : Date.now();

  // Step 1 — Parse JWS-compact envelope.
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.MALFORMED,
      "expected three b64url segments separated by '.'",
    );
  }
  const [headerB64, payloadB64, sigB64] = parts;

  let header: BearerAssertionHeader;
  let payload: BearerAssertionPayload;
  try {
    header = JSON.parse(b64urlDecodeUtf8(headerB64)) as BearerAssertionHeader;
    payload = JSON.parse(b64urlDecodeUtf8(payloadB64)) as BearerAssertionPayload;
  } catch (e) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.MALFORMED,
      e instanceof Error ? e.message : String(e),
    );
  }

  // Header validation — alg + typ pinned. kid is advisory; we re-check
  // against the payload below.
  if (header.alg !== "EdDSA" || header.typ !== "strix-agent-token") {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.HEADER_INVALID,
      `header.alg=${header.alg} header.typ=${header.typ}`,
    );
  }

  // Payload shape validation — schemaVersion + locked claim.
  if (payload.schemaVersion !== 1) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.PAYLOAD_INVALID,
      `unsupported schemaVersion=${payload.schemaVersion}`,
    );
  }
  if (payload.claimedCredentialClass !== "agent_token") {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.CLAIM_MISMATCH,
      `claimedCredentialClass=${payload.claimedCredentialClass} ` +
        `(v1 locked at "agent_token")`,
    );
  }
  if (
    !payload.assertionId ||
    !payload.kid ||
    !payload.tenantId ||
    !payload.actorId ||
    !payload.nonce
  ) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.PAYLOAD_INVALID,
      "missing required field",
    );
  }

  // Step 2 — Extract kid from signed payload (NOT header).
  const trustKid = payload.kid;

  // Step 6 (early — cheap timestamp check before we spend cycles on
  // signature verify, but AFTER the kid is extracted so the replay-store
  // path always sees a consistent flow). Strict RFC3339 required.
  if (
    !isStrictRfc3339Mirror(payload.issuedAt) ||
    !isStrictRfc3339Mirror(payload.expiresAt)
  ) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.TIMESTAMP_INVALID,
      `issuedAt=${payload.issuedAt} expiresAt=${payload.expiresAt}`,
    );
  }
  const issuedMs = Date.parse(payload.issuedAt);
  const expiresMs = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.TIMESTAMP_INVALID,
      "non-finite timestamp",
    );
  }
  if (expiresMs - issuedMs > MAX_TTL_SECONDS * 1000) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.TIMESTAMP_INVALID,
      `TTL exceeds ${MAX_TTL_SECONDS}s`,
    );
  }
  // Small clock-skew tolerance (60s) at the not-yet-valid edge.
  if (issuedMs - now > 60_000) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.NOT_YET_VALID,
      `issuedAt=${payload.issuedAt} now=${new Date(now).toISOString()}`,
    );
  }
  if (now >= expiresMs) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.EXPIRED,
      `expiresAt=${payload.expiresAt} now=${new Date(now).toISOString()}`,
    );
  }

  // Step 3 — Resolve kid against registry.
  const entry = registry.resolveByKid(trustKid);
  if (entry === null) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.KID_UNKNOWN,
      trustKid,
    );
  }

  // Step 4 — Verify Ed25519 signature. We rebuild the canonical signing
  // input from the *received* base64url segments. We then sanity-check
  // that decoding+canonicalizing the payload produces the same bytes —
  // a sender that ships a non-canonical inner payload will produce a
  // valid signature against the on-wire bytes but a divergent canonical
  // form, which we treat as malformed (CJ-1 discipline).
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBytes = b64urlDecodeBytes(sigB64);
  let publicKey: KeyObject;
  try {
    publicKey = jwkToPublicKey(entry.publicKeyJwk);
  } catch (e) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.KID_UNKNOWN,
      `cannot reconstruct public key for kid ${trustKid}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  const sigOk = cryptoVerify(
    null,
    Buffer.from(signingInput, "utf-8"),
    publicKey,
    sigBytes,
  );
  if (!sigOk) {
    throw new BearerAssertionError(BEARER_ASSERTION_ERRORS.SIGNATURE_INVALID);
  }

  // Canonical-bytes parity check (CJ-1). The on-wire `payloadB64` must
  // decode to the SCJ-canonical form of the parsed `payload`. If a
  // sender ships extra whitespace or unsorted keys inside the signed
  // segment, the signature will still verify (because we sign the
  // exact b64url bytes), but downstream verifiers reconstructing the
  // canonical hash from the parsed payload would compute a different
  // value. We reject here to keep the canonical-form invariant intact.
  const expectedCanonical = canonicalizeJSON(payload);
  const decodedPayload = b64urlDecodeUtf8(payloadB64);
  if (decodedPayload !== expectedCanonical) {
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.MALFORMED,
      "payload segment is not SCJ v1 canonical",
    );
  }

  // Step 7 — Nonce replay check. Insert-or-throw on collision. Backend
  // errors are fail-closed (NONCE_STORE_UNAVAILABLE) — never let a
  // potential replay through because the store is unreachable.
  try {
    await nonceStore.insertOrThrow({
      tenantId: payload.tenantId,
      nonce: payload.nonce,
      kid: trustKid,
      expiresAt: payload.expiresAt,
    });
  } catch (e) {
    // Distinguish collision from backend failure by error name when the
    // store implements `NonceStoreUnavailableError`. Without that signal,
    // we default to REPLAY (the safer interpretation — a legitimate caller
    // can retry with a fresh nonce).
    const errName =
      e !== null && typeof e === "object" && typeof (e as { name?: unknown }).name === "string"
        ? (e as { name: string }).name
        : "";
    if (errName === "NonceStoreUnavailableError") {
      throw new BearerAssertionError(
        BEARER_ASSERTION_ERRORS.NONCE_STORE_UNAVAILABLE,
        e instanceof Error ? e.message : String(e),
      );
    }
    throw new BearerAssertionError(
      BEARER_ASSERTION_ERRORS.REPLAY,
      e instanceof Error ? e.message : String(e),
    );
  }

  // Step 8 — claimedCredentialClass check (already done above for shape;
  // re-statement for clarity in the flow comment).

  // Step 9 (caller) — caller populates request.credentialClass etc. from
  // the returned payload.

  return {
    payload,
    resolvedAgentId: entry.agentId,
  };
}

// ─── JWK → KeyObject ────────────────────────────────────────────────────────

function jwkToPublicKey(jwk: AgentPublicKeyJwk): KeyObject {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("not an Ed25519 OKP JWK");
  }
  // node:crypto accepts JsonWebKey via JsonWebKeyInput shape.
  return createPublicKey({
    key: jwk as unknown as import("node:crypto").JsonWebKey,
    format: "jwk",
  });
}

// ─── Hash helper exposed for tests ──────────────────────────────────────────

/**
 * SHA-256 hex of SCJ v1 canonicalization. Used by the signer to compute
 * the `canonical_payload_hash` column on `actor_attestations`. Public so
 * tests can pin the byte-form.
 */
export function sha256HexOfCanonical(value: unknown): string {
  const canonical = canonicalizeJSON(value);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

// ─── Re-exports for convenience ─────────────────────────────────────────────

export { canonicalizeJSON } from "./scj-v1-mirror.js";
export {
  createPrivateKey as nodeCreatePrivateKey,
  createPublicKey as nodeCreatePublicKey,
};
