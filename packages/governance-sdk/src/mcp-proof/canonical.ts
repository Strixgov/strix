/**
 * MC-1 canonical bytes — the single byte contract.
 *
 * Mirrors `solo_builder._canonical.canonicalize` (ADR-005 §4): JSON with
 * lexicographically-sorted keys, no whitespace, `ensure_ascii=False`
 * (Unicode survives byte-for-byte), `allow_nan=False`. The cross-SDK
 * byte-equivalence this module guarantees is proven against the MC-1
 * conformance corpus (`vectors/mcp_proof_v1/`) — every positive vector's
 * `canonical_bytes_hex` is reproduced exactly.
 *
 * The serializer is `canonicalizeJSON` from the SCJ v1 mirror — the same
 * chokepoint AA-1 and AC-1 sign/verify through. There is exactly one
 * canonicalizer in this SDK; MC-1 does not introduce a parallel shape.
 */

import { canonicalizeJSON } from "../actor-attestation/scj-v1-mirror.js";

const ENCODER = new TextEncoder();

/** Deterministic UTF-8 bytes used for hashing and signing. */
export function canonicalize(value: unknown): Uint8Array {
  return ENCODER.encode(canonicalizeJSON(value));
}

/** Lowercase hex of the canonical bytes. */
export function canonicalBytesHex(value: unknown): string {
  return Buffer.from(canonicalize(value)).toString("hex");
}

/** The string form, for callers that want it directly. */
export function canonicalString(value: unknown): string {
  return canonicalizeJSON(value);
}
