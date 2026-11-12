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

// ── Declaration refusals (#2835 / #2836) ────────────────────────────
//
// Contract: docs/gates/SE-V1-ALGORITHM-METADATA.md. Same rules and order as
// @strixgov/verifier, written here independently. Decided BEFORE key lookup:
// a refused record is never VERIFIED and never reported as a signature
// failure.
//
//   1. Schema version. An explicit `declaredSchemaVersion` — or, on the
//      reconstruction path only, the record's `schemaVersion` — must be
//      exactly 1 or "1". "1.0", "v1", 2, "2", objects are refused; nothing is
//      coerced into 1. When the signed bytes travel as `signedPayload`, the
//      record-level `schemaVersion` is an unsigned projection of them and is
//      not consulted here.
//   2. Algorithm. An explicit `signatureAlgorithm` other than exactly
//      "Ed25519" (case-sensitive) is refused. Absent/null is the legacy case,
//      read under the fixed SE v1 rule.
export function declarationRefusal(record) {
  const hasSignedBytes =
    typeof record.signedPayload === "string" && record.signedPayload.length > 0;
  const declarations = hasSignedBytes
    ? [record.declaredSchemaVersion]
    : [record.declaredSchemaVersion, record.schemaVersion];
  for (const declared of declarations) {
    if (declared != null && declared !== 1 && declared !== "1") {
      return "UNSUPPORTED_SCHEMA_VERSION";
    }
  }
  if (record.signatureAlgorithm != null && record.signatureAlgorithm !== "Ed25519") {
    return "UNSUPPORTED_ALGORITHM";
  }
  return null;
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

      // THREE response shapes reach this function. This flattener MUST mirror
      // @strixgov/verifier::fetchEvidence exactly — a divergent flattener here
      // is the CJ-1 canonicalization drift the conformance program exists to
      // prevent, and it fails in the worst possible direction: a valid record
      // rendered as unsigned.
      //
      //   1. Console /api/public/proof/<id>:
      //      { schemaVersion, fields: {...}, signature, signingKeyId, ... }
      //   2. Academy /api/proof/<id>:
      //      { ok, proof: { ...flat fields, signature, signedPayload,
      //        signingKeyId }, verification: {...} }
      //   3. Pre-1.3 raw shape: bare record object at top level.

      // Shape 1 — Console. Detected via the co-occurrence of `fields` AND a
      // `signature` key, which is what distinguishes it from Academy's `proof`
      // shape.
      if (
        json.fields &&
        typeof json.fields === "object" &&
        Object.prototype.hasOwnProperty.call(json, "signature")
      ) {
        const fields = json.fields;

        // The Console route puts `signature` and `signingKeyId` at the TOP
        // level, as siblings of `fields` — not inside it. Spreading `fields`
        // alone left `record.signature` undefined, so this verifier reported
        // every signed Console record as LEGACY_UNSIGNED: a valid, signed
        // record rendered as "no signature was ever produced". The corpus
        // runner never caught it because it fed the Academy shape only.
        //
        // Promote `signature` and `schemaVersion` — and ONLY those, exactly as
        // @strixgov/verifier's flattener does.
        //
        // `signingKeyId` is deliberately NOT promoted: the Console redacts the
        // top-level copy for privacy (`strix-***-YYYY-MM`) while the canonical
        // payload was signed with the FULL kid, which survives in `fields`.
        // Promoting the redacted value would change the canonical bytes and
        // break verification for every signed record — the v1.9.2/v1.9.3 bug
        // class. `evidenceId` is excluded for the same reason (the top-level
        // value is the caller's lookup key, which may be a hash rather than the
        // row id).
        return {
          ...fields,
          ...(json.signature !== undefined ? { signature: json.signature } : {}),
          ...(json.schemaVersion !== undefined ? { schemaVersion: json.schemaVersion } : {}),
          signedPayload: json.signedPayload ?? fields.signedPayload,
        };
      }

      // Shape 2 (Academy) or shape 3 (raw). Academy nests the ENTIRE flat
      // record — `signature`, `signedPayload`, and the FULL (unredacted)
      // `signingKeyId` included — under `proof`. Reading the wrapper object
      // instead left `record.signature` undefined, so every signed Academy
      // record verified as LEGACY_UNSIGNED. That is the same defect the Console
      // branch above records, in the other direction: the comment there said
      // "Academy returns flat", which was true of an older response shape and
      // silently stopped being true.
      return json.proof ?? json;
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

// Mirror of the JS reference resolver (@strixgov/verifier resolveJwksByKid) and
// the Python one (strix_verify.resolve_public_keys). Returns every candidate
// key; the caller (step 4 above) tries each and accepts on the first that
// verifies.
//
// UNION exact + case-insensitive candidates — do NOT short-circuit on the first
// exact match. A historical signer-config defect minted records under an
// uppercase env segment (strix-PROD-2026-05, issue #1306); the kid casing never
// enters the signed payload, so a case-variant is signature-equivalent. And if a
// JWKS serves a WRONG key under the exact (uppercase) kid AND the CORRECT key
// under a case-variant, an exact-first resolver returns only the wrong key and
// the record fails though its key is served (issue #1628). Exact matches come
// first (preferred), case-variants after. The redacted display form
// (strix-***-YYYY-MM) matches by suffix (digits carry no case → no union).
function resolveJwksByKid(jwks, kid) {
  if (!jwks?.keys || !Array.isArray(jwks.keys)) return [];
  const keys = jwks.keys;
  const lower = typeof kid === "string" ? kid.toLowerCase() : null;
  const exact = keys.filter((k) => k.kid === kid);
  const ciExtra = lower
    ? keys.filter(
        (k) =>
          typeof k.kid === "string" &&
          k.kid !== kid &&
          k.kid.toLowerCase() === lower,
      )
    : [];
  const union = [...exact, ...ciExtra];
  if (union.length > 0) return union;

  const m = typeof kid === "string" ? kid.match(/^strix-\*\*\*-(\d{4}-\d{2})$/) : null;
  if (!m) return [];
  const suffix = `-${m[1]}`;
  return keys.filter((k) => typeof k.kid === "string" && k.kid.endsWith(suffix));
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
 *                         "COMPLIANCE_VIOLATION" | "UNVERIFIABLE" |
 *                         "NOT_FOUND" | "ERROR",
 *     verificationReason, // e.g. SIGNATURE_INVALID, SIGNING_KEY_UNKNOWN,
 *                         // UNSUPPORTED_ALGORITHM, UNSUPPORTED_SCHEMA_VERSION
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

  // 2b. Declaration refusals, before any key lookup. Status mirrors
  // @strixgov/verifier: an unsupported algorithm is UNVERIFIABLE (we cannot
  // check it), an unsupported schema version is COMPLIANCE_VIOLATION (the
  // record does not meet the SE v1 contract). `verificationReason` names
  // which, so neither renders as a failed signature.
  const refusal = declarationRefusal(record);
  if (refusal) {
    result.verificationReason = refusal;
    if (refusal === "UNSUPPORTED_ALGORITHM") {
      result.verificationStatus = "UNVERIFIABLE";
      result.error = `Record declares signatureAlgorithm ${JSON.stringify(record.signatureAlgorithm)}; Signed Evidence v1 permits only "Ed25519".`;
    } else {
      result.verificationStatus = "COMPLIANCE_VIOLATION";
      result.error = "Record declares a schema version other than 1; Signed Evidence v1 admits only \"1\".";
    }
    return result;
  }

  // 3. Fetch and resolve the public key.
  let publicKeys;
  try {
    const jwks = await fetchJwks(jwksUrl);
    publicKeys = resolveJwksByKid(jwks, record.signingKeyId);
    if (publicKeys.length === 0) {
      // UNVERIFIABLE, not ERROR. An unresolvable kid means this page fetched a
      // JWKS that does not contain the key — the record may be entirely valid
      // against a JWKS this embed has never seen. Cannot-verify is not
      // proven-wrong, and rendering it through the error card told a customer's
      // visitor "VERIFICATION ERROR" about an untampered record.
      //
      // Matches the same correction made in @strixgov/verifier (1.22.0,
      // SIGNING_KEY_UNKNOWN) and verifiers/python/strix_verify.py, and matches
      // the Proof Explorer's four-state vocabulary where UNVERIFIABLE is a
      // first-class state that never wears INVALID's colour.
      result.verificationStatus = "UNVERIFIABLE";
      result.verificationReason = "SIGNING_KEY_UNKNOWN";
      result.error = `Signing key not found in the JWKS this page fetched: ${record.signingKeyId}. This is NOT evidence of tampering.`;
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
  if (!signatureValid) result.verificationReason = "SIGNATURE_INVALID";
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
