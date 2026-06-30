/**
 * MC-1 JSON-LD round-trip (AP2 / A2A interop). Mirror of
 * `solo_builder.mcp_proof.to_json_ld` / `from_json_ld`. The `@context` +
 * `@type` headers are non-canonical; the inner `mcp_proof` payload is
 * byte-identical to `payloadToDict` so canonical-byte determinism is
 * preserved (ADR-020 §8).
 */

import { payloadToDict, type McpProofRecord } from "./types.js";
import { recordFromView } from "./parse.js";

export const JSON_LD_CONTEXT_URL = "https://www.strixgov.com/ld/mcp-proof/v1";
export const JSON_LD_TYPE = "McpProofV1";

export function toJsonLd(record: McpProofRecord): Record<string, unknown> {
  return {
    "@context": JSON_LD_CONTEXT_URL,
    "@type": JSON_LD_TYPE,
    mcp_proof: payloadToDict(record.payload),
    signature: record.signature,
    kid: record.kid,
    created_at: record.created_at,
  };
}

export function fromJsonLd(doc: Record<string, any>): McpProofRecord {
  if (doc["@context"] !== JSON_LD_CONTEXT_URL) {
    throw new Error(`from_json_ld: @context must be ${JSON_LD_CONTEXT_URL}, got ${doc["@context"]}`);
  }
  if (doc["@type"] !== JSON_LD_TYPE) {
    throw new Error(`from_json_ld: @type must be ${JSON_LD_TYPE}, got ${doc["@type"]}`);
  }
  const mc = doc["mcp_proof"];
  if (mc === null || typeof mc !== "object") {
    throw new Error("from_json_ld: 'mcp_proof' object missing or not an object");
  }
  return recordFromView({
    payload: mc,
    signature: doc["signature"],
    kid: doc["kid"],
    created_at: doc["created_at"],
  });
}
