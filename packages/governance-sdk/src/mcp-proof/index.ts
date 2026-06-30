/**
 * `@strixgov/sdk` MC-1 `mcp_proof_v1` verifier.
 *
 * A TypeScript port of the Python schema authority (`solo_builder.mcp_proof`,
 * ADR-020) that accepts a Python-signed MC-1 bundle: byte-identical
 * canonicalization (proven against `vectors/mcp_proof_v1/`), the 12 verifier
 * rules in fixed order, the K-BIND-3 parameter binding, and the AA-1 / AA-2
 * sub-verifiers MC-1 rules 3/4/5 delegate to.
 *
 * MC-1 is the governed MCP tool-call envelope — the answer to "did this agent
 * invoke this tool, with these parameters, on this server, on behalf of this
 * principal?" It is a sibling of AC-1 (`transaction_proof_v1`), NOT a derived
 * type; both share the 12-field / 12-rule / tri-state pattern, the one
 * canonicalizer, and the AA-1/AA-2 attestation surface, but not field-level
 * inheritance.
 */

export * from "./types.js";
export * from "./verifier.js";
export * from "./canonical.js";
export * from "./json-ld.js";
export * from "./parse.js";
export * from "./sign.js";
export * from "./tool-call-block.js";

// The capability registry + pluggable crypto protocols + AA-1/AA-2 ports are
// shared with AC-1 — re-export the MC-1-relevant surface so consumers import
// from one place.
export {
  lookupStatus,
  setStatus,
  snapshotStatus,
  restoreStatus,
  policyDecisionError,
  ReservationStatus,
  CAPABILITY_RESERVED_NOT_ACTIVE,
  MC_1,
} from "../transaction-proof/capabilities.js";

export type { SignatureVerifier, JwksResolver } from "../transaction-proof/verifier-types.js";

export {
  verifyActorAttestationRecord,
  type ActorAttestationRecord,
  type ActorAttestationPayload,
  type CredentialClass,
  type RevocationListResolver,
  type RevocationStatus,
} from "../transaction-proof/actor-attestation.js";

export {
  verifyDeviceAttestationRecord,
  type DeviceAttestationRecord,
  type DeviceAttestationPayload,
  type DeviceClass,
  type AttestationProtocol,
} from "../transaction-proof/device-attestation.js";
