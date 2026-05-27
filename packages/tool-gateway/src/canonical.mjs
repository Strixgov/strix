/**
 * Canonical JSON serialization for receipt signing.
 *
 * Invariant: two semantically-equal payloads MUST produce byte-identical
 * output. The Ed25519 signature is computed over these bytes; if the
 * verifier reconstructs them differently, every signature appears
 * tampered. The verifier mirrors this exact code path.
 *
 * Schema versions:
 *
 *   v1 (frozen — DO NOT MODIFY):
 *     schemaVersion → receiptId → capabilityId → action → decision
 *     → risk → mode → invocationHash → evidenceHash → proofChainHash
 *     → timestamp
 *
 *   v2 (current):
 *     schemaVersion → receiptId → capabilityId → action → decision
 *     → risk → mode → policyVersion → tenantId → environment
 *     → invocationHash → evidenceHash → proofChainHash → timestamp
 *
 * `canonicalReceiptPayload` dispatches on `r.schemaVersion`. v1 receipts
 * issued before this bump remain verifiable forever; the verifier and
 * gateway both include the v1 builder in cold storage. Anything at v2 or
 * later goes through the current builder.
 *
 * Reordering or renaming any field within a frozen version breaks every
 * previously-issued receipt's signature. Don't.
 */

const RECEIPT_FIELD_ORDER_V1 = Object.freeze([
  "schemaVersion",
  "receiptId",
  "capabilityId",
  "action",
  "decision",
  "risk",
  "mode",
  "invocationHash",
  "evidenceHash",
  "proofChainHash",
  "timestamp",
]);

const RECEIPT_FIELD_ORDER_V2 = Object.freeze([
  "schemaVersion",
  "receiptId",
  "capabilityId",
  "action",
  "decision",
  "risk",
  "mode",
  "policyVersion",
  "tenantId",
  "environment",
  "invocationHash",
  "evidenceHash",
  "proofChainHash",
  "timestamp",
]);

/** Current schema version. New receipts use this. */
export const RECEIPT_SCHEMA_VERSION = "2";

/** Back-compat alias — points at the current version's field order. */
const RECEIPT_FIELD_ORDER = RECEIPT_FIELD_ORDER_V2;

/**
 * Field order for a given schema version.
 * @param {string} v
 */
function fieldOrderFor(v) {
  if (v === "1") return RECEIPT_FIELD_ORDER_V1;
  if (v === "2") return RECEIPT_FIELD_ORDER_V2;
  throw new Error(`canonicalReceiptPayload: unknown schemaVersion '${v}'`);
}

/**
 * Serialize a receipt canonical payload into a deterministic byte string.
 *
 * Rules:
 *   - Keys appear in RECEIPT_FIELD_ORDER for the receipt's schemaVersion,
 *     no others, no defaults inserted.
 *   - Each value is JSON.stringify'd (deterministic for our scalar set).
 *   - No whitespace, no trailing comma.
 *
 * @param {import("./types.d.ts").ReceiptCanonical} r
 * @returns {string}
 */
export function canonicalReceiptPayload(r) {
  if (!r || typeof r !== "object") {
    throw new TypeError("canonicalReceiptPayload: payload must be an object");
  }
  const order = fieldOrderFor(String(r.schemaVersion ?? RECEIPT_SCHEMA_VERSION));
  const parts = [];
  for (const field of order) {
    const value = r[field];
    if (value === undefined || value === null) {
      throw new Error(
        `canonicalReceiptPayload: required field '${field}' is missing`
      );
    }
    parts.push(`${JSON.stringify(field)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Deterministic JSON for arbitrary objects (tool invocation arguments,
 * policy rulesets). Used wherever we need a "two semantically-equal
 * inputs MUST hash to the same bytes" guarantee.
 *
 * Object keys are sorted lexicographically; arrays preserve order; all
 * primitives JSON.stringify directly.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJSON(value) {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJSON: non-finite numbers are not allowed");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`
    );
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(
    `canonicalJSON: unsupported value type (${typeof value})`
  );
}

export {
  RECEIPT_FIELD_ORDER,
  RECEIPT_FIELD_ORDER_V1,
  RECEIPT_FIELD_ORDER_V2,
};
