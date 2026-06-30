/**
 * AA-2 device-attestation sub-verifier — AC-1 rule 5 delegates here.
 *
 * Behaviour-faithful TS port of
 * `solo_builder.device_attestation.verify_device_attestation` (ADR-016) as
 * exercised by the AC-1 verifier path. Same 9-rule fixed-order shape as
 * AA-1; DEVICE-PRE-2 is the (device_class, attestation_protocol) allow-set.
 */

import { canonicalize } from "./canonical.js";
import { lookupStatus, AA_2, ReservationStatus } from "./capabilities.js";
import { hexToBytes, parseIso, type RevocationListResolver } from "./actor-attestation.js";
import type { SignatureVerifier, JwksResolver } from "./verifier-types.js";

export type DeviceClass = "browser" | "mobile_ios" | "mobile_android";
export const DEVICE_CLASSES: readonly DeviceClass[] = ["browser", "mobile_ios", "mobile_android"];

export type AttestationProtocol = "webauthn" | "app_attest_ios" | "play_integrity_android";
export const ATTESTATION_PROTOCOLS: readonly AttestationProtocol[] = [
  "webauthn",
  "app_attest_ios",
  "play_integrity_android",
];

/**
 * DEVICE-PRE-2 allow-set (3 pairs). Python (ADR-016) is the source of truth
 * for AA-2 v1; mirrors the vendored `device_class_matrix.snapshot.json`.
 */
const DEVICE_PRE_2_PAIRS: ReadonlySet<string> = new Set([
  "browser webauthn",
  "mobile_ios app_attest_ios",
  "mobile_android play_integrity_android",
]);

export function deviceClassMatchesProtocol(
  deviceClass: DeviceClass,
  protocol: AttestationProtocol,
): boolean {
  return DEVICE_PRE_2_PAIRS.has(`${deviceClass} ${protocol}`);
}

export const AA2_REQUIRED_PAYLOAD_FIELDS: readonly string[] = [
  "evidence_id",
  "device_class",
  "device_id",
  "attestation_protocol",
  "tenant_id",
  "environment",
  "attested_at",
  "capability_id",
  "iss",
];

export interface DeviceAttestationPayload {
  evidence_id: string;
  device_class: DeviceClass;
  device_id: string;
  attestation_protocol: AttestationProtocol;
  tenant_id: string;
  environment: string;
  attested_at: string;
  capability_id: string;
  iss: string;
}

export interface DeviceAttestationRecord {
  payload: DeviceAttestationPayload;
  signature: string;
  kid: string;
  created_at: string;
}

export function devicePayloadToDict(p: DeviceAttestationPayload): Record<string, unknown> {
  return {
    evidence_id: p.evidence_id,
    device_class: p.device_class,
    device_id: p.device_id,
    attestation_protocol: p.attestation_protocol,
    tenant_id: p.tenant_id,
    environment: p.environment,
    attested_at: p.attested_at,
    capability_id: p.capability_id,
    iss: p.iss,
  };
}

/**
 * Reconstruct + validate an AA-2 record from its on-wire dict view. Mirrors
 * the Python `DeviceClass(...)` / `AttestationProtocol(...)` enum conversions
 * and `DeviceAttestationPayload.__post_init__` — used by the standalone AA-2
 * conformance (construction-time negatives surface the same first error).
 */
export function deviceRecordFromView(view: Record<string, any>): DeviceAttestationRecord {
  const p = view.payload;
  if (!DEVICE_CLASSES.includes(p.device_class)) {
    throw new Error(`device_class ${p.device_class} is not a known DeviceClass`);
  }
  if (!ATTESTATION_PROTOCOLS.includes(p.attestation_protocol)) {
    throw new Error(`attestation_protocol ${p.attestation_protocol} is not a known AttestationProtocol`);
  }
  if (p.capability_id !== AA_2) {
    throw new Error(`capability_id must be '${AA_2}' for an AA-2 attestation, got '${p.capability_id}'`);
  }
  for (const fld of AA2_REQUIRED_PAYLOAD_FIELDS) {
    if (!p[fld]) throw new Error(`${fld} is required`);
  }
  return {
    payload: {
      evidence_id: p.evidence_id,
      device_class: p.device_class,
      device_id: p.device_id,
      attestation_protocol: p.attestation_protocol,
      tenant_id: p.tenant_id,
      environment: p.environment,
      attested_at: p.attested_at,
      capability_id: p.capability_id,
      iss: p.iss,
    },
    signature: view.signature,
    kid: view.kid,
    created_at: view.created_at,
  };
}

export type DeviceClassReason =
  | "aa2_schema_missing_field"
  | "aa2_schema_unknown_field"
  | "aa2_signature_invalid"
  | "aa2_unknown_kid"
  | "aa2_unknown_iss"
  | "aa2_capability_not_active"
  | "aa2_device_class_invalid"
  | "aa2_attestation_protocol_invalid"
  | "aa2_protocol_device_mismatch"
  | "aa2_tenant_mismatch"
  | "aa2_time_freshness_violated"
  | "aa2_revocation_check_unavailable";

export type AA2Rule =
  | "schema"
  | "signature"
  | "jwks_resolution"
  | "capability"
  | "device_class"
  | "attestation_protocol"
  | "device_pre_2"
  | "time_freshness"
  | "revocation";

export interface DeviceVerificationResult {
  valid: boolean;
  failingRule?: AA2Rule;
  reason?: DeviceClassReason;
  detail?: string;
}

function fail(rule: AA2Rule, reason: DeviceClassReason, detail: string): DeviceVerificationResult {
  return { valid: false, failingRule: rule, reason, detail };
}

export interface VerifyDeviceAttestationOptions {
  signatureVerifier: SignatureVerifier;
  jwks: JwksResolver;
  boundEvidenceTenant: string;
  boundEvidenceOccurredAt?: string | null;
  freshnessWindowSeconds?: number;
  revocationResolver?: RevocationListResolver | null;
}

/** Mirror of `solo_builder.device_attestation.verify_device_attestation`. */
export function verifyDeviceAttestationRecord(
  record: DeviceAttestationRecord,
  opts: VerifyDeviceAttestationOptions,
): DeviceVerificationResult {
  const {
    signatureVerifier,
    jwks,
    boundEvidenceTenant,
    boundEvidenceOccurredAt = null,
    freshnessWindowSeconds = 300,
    revocationResolver = null,
  } = opts;

  const payloadDict = devicePayloadToDict(record.payload);
  const signatureHex = record.signature;
  const kid = record.kid;

  const iss = payloadDict.iss as string;
  const publicKey = jwks.publicKey(iss, kid);
  if (publicKey === null) {
    return fail("jwks_resolution", "aa2_unknown_kid", `no key for (iss=${iss}, kid=${kid})`);
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = hexToBytes(signatureHex);
  } catch {
    return fail("signature", "aa2_signature_invalid", "signature is not hex-encoded");
  }
  if (!signatureVerifier.verify(canonicalize(payloadDict), signatureBytes, publicKey)) {
    return fail("signature", "aa2_signature_invalid", "signature verification failed");
  }

  const capabilityId = payloadDict.capability_id as string;
  if (capabilityId !== AA_2) {
    return fail("capability", "aa2_capability_not_active", `capability_id must be ${AA_2}, got ${capabilityId}`);
  }
  if (lookupStatus(AA_2) !== ReservationStatus.ACTIVE) {
    return fail("capability", "aa2_capability_not_active", "AA-2 capability not active");
  }

  const deviceClass = payloadDict.device_class as DeviceClass;
  if (!DEVICE_CLASSES.includes(deviceClass)) {
    return fail("device_class", "aa2_device_class_invalid", `device_class ${deviceClass} is not known`);
  }

  const protocol = payloadDict.attestation_protocol as AttestationProtocol;
  if (!ATTESTATION_PROTOCOLS.includes(protocol)) {
    return fail(
      "attestation_protocol",
      "aa2_attestation_protocol_invalid",
      `attestation_protocol ${protocol} is not known`,
    );
  }

  if (!deviceClassMatchesProtocol(deviceClass, protocol)) {
    return fail(
      "device_pre_2",
      "aa2_protocol_device_mismatch",
      `device_class=${deviceClass} is not compatible with attestation_protocol=${protocol}`,
    );
  }

  if ((payloadDict.tenant_id as string) !== boundEvidenceTenant) {
    return fail(
      "device_pre_2",
      "aa2_tenant_mismatch",
      `attestation tenant_id=${payloadDict.tenant_id} != bound evidence tenant=${boundEvidenceTenant}`,
    );
  }

  if (boundEvidenceOccurredAt !== null && boundEvidenceOccurredAt !== undefined) {
    const attestedAt = parseIso(payloadDict.attested_at as string);
    const occurredAt = parseIso(boundEvidenceOccurredAt);
    if (attestedAt === null || occurredAt === null) {
      return fail("time_freshness", "aa2_time_freshness_violated", "timestamp parse failed");
    }
    if (Math.abs(attestedAt - occurredAt) > freshnessWindowSeconds * 1000) {
      return fail("time_freshness", "aa2_time_freshness_violated", "freshness window exceeded");
    }
  }

  if (revocationResolver) {
    const status = revocationResolver.check(kid);
    if (status === "unavailable") {
      return fail("revocation", "aa2_revocation_check_unavailable", `revocation list unavailable for kid=${kid}`);
    }
    if (status === "revoked") {
      return fail("revocation", "aa2_signature_invalid", `kid=${kid} is revoked — signature no longer trusted`);
    }
  }

  return { valid: true };
}
