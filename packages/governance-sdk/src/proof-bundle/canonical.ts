/**
 * proof_bundle_v2 canonical bytes + hash. Same single byte contract as the
 * rest of the stack — reuses the SCJ v1 `canonicalizeJSON` chokepoint;
 * `hashCanonical` is the lowercase SHA-256 hex of those bytes (ADR-005 §4).
 */

import { createHash } from "node:crypto";
import { canonicalizeJSON } from "../actor-attestation/scj-v1-mirror.js";

const ENCODER = new TextEncoder();

export function canonicalize(value: unknown): Uint8Array {
  return ENCODER.encode(canonicalizeJSON(value));
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(Buffer.from(canonicalize(value))).digest("hex");
}
