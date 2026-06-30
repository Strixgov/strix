/**
 * @strixgov/mcp-token-validator
 *
 * Independent validator for Strix `execution_authorization_v1` tokens.
 * Drop into any downstream MCP server, network proxy, or
 * credential-broker wrap to enforce Mode 3 — Capability-Enforced —
 * governance per `docs/strategy/mcp-mode-ladder-v1.md` and
 * `docs/architecture/mcp-mode-3-enforcement-v1.md`.
 *
 * Zero Strix runtime dependency: uses only `node:crypto` plus the
 * vendored SCJ v1 and strict-RFC3339 modules. No HTTP. No network.
 * The trust path is the public JWKS the caller passes in.
 *
 * ## Quickstart (Posture C — first-party MCP)
 *
 *   import { validateAuthorization } from "@strixgov/mcp-token-validator";
 *
 *   async function handleNotionUpdatePage(request) {
 *     const token = request.params._meta?.strix_authorization;
 *     const result = await validateAuthorization(token, {
 *       jwks,
 *       expectedTenantId: "acme-corp",
 *       expectedEnvironment: "prod",
 *       burnNonce: async (n) => {
 *         // Atomic single-use enforcement. UNIQUE INSERT against a
 *         // burned-nonces table; succeed → true, conflict → false.
 *         try {
 *           await db.run("INSERT INTO strix_burned_nonces(nonce) VALUES(?)", [n]);
 *           return true;
 *         } catch (e) {
 *           return e.code === "SQLITE_CONSTRAINT_UNIQUE" ? false : (() => { throw e; })();
 *         }
 *       },
 *     });
 *     if (!result.ok) throw new Error(`STRIX_AUTHORIZATION_INVALID: ${result.reason}`);
 *     return await reallyUpdatePage(request.params);
 *   }
 *
 * ## Quickstart (Posture B — proxy header)
 *
 *   import { validateAuthorizationFromHeader } from "@strixgov/mcp-token-validator";
 *
 *   server.use(async (req, res, next) => {
 *     const result = await validateAuthorizationFromHeader(
 *       req.headers["strix-execution-authorization"],
 *       { jwks, burnNonce, expectedTenantId, expectedEnvironment },
 *     );
 *     if (!result.ok) {
 *       res.statusCode = 401;
 *       res.setHeader("WWW-Authenticate", `Strix reason="${result.reason}"`);
 *       return res.end();
 *     }
 *     next();
 *   });
 *
 * ## Fail-closed
 *
 * Every error path returns `{ ok: false, reason: <stable-string> }`.
 * If `burnNonce` throws, the validator returns NONCE_REUSED. There is
 * no "couldn't check, so allowed" path. There is no "validator threw,
 * so allowed" path.
 *
 * ## What v0.1.0 does NOT yet check
 *
 * Two rules from `mcp-mode-3-enforcement-v1.md §8` are explicitly
 * deferred to v0.2.0:
 *   - KEY_NOT_ATTESTED (operational-key attestation chain to a pinned
 *     root via OB-1)
 *   - KEY_REVOKED (signed-revocation-list check)
 *
 * In v0.1.0 the JWKS the caller passes in IS the trust boundary. If
 * the JWKS comes from a Strix-curated source (e.g. `well-known.strixgov.com`),
 * attestation and revocation are enforced upstream by Strix removing
 * unattested / revoked keys from the JWKS. If the caller self-hosts
 * the JWKS, the caller manages that curation. v0.2.0 will add
 * pluggable `isKeyAttested` and `isKeyRevoked` callbacks so callers
 * can layer additional trust-root enforcement on top.
 */

import crypto from "node:crypto";

import { canonicalizeJSON, sha256OfJSON } from "./canonical-json.mjs";
import { isStrictRfc3339, parseStrictRfc3339 } from "./rfc3339.mjs";

export { canonicalizeJSON, sha256OfJSON };

/** The locked 11-field order from arch spec §4. Reordering breaks every previously-signed token. */
const AUTHORIZATION_FIELD_ORDER = Object.freeze([
  "schemaVersion",
  "authorizationId",
  "decisionId",
  "capabilityId",
  "actorId",
  "actorClass",
  "payloadHash",
  "tenantId",
  "environment",
  "nonce",
  "issuedAt",
  "expiresAt",
]);

const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);

/** Stable reason strings. Adding is additive; renaming/removing is a breaking change. */
export const VALIDATION_REASONS = Object.freeze({
  TOKEN_MALFORMED: "TOKEN_MALFORMED",
  CANONICALIZATION_DRIFT: "CANONICALIZATION_DRIFT",
  SCHEMA_VERSION_UNSUPPORTED: "SCHEMA_VERSION_UNSUPPORTED",
  KEY_NOT_FOUND: "KEY_NOT_FOUND",
  KEY_NOT_ATTESTED: "KEY_NOT_ATTESTED", // reserved for v0.2.0
  KEY_REVOKED: "KEY_REVOKED",            // reserved for v0.2.0
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  EXPIRED: "EXPIRED",
  TENANT_MISMATCH: "TENANT_MISMATCH",
  ENVIRONMENT_MISMATCH: "ENVIRONMENT_MISMATCH",
  ACTOR_CLASS_MISMATCH: "ACTOR_CLASS_MISMATCH",
  NONCE_REUSED: "NONCE_REUSED",
});

/**
 * Validate an `execution_authorization_v1` token presented as a parsed
 * object (Postures A and C — credential-broker / first-party MCP).
 *
 * @param {object} token  The token object — must be the full 11-field shape
 *                        from arch spec §4 plus the top-level `signingKeyId`
 *                        and `signature` envelope fields.
 * @param {{
 *   jwks: { keys: Array<object> },
 *   expectedTenantId?: string,
 *   expectedEnvironment?: string,
 *   expectedActorClass?: string,
 *   burnNonce: (nonce: string) => Promise<boolean>,
 *   now?: () => number,
 * }} opts
 * @returns {Promise<
 *   | { ok: true,  authorizationId: string, actorId: string, capabilityId: string, payloadHash: string, expiresAt: string }
 *   | { ok: false, reason: string, error?: string }
 * >}
 */
export async function validateAuthorization(token, opts) {
  if (!opts || typeof opts !== "object") {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, "opts is required");
  }
  if (!opts.jwks || !Array.isArray(opts.jwks.keys)) {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, "opts.jwks.keys is required");
  }
  if (typeof opts.burnNonce !== "function") {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, "opts.burnNonce is required");
  }

  // Rule 1 — Token parses + canonical reserialization byte-equals the input shape.
  // (For object-form input we canonicalize the 11-field payload and use it both
  // for the signature check and as the structural shape gate.)
  const payload = extractPayload(token);
  if (!payload) {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, "missing or malformed payload fields");
  }
  let canonical;
  try {
    canonical = canonicalizeJSON(payload);
  } catch (err) {
    return fail(VALIDATION_REASONS.CANONICALIZATION_DRIFT, String(err?.message ?? err));
  }

  // Rule 2 — Schema version supported.
  if (!SUPPORTED_SCHEMA_VERSIONS.has(payload.schemaVersion)) {
    return fail(
      VALIDATION_REASONS.SCHEMA_VERSION_UNSUPPORTED,
      `schemaVersion ${JSON.stringify(payload.schemaVersion)} not in {${[...SUPPORTED_SCHEMA_VERSIONS].join(",")}}`,
    );
  }

  // Rule 3 — signingKeyId resolves to a JWK in the provided JWKS.
  const signingKeyId = typeof token.signingKeyId === "string" ? token.signingKeyId : null;
  if (!signingKeyId) {
    return fail(VALIDATION_REASONS.KEY_NOT_FOUND, "token.signingKeyId missing");
  }
  const jwk = opts.jwks.keys.find((k) => k && k.kid === signingKeyId);
  if (!jwk) {
    return fail(VALIDATION_REASONS.KEY_NOT_FOUND, `kid '${signingKeyId}' not in JWKS`);
  }

  // Rules 4 + 5 are explicitly deferred to v0.2.0 (see file header).

  // Rule 6 — Ed25519 signature over canonical payload validates.
  const publicKey = jwkToPublicKey(jwk);
  if (!publicKey) {
    return fail(VALIDATION_REASONS.SIGNATURE_INVALID, "JWK is not Ed25519 OKP shape");
  }
  const signatureRaw = typeof token.signature === "string" ? token.signature : null;
  if (!signatureRaw) {
    return fail(VALIDATION_REASONS.SIGNATURE_INVALID, "token.signature missing");
  }
  let sigBytes;
  try {
    sigBytes = Buffer.from(signatureRaw, "base64url");
  } catch {
    return fail(VALIDATION_REASONS.SIGNATURE_INVALID, "signature is not base64url");
  }
  const sigOk = crypto.verify(null, Buffer.from(canonical, "utf-8"), publicKey, sigBytes);
  if (!sigOk) {
    return fail(VALIDATION_REASONS.SIGNATURE_INVALID, "Ed25519 verify returned false");
  }

  // Rule 7 — Not expired. Strict RFC 3339 only.
  if (!isStrictRfc3339(payload.issuedAt)) {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, "issuedAt is not strict RFC 3339");
  }
  if (!isStrictRfc3339(payload.expiresAt)) {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, "expiresAt is not strict RFC 3339");
  }
  const expiresAtMs = parseStrictRfc3339(payload.expiresAt);
  const issuedAtMs = parseStrictRfc3339(payload.issuedAt);
  if (expiresAtMs <= issuedAtMs) {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, "expiresAt must be after issuedAt");
  }
  const now = typeof opts.now === "function" ? opts.now() : Date.now();
  if (now >= expiresAtMs) {
    return fail(VALIDATION_REASONS.EXPIRED, `now=${now} expiresAt=${expiresAtMs}`);
  }

  // Rule 8 — Tenant binding (optional).
  if (opts.expectedTenantId !== undefined && opts.expectedTenantId !== payload.tenantId) {
    return fail(
      VALIDATION_REASONS.TENANT_MISMATCH,
      `expected '${opts.expectedTenantId}' got '${payload.tenantId}'`,
    );
  }

  // Rule 9 — Environment binding (optional).
  if (opts.expectedEnvironment !== undefined && opts.expectedEnvironment !== payload.environment) {
    return fail(
      VALIDATION_REASONS.ENVIRONMENT_MISMATCH,
      `expected '${opts.expectedEnvironment}' got '${payload.environment}'`,
    );
  }

  // Rule 9b — Actor-class binding (optional; not in the original 12 reasons but spec §8 reason
  // ACTOR_CLASS_MISMATCH is reserved — surfaced here when callers ask).
  if (opts.expectedActorClass !== undefined && opts.expectedActorClass !== payload.actorClass) {
    return fail(
      VALIDATION_REASONS.ACTOR_CLASS_MISMATCH,
      `expected '${opts.expectedActorClass}' got '${payload.actorClass}'`,
    );
  }

  // Rule 10 — Burn the nonce LAST. Order matters per spec §8: a token that fails an earlier
  // rule MUST NOT burn its nonce, otherwise we'd convert "good token, already used" into the
  // same outcome as "never a good token", and audit loses the distinction.
  let burned;
  try {
    burned = await opts.burnNonce(payload.nonce);
  } catch (err) {
    // Fail-closed on any burnNonce error.
    return fail(VALIDATION_REASONS.NONCE_REUSED, `burnNonce threw: ${String(err?.message ?? err)}`);
  }
  if (burned !== true) {
    return fail(VALIDATION_REASONS.NONCE_REUSED, "burnNonce returned non-true");
  }

  return {
    ok: true,
    authorizationId: payload.authorizationId,
    actorId: payload.actorId,
    capabilityId: payload.capabilityId,
    payloadHash: payload.payloadHash,
    expiresAt: payload.expiresAt,
  };
}

/**
 * Validate a token transported as the `Strix-Execution-Authorization`
 * HTTP header (Posture B — proxy).
 *
 * Wire format (spec §6.2):
 *   <base64url(canonical-json-payload)>.<base64url(signature)>
 *
 * Note: the header form does NOT carry `signingKeyId` outside the
 * payload. The payload IS canonical JSON and includes `signingKeyId`
 * as one of its fields when produced from the object form's envelope.
 * Header-form tokens must include `signingKeyId` inside the canonical
 * payload (signer's responsibility); this validator surfaces a
 * KEY_NOT_FOUND if it's missing.
 */
export async function validateAuthorizationFromHeader(headerValue, opts) {
  if (typeof headerValue !== "string" || !headerValue) {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, "header value missing or non-string");
  }
  const dotIdx = headerValue.indexOf(".");
  if (dotIdx < 1 || dotIdx === headerValue.length - 1) {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, "header must be <payload>.<signature>");
  }
  const payloadB64 = headerValue.slice(0, dotIdx);
  const signatureB64 = headerValue.slice(dotIdx + 1);

  let payloadJson;
  try {
    payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
  } catch {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, "payload segment is not base64url");
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    return fail(VALIDATION_REASONS.TOKEN_MALFORMED, `payload is not JSON: ${err?.message}`);
  }

  // Critical: assert the parsed-then-canonicalized payload byte-equals the on-wire payload.
  // Otherwise an attacker could submit semantically-equal JSON with different bytes and the
  // signature would verify against a payload the validator never compared against.
  let canonical;
  try {
    canonical = canonicalizeJSON(payload);
  } catch (err) {
    return fail(VALIDATION_REASONS.CANONICALIZATION_DRIFT, String(err?.message ?? err));
  }
  if (canonical !== payloadJson) {
    return fail(
      VALIDATION_REASONS.CANONICALIZATION_DRIFT,
      "on-wire payload bytes do not match SCJ v1 reserialization",
    );
  }

  // Re-build the object-form token shape and delegate to validateAuthorization.
  // The on-wire payload embeds signingKeyId; we lift it out so the object-form
  // envelope matches what mcp-adapter would have produced internally.
  const signingKeyId = payload.signingKeyId;
  const innerPayload = { ...payload };
  delete innerPayload.signingKeyId;
  return validateAuthorization(
    { ...innerPayload, signingKeyId, signature: signatureB64 },
    opts,
  );
}

// ── internal ─────────────────────────────────────────────────────────

function fail(reason, error) {
  return { ok: false, reason, error };
}

function extractPayload(token) {
  if (!token || typeof token !== "object") return null;
  const out = {};
  for (const field of AUTHORIZATION_FIELD_ORDER) {
    if (token[field] === undefined || token[field] === null) return null;
    out[field] = token[field];
  }
  return out;
}

function jwkToPublicKey(jwk) {
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    return null;
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) return null;
  // Ed25519 public key SPKI wrapping: fixed 12-byte prefix + 32-byte raw key.
  const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
  const spki = Buffer.concat([spkiHeader, raw]);
  try {
    return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    return null;
  }
}
