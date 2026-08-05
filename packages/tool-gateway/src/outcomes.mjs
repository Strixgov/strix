import crypto from "node:crypto";
import { canonicalJSON } from "./canonical.mjs";

export const EXECUTION_OUTCOME_SCHEMA_VERSION = "1";
export const EXECUTION_OUTCOME_SIGNATURE_ALGORITHM = "Ed25519";

export const EXECUTION_OUTCOME_CORE_FIELD_ORDER = Object.freeze([
  "schemaVersion",
  "outcomeId",
  "authorizationReceiptId",
  "authorizationProofChainHash",
  "capabilityId",
  "action",
  "decision",
  "executionAttempted",
  "executionStatus",
  "invocationHash",
  "resultHash",
  "errorCode",
  "policyVersion",
  "tenantId",
  "environment",
  "completedAt",
  "signingKeyId",
  "signatureAlgorithm",
]);

export const EXECUTION_OUTCOME_FIELD_ORDER = Object.freeze([
  ...EXECUTION_OUTCOME_CORE_FIELD_ORDER,
  "outcomeHash",
]);

export const EXECUTION_OUTCOME_ALLOWED_FIELDS = Object.freeze([
  ...EXECUTION_OUTCOME_FIELD_ORDER,
  "signature",
]);

const STRING_FIELDS = Object.freeze([
  ...EXECUTION_OUTCOME_FIELD_ORDER.filter((field) => field !== "executionAttempted"),
]);

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function orderedPayload(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}: payload must be an object`);
  }
  const parts = [];
  for (const field of fields) {
    const fieldValue = value[field];
    if (fieldValue === undefined || fieldValue === null) {
      throw new Error(`${label}: required field '${field}' is missing`);
    }
    parts.push(`${JSON.stringify(field)}:${JSON.stringify(fieldValue)}`);
  }
  return `{${parts.join(",")}}`;
}

function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

/**
 * Enforce the published schema without accepting unsigned extension fields.
 * Rejecting extras is load-bearing: otherwise an attacker could append a
 * misleading display field that is ignored by the canonical signature.
 *
 * `requireSignature:false` is used only by verification so a missing signature
 * can be reported as UNSIGNED rather than collapsed into a generic schema error.
 */
export function validateExecutionOutcomeShape(outcome, opts = {}) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new TypeError("validateExecutionOutcomeShape: outcome must be an object");
  }

  const allowed = new Set(EXECUTION_OUTCOME_ALLOWED_FIELDS);
  for (const field of Object.keys(outcome)) {
    if (!allowed.has(field)) {
      throw new Error(
        `validateExecutionOutcomeShape: unsupported field '${field}' is not signed by execution-outcome-v1`,
      );
    }
  }

  const required =
    opts.requireSignature === false
      ? EXECUTION_OUTCOME_FIELD_ORDER
      : EXECUTION_OUTCOME_ALLOWED_FIELDS;
  for (const field of required) {
    if (!(field in outcome) || outcome[field] === null || outcome[field] === undefined) {
      throw new Error(`validateExecutionOutcomeShape: required field '${field}' is missing`);
    }
  }
  for (const field of STRING_FIELDS) {
    if (typeof outcome[field] !== "string") {
      throw new Error(`validateExecutionOutcomeShape: field '${field}' must be a string`);
    }
  }
  if ("signature" in outcome && typeof outcome.signature !== "string") {
    throw new Error("validateExecutionOutcomeShape: field 'signature' must be a string");
  }
  if (outcome.executionAttempted !== true) {
    throw new Error("validateExecutionOutcomeShape: executionAttempted must be true");
  }
  if (outcome.schemaVersion !== EXECUTION_OUTCOME_SCHEMA_VERSION) {
    throw new Error(
      `validateExecutionOutcomeShape: unsupported schemaVersion '${outcome.schemaVersion}'`,
    );
  }
  if (outcome.signatureAlgorithm !== EXECUTION_OUTCOME_SIGNATURE_ALGORITHM) {
    throw new Error(
      `validateExecutionOutcomeShape: unsupported signatureAlgorithm '${outcome.signatureAlgorithm}'`,
    );
  }
  if (!matches(outcome.outcomeId, /^out_[A-Za-z0-9._-]+$/)) {
    throw new Error("validateExecutionOutcomeShape: outcomeId is malformed");
  }
  for (const field of ["authorizationReceiptId", "capabilityId", "action", "policyVersion", "tenantId", "environment", "signingKeyId"]) {
    if (outcome[field].length === 0) {
      throw new Error(`validateExecutionOutcomeShape: field '${field}' must not be empty`);
    }
  }
  if (!matches(outcome.authorizationProofChainHash, /^[0-9a-f]{64}$/)) {
    throw new Error(
      "validateExecutionOutcomeShape: authorizationProofChainHash must be lowercase SHA-256 hex",
    );
  }
  if (!matches(outcome.invocationHash, /^[0-9a-f]{64}$/)) {
    throw new Error(
      "validateExecutionOutcomeShape: invocationHash must be lowercase SHA-256 hex",
    );
  }
  if (!matches(outcome.outcomeHash, /^sha256:[0-9a-f]{64}$/)) {
    throw new Error(
      "validateExecutionOutcomeShape: outcomeHash must use sha256:<lowercase-hex>",
    );
  }
  if (!matches(outcome.resultHash, /^(|sha256:[0-9a-f]{64})$/)) {
    throw new Error("validateExecutionOutcomeShape: resultHash is malformed");
  }
  if (!Number.isFinite(Date.parse(outcome.completedAt))) {
    throw new Error("validateExecutionOutcomeShape: completedAt must be an ISO-compatible date-time");
  }
  if ("signature" in outcome && !matches(outcome.signature, /^[A-Za-z0-9_-]+$/)) {
    throw new Error("validateExecutionOutcomeShape: signature must be base64url text");
  }
  return true;
}

export function canonicalExecutionOutcomeCore(value) {
  return orderedPayload(
    value,
    EXECUTION_OUTCOME_CORE_FIELD_ORDER,
    "canonicalExecutionOutcomeCore",
  );
}

export function canonicalExecutionOutcomePayload(value) {
  return orderedPayload(
    value,
    EXECUTION_OUTCOME_FIELD_ORDER,
    "canonicalExecutionOutcomePayload",
  );
}

export function computeExecutionResultHash(result) {
  return `sha256:${sha256Hex(canonicalJSON(result ?? null))}`;
}

export function computeExecutionOutcomeHash(value) {
  return `sha256:${sha256Hex(canonicalExecutionOutcomeCore(value))}`;
}

export function newExecutionOutcomeId() {
  return `out_${crypto.randomBytes(12).toString("hex")}`;
}

export function issueExecutionOutcome(args) {
  if (!args?.authorizationReceipt) {
    throw new Error("issueExecutionOutcome: authorizationReceipt is required");
  }
  if (!args?.signingKey?.privateKey || !args.signingKey.kid) {
    throw new Error("issueExecutionOutcome: signingKey is required (fail-closed)");
  }

  const authorization = args.authorizationReceipt;
  if (authorization.decision !== "ALLOW") {
    throw new Error(
      `issueExecutionOutcome: authorization receipt decision must be ALLOW (got ${authorization.decision})`,
    );
  }
  if (!authorization.receiptId || !authorization.proofChainHash) {
    throw new Error(
      "issueExecutionOutcome: authorization receipt must include receiptId and proofChainHash",
    );
  }

  const executionStatus = String(args.executionStatus ?? "");
  if (!["SUCCEEDED", "FAILED", "UNKNOWN"].includes(executionStatus)) {
    throw new Error(
      `issueExecutionOutcome: invalid executionStatus '${executionStatus}'`,
    );
  }

  const resultHash =
    executionStatus === "SUCCEEDED"
      ? computeExecutionResultHash(args.result)
      : "";
  const errorCode =
    executionStatus === "FAILED"
      ? String(args.errorCode ?? "EXECUTOR_ERROR")
      : "";

  const core = {
    schemaVersion: EXECUTION_OUTCOME_SCHEMA_VERSION,
    outcomeId: args.outcomeId ?? newExecutionOutcomeId(),
    authorizationReceiptId: authorization.receiptId,
    authorizationProofChainHash: authorization.proofChainHash,
    capabilityId: authorization.capabilityId,
    action: authorization.action,
    decision: "ALLOW",
    executionAttempted: true,
    executionStatus,
    invocationHash: authorization.invocationHash,
    resultHash,
    errorCode,
    policyVersion: authorization.policyVersion,
    tenantId: authorization.tenantId,
    environment: authorization.environment,
    completedAt: args.completedAt ?? new Date().toISOString(),
    signingKeyId: args.signingKey.kid,
    signatureAlgorithm: EXECUTION_OUTCOME_SIGNATURE_ALGORITHM,
  };

  const outcomeHash = computeExecutionOutcomeHash(core);
  const canonical = { ...core, outcomeHash };
  const signature = crypto
    .sign(
      null,
      Buffer.from(canonicalExecutionOutcomePayload(canonical), "utf8"),
      args.signingKey.privateKey,
    )
    .toString("base64url");

  const outcome = { ...canonical, signature };
  validateExecutionOutcomeShape(outcome);
  return outcome;
}

export function verifyExecutionOutcome(outcome, publicKey, authorizationReceipt) {
  const result = {
    outcomeId: outcome?.outcomeId,
    schemaValid: false,
    hashValid: false,
    signaturePresent: !!outcome?.signature,
    keyResolved: !!publicKey,
    signatureValid: false,
    linkValid: authorizationReceipt ? false : null,
    consistencyValid: false,
    verificationStatus: "ERROR",
    error: null,
  };

  try {
    validateExecutionOutcomeShape(outcome, { requireSignature: false });
    result.schemaValid = true;

    result.hashValid =
      computeExecutionOutcomeHash(outcome) === outcome.outcomeHash;

    result.consistencyValid =
      outcome.decision === "ALLOW" &&
      outcome.executionAttempted === true &&
      ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(outcome.executionStatus) &&
      (outcome.executionStatus !== "SUCCEEDED" ||
        matches(outcome.resultHash, /^sha256:[0-9a-f]{64}$/)) &&
      (outcome.executionStatus !== "FAILED" || outcome.errorCode.length > 0) &&
      (outcome.executionStatus === "FAILED" || outcome.errorCode === "") &&
      (outcome.executionStatus === "SUCCEEDED" || outcome.resultHash === "");

    if (authorizationReceipt) {
      result.linkValid =
        authorizationReceipt.decision === "ALLOW" &&
        outcome.authorizationReceiptId === authorizationReceipt.receiptId &&
        outcome.authorizationProofChainHash === authorizationReceipt.proofChainHash &&
        outcome.capabilityId === authorizationReceipt.capabilityId &&
        outcome.action === authorizationReceipt.action &&
        outcome.invocationHash === authorizationReceipt.invocationHash &&
        outcome.policyVersion === authorizationReceipt.policyVersion &&
        outcome.tenantId === authorizationReceipt.tenantId &&
        outcome.environment === authorizationReceipt.environment;
    }

    if (!outcome.signature) {
      result.verificationStatus = "UNSIGNED";
      return result;
    }
    if (!publicKey) {
      result.verificationStatus = "KEY_NOT_FOUND";
      return result;
    }

    result.signatureValid = crypto.verify(
      null,
      Buffer.from(canonicalExecutionOutcomePayload(outcome), "utf8"),
      publicKey,
      Buffer.from(outcome.signature, "base64url"),
    );

    const linkOk = result.linkValid === null || result.linkValid === true;
    if (
      result.schemaValid &&
      result.hashValid &&
      result.signatureValid &&
      result.consistencyValid &&
      linkOk
    ) {
      result.verificationStatus = "VERIFIED";
    } else if (!result.hashValid) {
      result.verificationStatus = "HASH_MISMATCH";
    } else if (!result.signatureValid) {
      result.verificationStatus = "SIGNATURE_INVALID";
    } else if (!result.consistencyValid) {
      result.verificationStatus = "INCONSISTENT";
    } else {
      result.verificationStatus = "AUTHORIZATION_LINK_INVALID";
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.verificationStatus = "ERROR";
  }

  return result;
}
