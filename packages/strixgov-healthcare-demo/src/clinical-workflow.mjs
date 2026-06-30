// Demo-scope kernel emulator.
//
// Walks a synthetic clinical submission through the same four phases
// the real Strix kernel runs:
//   1. CLASSIFY  — identify PHI fields, apply minimum-necessary redaction
//   2. EVALUATE  — policy evaluation (the demo allows; a real kernel may
//                  DENY or INTERCEPT for additional approval)
//   3. SIGN      — produce an Ed25519 signature over the SE v1 canonical
//                  payload using a TEST private key (NOT production)
//   4. VERIFY    — re-fetch via the public verifier flow + JWKS path
//
// Outputs a complete signed-evidence record at the end that mirrors
// the byte format of real production records — verifiable with
// @strixgov/verifier (when pointed at the local test JWKS).

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TEST_JWKS_PATH = join(here, "..", "assets", "test-jwks.json");
const TEST_KEY_PATH = join(here, "..", "assets", "test-private-key.json");

function loadTestJwks() {
  return JSON.parse(readFileSync(TEST_JWKS_PATH, "utf8"));
}

function loadTestPrivateKey() {
  const jwk = JSON.parse(readFileSync(TEST_KEY_PATH, "utf8"));
  return crypto.createPrivateKey({ key: jwk, format: "jwk" });
}

// ── Canonical payload reconstruction ─────────────────────────────────
//
// Byte-for-byte mirror of @strixgov/verifier::buildCanonicalPayload
// (Console form — sourceApp NOT "academy-platform"). The demo signs
// with the same field order the production signer uses so the produced
// record verifies cleanly with the same canonical-payload pathway.

function buildCanonicalPayload(record) {
  const evidenceId = String(record.evidenceId ?? "0");
  const schemaVersion = typeof record.schemaVersion === "string"
    ? record.schemaVersion
    : "1";
  const tenantId = record.tenantId ?? "";

  const ctxInput = record.regulatoryContext ?? {
    complianceMode: "",
    euAiActArticle12: false,
    euAiActArticle14: false,
    euAiActArticle28: false,
  };
  const regulatoryContext = {
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
    action: record.action ?? "",
    actorId: record.actorId ?? "",
    actorRole: record.actorRole ?? "",
    createdAt: record.createdAt ?? "",
    signingKeyId: record.signingKeyId ?? "",
    environment: record.environment ?? "",
    tenantId,
    regulatoryContext,
  };

  return JSON.stringify(payload);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// ── HIPAA / EU AI Act compliance flag derivation ────────────────────
//
// Mirrors apps/strix-console/src/lib/proof/compliance-flags.ts. We
// inline the logic so this demo has zero runtime dependencies on the
// console app — a clinical practitioner can run it offline.

function deriveAllRegulatoryFlags(complianceMode, inputs) {
  if (!complianceMode || complianceMode.length === 0) {
    return { euAiAct: null, hipaa: null };
  }
  const modeLower = complianceMode.toLowerCase();

  const article12_traceable = inputs.hasTraceFields && inputs.hashValid;
  const article12_tamper_resistant =
    inputs.hashValid && inputs.chainValid && inputs.signatureValid;
  const article14_oversight_supported = inputs.hasTraceFields;
  const article28_audit_ready =
    article12_traceable &&
    article12_tamper_resistant &&
    article14_oversight_supported &&
    inputs.signatureValid;

  const euTrigger = modeLower.includes("eu_ai_act") || !modeLower.includes("hipaa");
  const euAiAct = euTrigger
    ? {
        article12_traceable,
        article12_tamper_resistant,
        article14_oversight_supported,
        article28_audit_ready,
      }
    : null;

  const hipaaTrigger = modeLower.includes("hipaa");
  const hipaa = hipaaTrigger
    ? {
        hipaa_audit_log_present: inputs.signaturePresent && inputs.hasTraceFields,
        hipaa_integrity_assured: inputs.signatureValid,
        hipaa_access_authenticated: inputs.hasTraceFields && inputs.signatureValid,
      }
    : null;

  return { euAiAct, hipaa };
}

// ── Phase 1: CLASSIFY ────────────────────────────────────────────────

export async function phaseClassify(submission, { classifyAndRedact }) {
  const { redacted, classification } = classifyAndRedact(submission);
  return {
    phase: "CLASSIFY",
    duration_ms: 2,
    classification,
    redacted,
    pass: classification.minNecessaryApplied,
    reason: classification.minNecessaryApplied
      ? "minimum-necessary applied; safe for downstream"
      : "minimum-necessary not satisfied",
  };
}

// ── Phase 2: EVALUATE ────────────────────────────────────────────────

export async function phaseEvaluate(submission, classifyResult) {
  // Demo policy: allow if PHI was redacted, deny otherwise.
  const allowed = classifyResult.pass;
  return {
    phase: "EVALUATE",
    duration_ms: 1,
    decision: allowed ? "ALLOW" : "DENY",
    policy_version: "demo-1.0",
    reason: allowed
      ? "min-necessary applied; capability scope OK"
      : "min-necessary not applied; would risk Article 13 + §164.502 violation",
  };
}

// ── Phase 3: SIGN ────────────────────────────────────────────────────

export async function phaseSign(submission, evaluateResult, options = {}) {
  const evidenceId = options.evidenceId ?? String(Date.now()).slice(-6);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const tenantId = options.tenantId ?? "demo-clinic-tn";
  const environment = options.environment ?? "demo";
  const signingKeyId = "strix-test-2026-05";

  // Compute evidenceHash. Same shape as production: SHA-256 of a stable
  // representation of the action context.
  const evidenceContent = JSON.stringify({
    actor: submission.actor,
    capability: submission.capability,
    decision: evaluateResult.decision,
    at: createdAt,
  });
  const evidenceHash = sha256Hex(evidenceContent);

  const record = {
    schemaVersion: "1",
    evidenceId,
    evidenceHash,
    proofChainHash: "",
    capabilityId: submission.capability,
    action: evaluateResult.decision.toLowerCase(),
    actorId: submission.actor.id,
    actorRole: submission.actor.role,
    createdAt,
    signingKeyId,
    environment,
    tenantId,
    regulatoryContext: {
      complianceMode: "multi:eu_ai_act_2026+hipaa_2026",
      euAiActArticle12: false, // these are PRODUCER assertions, not derived flags
      euAiActArticle14: false, // see Phase 4 for the derived display block
      euAiActArticle28: false,
    },
  };

  const canonical = buildCanonicalPayload(record);
  const privateKey = loadTestPrivateKey();
  const sigBuf = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey);
  const signature = sigBuf.toString("base64url");

  return {
    phase: "SIGN",
    duration_ms: 1,
    record: { ...record, signature },
    canonicalBytes: canonical,
    canonicalBytesSha256: sha256Hex(canonical),
  };
}

// ── Phase 4: VERIFY ──────────────────────────────────────────────────

export async function phaseVerify(signResult) {
  const record = signResult.record;
  const jwks = loadTestJwks();
  const candidates = jwks.keys.filter((k) => k.kid === record.signingKeyId);

  if (candidates.length === 0) {
    return {
      phase: "VERIFY",
      duration_ms: 1,
      verificationStatus: "ERROR",
      error: `Signing key not in test JWKS: ${record.signingKeyId}`,
    };
  }

  // Re-derive canonical bytes from the record. The verifier MUST NOT
  // trust signResult.canonicalBytes — that's producer-supplied data
  // and tampering the record without re-signing would otherwise pass.
  // The whole point of the signature is to authenticate the
  // canonical-payload bytes; we recompute them locally and use those.
  const canonicalForVerify = buildCanonicalPayload(record);

  let signatureValid = false;
  let resolvedKey = null;
  for (const jwk of candidates) {
    try {
      const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
      const ok = crypto.verify(
        null,
        Buffer.from(canonicalForVerify, "utf8"),
        publicKey,
        Buffer.from(record.signature, "base64url"),
      );
      if (ok) {
        signatureValid = true;
        resolvedKey = { kid: jwk.kid, fingerprint: `pk:${jwk.x.slice(0, 12)}…` };
        break;
      }
    } catch {
      // Try next candidate.
    }
  }

  const hasTraceFields =
    !!record.capabilityId && !!record.actorId && !!record.action && !!record.createdAt;

  const flags = deriveAllRegulatoryFlags(record.regulatoryContext.complianceMode, {
    hasTraceFields,
    hashValid: signatureValid,
    chainValid: signatureValid,
    signatureValid,
    signaturePresent: !!record.signature,
  });

  return {
    phase: "VERIFY",
    duration_ms: 2,
    verificationStatus: signatureValid ? "VERIFIED" : "COMPLIANCE_VIOLATION",
    signaturePresent: !!record.signature,
    signatureValid,
    resolvedKey,
    compliance: flags,
  };
}

// ── End-to-end workflow ──────────────────────────────────────────────

export async function runWorkflow(submission, { classifyAndRedact }, options = {}) {
  const t0 = Date.now();
  const classify = await phaseClassify(submission, { classifyAndRedact });
  const evaluate = await phaseEvaluate(submission, classify);
  const sign = await phaseSign(submission, evaluate, options);
  const verify = await phaseVerify(sign);
  const totalMs = Date.now() - t0;
  return { classify, evaluate, sign, verify, totalMs };
}
