/**
 * `@strixgov/sdk` AC-1 `transaction_proof_v1` verifier.
 *
 * A TypeScript port of the Python schema authority
 * (`solo_builder.transaction_proof`) that accepts a Python-signed AC-1
 * bundle: byte-identical canonicalization (proven against
 * `vectors/transaction_proof_v1/`), the 12 verifier rules in fixed order,
 * and the AA-1 / AA-2 sub-verifiers AC-1 rules 3/4/5 delegate to.
 */

export * from "./types.js";
export * from "./verifier.js";
export * from "./verifier-types.js";
export * from "./canonical.js";
export * from "./capabilities.js";
export * from "./network-signatures.js";
export * from "./json-ld.js";
export * from "./parse.js";
export * from "./sign.js";
export * from "./transaction-block.js";

export {
  verifyActorAttestationRecord,
  actorRecordFromView,
  credentialClassMatchesActor,
  type ActorAttestationRecord,
  type ActorAttestationPayload,
  type ActorClass,
  type CredentialClass,
  type ActorClassReason,
  type AA1Rule,
  type AttestationVerificationResult,
  type RevocationListResolver,
  type RevocationStatus,
} from "./actor-attestation.js";

export {
  verifyDeviceAttestationRecord,
  deviceRecordFromView,
  deviceClassMatchesProtocol,
  type DeviceAttestationRecord,
  type DeviceAttestationPayload,
  type DeviceClass,
  type AttestationProtocol,
  type DeviceClassReason,
  type AA2Rule,
  type DeviceVerificationResult,
} from "./device-attestation.js";
