/**
 * Strix Decision Token (SDT) — Verification and Parsing (open proof surface).
 *
 * This module is the VERIFICATION side of the SDT: canonicalization, signature
 * verification, claim validation, and parsing. Anyone can verify a token with
 * only this open package + the public key.
 *
 * The MINTING side (`createPayload`, `signToken`, `serializeToken`) — the act
 * of issuing authority to execute — lives in the closed control core
 * (`@strixgov/governance-core`), not here. Open the proof; sell the control.
 *
 * Signing/verification: Ed25519 via @noble/ed25519
 * Format: Base64url-encoded JSON with detached signature
 */

import { createHash } from "node:crypto";
import type { SDTPayload, StrixDecisionToken } from "../types.js";

// ─── Helpers ────────────────────────────────────────────────────────

function base64urlEncode(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

function base64urlDecode(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}

/**
 * Canonicalize a payload into a deterministic byte representation.
 * This ensures that signature verification is not affected by key ordering.
 */
export function canonicalizePayload(payload: SDTPayload): Uint8Array {
  const sorted = JSON.stringify(payload, Object.keys(payload).sort());
  return new TextEncoder().encode(sorted);
}

/**
 * Compute a SHA-256 hash of arbitrary data.
 */
export function sha256(data: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(typeof data === "string" ? data : Buffer.from(data));
  return hash.digest("hex");
}

// ─── Token Operations (verification / parsing) ──────────────────────
//
// Minting (createPayload / signToken / serializeToken) lives in the closed
// control core (@strixgov/governance-core). Only parsing + verification are
// part of the open proof surface.

/**
 * Deserialize a compact SDT string back into a StrixDecisionToken.
 */
export function deserializeToken(tokenString: string): StrixDecisionToken {
  const parts = tokenString.split(".");
  if (parts.length !== 3) {
    throw new TokenFormatError("Invalid SDT format: expected 3 dot-separated parts");
  }

  const [headerB64, payloadB64, signature] = parts;

  let header: { typ: string; alg: string };
  let payload: SDTPayload;

  try {
    header = JSON.parse(
      new TextDecoder().decode(base64urlDecode(headerB64))
    );
  } catch {
    throw new TokenFormatError("Invalid SDT header: malformed base64url or JSON");
  }

  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(payloadB64))
    );
  } catch {
    throw new TokenFormatError("Invalid SDT payload: malformed base64url or JSON");
  }

  if (header.typ !== "SDT") {
    throw new TokenFormatError(`Invalid token type: expected "SDT", got "${header.typ}"`);
  }

  if (header.alg !== "EdDSA") {
    throw new TokenFormatError(`Unsupported algorithm: expected "EdDSA", got "${header.alg}"`);
  }

  return { typ: "SDT", alg: "EdDSA", payload, signature };
}

/**
 * Verify an SDT signature using Ed25519.
 *
 * @param token - The SDT to verify
 * @param publicKeyHex - The Ed25519 public key as a hex string
 * @returns true if the signature is valid
 */
export async function verifySignature(
  token: StrixDecisionToken,
  publicKeyHex: string
): Promise<boolean> {
  const ed = await import("@noble/ed25519");
  const message = canonicalizePayload(token.payload);
  const signature = base64urlDecode(token.signature);
  const publicKey = hexToBytes(publicKeyHex);

  try {
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Validate an SDT payload's claims against the current execution context.
 *
 * Checks:
 * 1. Signature validity
 * 2. Token expiry
 * 3. Capability match
 * 4. Actor match
 * 5. Environment match
 */
export async function validateToken(
  token: StrixDecisionToken,
  expected: {
    capabilityId: string;
    actorId: string;
    environment: string;
    publicKeyHex: string;
  }
): Promise<TokenValidationResult> {
  // 1. Verify signature
  const signatureValid = await verifySignature(token, expected.publicKeyHex);
  if (!signatureValid) {
    return { valid: false, code: "INVALID_SIGNATURE", reason: "Ed25519 signature verification failed" };
  }

  const { payload } = token;

  // 2. Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt <= now) {
    return { valid: false, code: "TOKEN_EXPIRED", reason: `Token expired at ${new Date(payload.expiresAt * 1000).toISOString()}` };
  }

  // 3. Capability match
  if (payload.capabilityId !== expected.capabilityId) {
    return {
      valid: false,
      code: "CAPABILITY_MISMATCH",
      reason: `Expected capability "${expected.capabilityId}", got "${payload.capabilityId}"`,
    };
  }

  // 4. Actor match
  if (payload.actorId !== expected.actorId) {
    return {
      valid: false,
      code: "ACTOR_MISMATCH",
      reason: `Expected actor "${expected.actorId}", got "${payload.actorId}"`,
    };
  }

  // 5. Environment match
  if (payload.environment !== expected.environment) {
    return {
      valid: false,
      code: "ENVIRONMENT_MISMATCH",
      reason: `Expected environment "${expected.environment}", got "${payload.environment}"`,
    };
  }

  return { valid: true, code: "VALID", reason: "All checks passed" };
}

// ─── Types ──────────────────────────────────────────────────────────

export interface TokenValidationResult {
  valid: boolean;
  code: string;
  reason: string;
}

// ─── Errors ─────────────────────────────────────────────────────────

export class TokenFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenFormatError";
  }
}

// ─── Utility ────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
