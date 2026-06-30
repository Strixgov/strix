/**
 * Real Ed25519 MC-1 signer (reference / dogfood / adapter emitter).
 *
 * Produces a genuinely-signed `mcp_proof_v1` bundle: the nested principal /
 * agent (AA-1) and optional device (AA-2) attestations are signed over
 * `canonicalize(payload)`, and the outer envelope over the MC-1 payload's
 * canonical bytes. This is the producer side of WS-2 — the emitter the
 * `@strixgov/mcp-adapter` v0.2 path composes a record through, and the
 * sign-half of the "sign here → any third party verifies from the JWKS"
 * round-trip the dogfood proves.
 *
 * The keyring + nested AA-1/AA-2 signers are the *same* shared producers AC-1
 * uses (`../transaction-proof/sign.js`) — one signer surface, one keyring
 * model, no sibling drift. Only the outer-envelope signing differs (it covers
 * the MC-1 payload, not the AC-1 one).
 */

import { payloadCanonicalBytes, type McpProofPayload, type McpProofRecord } from "./types.js";
import {
  Ed25519Keyring,
  signActorAttestation,
  signDeviceAttestation,
} from "../transaction-proof/sign.js";

export { Ed25519Keyring };

/**
 * Sign a full MC-1 bundle: re-sign the nested attestations, then sign the
 * outer envelope over `payloadCanonicalBytes`. Returns the signed record.
 *
 * Mirrors `signTransactionProof` — the device attestation is signed only when
 * present (null for non-human principals, per rule 5).
 */
export function signMcpProof(
  payload: McpProofPayload,
  bundleKid: string,
  keyring: Ed25519Keyring,
  createdAt: string,
): McpProofRecord {
  const principal = signActorAttestation(payload.principal_attestation, keyring);
  const agent = signActorAttestation(payload.agent_attestation, keyring);
  const device = payload.device_attestation
    ? signDeviceAttestation(payload.device_attestation, keyring)
    : null;
  const signedPayload: McpProofPayload = {
    ...payload,
    principal_attestation: principal,
    agent_attestation: agent,
    device_attestation: device,
  };
  const bundleSig = keyring.sign(signedPayload.iss, bundleKid, payloadCanonicalBytes(signedPayload));
  return { payload: signedPayload, signature: bundleSig, kid: bundleKid, created_at: createdAt };
}
