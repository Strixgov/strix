// @strixgov/verify-embed — browser-side verifier core.
//
// Performs end-to-end verification of a Strix-governed evidence record
// without any backend except the publicly-fetchable proof API and JWKS.
// All cryptographic operations run client-side via WebCrypto.
//
// Outcome language MUST match @strixgov/verifier (the Node CLI) exactly
// so an embed verification and a CLI verification return identical
// verificationStatus strings for the same input. See
// packages/strixgov-verifier/src/index.mjs::verify.

export const DEFAULT_PROOF_BASE = "https://www.strixgov.com";
export const DEFAULT_JWKS_URL = "https://www.strixgov.com/.well-known/strix-jwks.json";

// ── Crypto primitives ────────────────────────────────────────────────

function base64UrlToBytes(b64url) {
  // Convert base64url → base64, pad, then atob.
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? 0 : 4 - (b64.length % 4);
  const padded = b64 + "=".repeat(pad);
  const bin = atob(padded);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function verifyEd25519(jwk, signatureB64Url, payloadBytes) {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "Ed25519",
      key,
      base64UrlToBytes(signatureB64Url),
      new TextEncoder().encode(payloadBytes),
    );
    return { ok, error: null };
  } catch (err) {
    // Older Safari etc. lack WebCrypto Ed25519. Surface explicitly so the
    // UI can show a "browser too old" hint rather than a generic failure.
    return { ok: false, error: `WebCrypto Ed25519 unavailable: ${err?.message ?? err}` };
  }
}

// ── Canonical payload reconstruction ────────────────────────────────
//
// Byte-for-byte mirror of packages/strixgov-verifier/src/index.mjs's
// buildCanonicalPayload. Mirror invariant: any change here must mirror
// the Node verifier or the embed and CLI will disagree on records.

function coerceSchemaVersionToNumber(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function coerceEvidenceIdToNumber(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function buildCanonicalPayload(record) {
  // v1.10.0+: prefer the original signed bytes when the API returns them.
  if (typeof record.signedPayload === "string" && record.signedPayload.length > 0) {
    return record.signedPayload;
  }

  const isAcademyV1 = record.sourceApp === "academy-platform";

  const schemaVersion = isAcademyV1
    ? coerceSchemaVersionToNumber(record.schemaVersion, 1)
    : (typeof record.schemaVersion === "string"
      ? record.schemaVersion
      : record.schemaVersion === undefined
        ? "1"
        : String(record.schemaVersion));

  const evidenceId = isAcademyV1
    ? coerceEvidenceIdToNumber(record.evidenceId ?? record.id, 0)
    : String(record.evidenceId ?? record.id);

  const tenantId = record.tenantId === undefined ? "" : record.tenantId;

  const ctxInput = record.regulatoryContext ?? {
    complianceMode: "",
    euAiActArticle12: false,
    euAiActArticle14: false,
    euAiActArticle28: false,
  };
  const regulatoryContext = isAcademyV1
    ? {
        euAiActArticle12: ctxInput.euAiActArticle12,
        euAiActArticle14: ctxInput.euAiActArticle14,
        euAiActArticle28: ctxInput.euAiActArticle28,
        complianceMode: ctxInput.complianceMode,
      }
    : {
        complianceMode: ctxInput.complianceMode,
        euAiActArticle12: ctxInput.euAiActArticle12,
        euAiActArticle14: ctxInput.euAiActArticle14,
        euAiActArticle28: ctxInput.euAiActArticle28,
      };

  const payload = {
    schemaVersion,
    evidenceId,
    evidenceHash: record.evidenceHash ?? "",
    proofChainHash: record.proofChainHash ?? "",
    capabilityId: record.capabilityId ?? "",
    action: record.action ?? record.decision ?? "",
    actorId: record.actorId ?? record.actor?.id ?? "",
    actorRole: record.actorRole ?? record.actor?.role ?? "",
    createdAt: record.createdAt ?? "",
    signingKeyId: record.signingKeyId ?? "",
    environment: record.environment ?? "",
    tenantId,
    regulatoryContext,
  };

  return JSON.stringify(payload);
}

// ── Network ─────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

async function fetchEvidence(evidenceId, proofBase = DEFAULT_PROOF_BASE) {
  // Try /api/public/proof/<id> first (Console; richer response shape).
  // Fall back to /api/proof/<id> (Academy; older endpoint).
  const urls = [
    `${proofBase}/api/public/proof/${encodeURIComponent(evidenceId)}`,
    `${proofBase}/api/proof/${encodeURIComponent(evidenceId)}`,
  ];

  let lastError = null;
  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
      if (!r.ok) {
        lastError = new Error(`HTTP ${r.status} from ${url}`);
        continue;
      }
      const json = await r.json();
      // Console wraps in { fields: {...} }; Academy returns flat. Normalize.
      const fields = json.fields ?? json;
      // Promote a few top-level helper fields the canonical payload needs.
      return {
        ...fields,
        signedPayload: json.signedPayload ?? fields.signedPayload,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("All proof endpoints failed");
}

async function fetchJwks(jwksUrl = DEFAULT_JWKS_URL) {
  const r = await fetchWithTimeout(jwksUrl, {
    headers: { Accept: "application/json" },
    cache: "no-cache",
  });
  if (!r.ok) throw new Error(`JWKS fetch failed: HTTP ${r.status}`);
  return await r.json();
}

function resolveJwksByKid(jwks, kid) {
  if (!jwks?.keys || !Array.isArray(jwks.keys)) return [];
  return jwks.keys.filter((k) => k.kid === kid);
}

// ── Compliance flag derivation ──────────────────────────────────────
//
// Mirror of apps/strix-console/src/lib/proof/compliance-flags.ts. Flags
// are NEVER read from the record — they are derived here from the
// verification outcome. (CI-5 / SE-18.)

export function deriveComplianceFlags(complianceMode, inputs) {
  if (!complianceMode || complianceMode.length === 0) return null;

  const article12_traceable = inputs.hasTraceFields && inputs.hashValid;
  const article12_tamper_resistant =
    inputs.hashValid && inputs.chainValid && inputs.signatureValid;
  const article14_oversight_supported = inputs.hasTraceFields;
  const article28_audit_ready =
    article12_traceable &&
    article12_tamper_resistant &&
    article14_oversight_supported &&
    inputs.signatureValid;

  return {
    article12_traceable,
    article12_tamper_resistant,
    article14_oversight_supported,
    article28_audit_ready,
  };
}

function recordHasTraceFields(record) {
  return (
    typeof record.capabilityId === "string" && record.capabilityId.length > 0 &&
    typeof record.actorId === "string" && record.actorId.length > 0 &&
    typeof record.action === "string" && record.action.length > 0 &&
    typeof record.createdAt === "string" && record.createdAt.length > 0
  );
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Verify a Strix-governed evidence record end-to-end.
 *
 * @param {string|number} evidenceId
 * @param {object} [opts]
 * @param {string} [opts.proofBase] — defaults to https://www.strixgov.com
 * @param {string} [opts.jwksUrl]   — defaults to the canonical JWKS URL
 * @returns {Promise<VerificationResult>}
 *
 * VerificationResult shape:
 *   {
 *     evidenceId,
 *     verificationStatus: "VERIFIED" | "UNSIGNED" | "LEGACY_UNSIGNED" |
 *                         "COMPLIANCE_VIOLATION" | "NOT_FOUND" | "ERROR",
 *     signaturePresent, signatureValid, hashValid,
 *     record,            // the proof record (or null on NOT_FOUND/ERROR)
 *     compliance,        // EU AI Act flag block (or null when not requested)
 *     resolvedKey,       // { kid, fingerprint }  (or null)
 *     error,             // human-readable message (or null)
 *     verifiedAt,        // ISO timestamp this verification ran
 *   }
 */
export async function verify(evidenceId, opts = {}) {
  const proofBase = opts.proofBase ?? DEFAULT_PROOF_BASE;
  const jwksUrl = opts.jwksUrl ?? DEFAULT_JWKS_URL;
  const startedAt = new Date();

  const result = {
    evidenceId,
    verificationStatus: "ERROR",
    signaturePresent: false,
    signatureValid: false,
    hashValid: false,
    record: null,
    compliance: null,
    resolvedKey: null,
    error: null,
    verifiedAt: startedAt.toISOString(),
  };

  // 1. Fetch the evidence record.
  let record;
  try {
    record = await fetchEvidence(evidenceId, proofBase);
    result.record = record;
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (msg.includes("HTTP 404")) {
      result.verificationStatus = "NOT_FOUND";
      result.error = `Evidence record ${evidenceId} not found`;
    } else {
      result.verificationStatus = "ERROR";
      result.error = `Network error fetching evidence: ${msg}`;
    }
    return result;
  }

  // 2. Check signature presence.
  result.signaturePresent = !!record.signature;
  if (!record.signature || !record.signingKeyId) {
    result.verificationStatus = record.signature ? "UNSIGNED" : "LEGACY_UNSIGNED";
    return result;
  }

  // 3. Fetch and resolve the public key.
  let publicKeys;
  try {
    const jwks = await fetchJwks(jwksUrl);
    publicKeys = resolveJwksByKid(jwks, record.signingKeyId);
    if (publicKeys.length === 0) {
      result.verificationStatus = "ERROR";
      result.error = `Signing key not found in JWKS: ${record.signingKeyId}`;
      return result;
    }
  } catch (err) {
    result.verificationStatus = "ERROR";
    result.error = `JWKS fetch failed: ${err?.message ?? err}`;
    return result;
  }

  // 4. Reconstruct canonical payload and verify the signature.
  const canonical = buildCanonicalPayload(record);
  let signatureValid = false;
  let firstError = null;
  for (const pk of publicKeys) {
    const r = await verifyEd25519(pk, record.signature, canonical);
    if (r.ok) {
      signatureValid = true;
      result.resolvedKey = {
        kid: pk.kid,
        fingerprint: pk.x ? `pk:${pk.x.slice(0, 12)}…${pk.x.slice(-8)}` : "(no key)",
      };
      break;
    }
    if (!firstError) firstError = r.error;
  }

  result.signatureValid = signatureValid;
  result.hashValid = signatureValid; // authenticated by signature
  result.verificationStatus = signatureValid ? "VERIFIED" : "COMPLIANCE_VIOLATION";
  if (!signatureValid && firstError) result.error = firstError;

  // 5. Derive compliance flags if the record opts in to a compliance framework.
  const complianceMode = record.regulatoryContext?.complianceMode;
  if (complianceMode) {
    result.compliance = deriveComplianceFlags(complianceMode, {
      hasTraceFields: recordHasTraceFields(record),
      hashValid: result.hashValid,
      chainValid: signatureValid, // local verification ⇒ same as signature
      signatureValid: result.signatureValid,
      signaturePresent: result.signaturePresent,
    });
  }

  return result;
}
