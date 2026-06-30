/**
 * AC-1 JSON-LD round-trip (AP2 / A2A interop). Mirror of
 * `to_json_ld` / `from_json_ld`. The `@context` + `@type` headers are
 * non-canonical; the inner `transaction` payload is byte-identical to
 * `payloadToDict` so canonical-byte determinism is preserved.
 */

import { payloadToDict, type TransactionProofRecord } from "./types.js";
import { recordFromView } from "./parse.js";

export const JSON_LD_CONTEXT_URL = "https://www.strixgov.com/ld/transaction-proof/v1";
export const JSON_LD_TYPE = "TransactionProofV1";

export function toJsonLd(record: TransactionProofRecord): Record<string, unknown> {
  return {
    "@context": JSON_LD_CONTEXT_URL,
    "@type": JSON_LD_TYPE,
    transaction: payloadToDict(record.payload),
    signature: record.signature,
    kid: record.kid,
    created_at: record.created_at,
  };
}

export function fromJsonLd(doc: Record<string, any>): TransactionProofRecord {
  if (doc["@context"] !== JSON_LD_CONTEXT_URL) {
    throw new Error(`from_json_ld: @context must be ${JSON_LD_CONTEXT_URL}, got ${doc["@context"]}`);
  }
  if (doc["@type"] !== JSON_LD_TYPE) {
    throw new Error(`from_json_ld: @type must be ${JSON_LD_TYPE}, got ${doc["@type"]}`);
  }
  const tx = doc["transaction"];
  if (tx === null || typeof tx !== "object") {
    throw new Error("from_json_ld: 'transaction' object missing or not an object");
  }
  return recordFromView({
    payload: tx,
    signature: doc["signature"],
    kid: doc["kid"],
    created_at: doc["created_at"],
  });
}
