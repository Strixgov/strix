/**
 * Type declarations for the AA-2 (Device Attestation v1) verifier.
 *
 * Hand-written rather than generated: the module is dependency-free ESM whose
 * runtime behaviour is pinned by the 15-vector conformance corpus, and adding
 * a build step to a package whose whole value is "you can read every line of
 * it" would be the wrong trade. These declarations describe the surface a
 * TypeScript consumer uses; the corpus is what proves the surface behaves.
 */

export type DeviceClass = 'browser' | 'mobile_ios' | 'mobile_android';
export type AttestationProtocol =
  | 'webauthn'
  | 'app_attest_ios'
  | 'play_integrity_android';

export interface DeviceAttestationRecord {
  payload: Record<string, unknown>;
  kid: string;
  signature: string;
  created_at?: string;
}

export interface DeviceAttestationVerification {
  /** `true`, `false`, or `null` — null means COULD NOT CHECK, never checked-and-wrong. */
  valid: boolean | null;
  failingRule: string | null;
  reason: string | null;
}

export interface DeviceClassBlock {
  attested: boolean;
  verified: boolean | null;
  reason: string | null;
  deviceClass: DeviceClass | null;
  attestationProtocol: AttestationProtocol | null;
}

export interface VerifyDeviceAttestationDeps {
  signatureVerifier?: (
    payloadBytes: Uint8Array,
    signatureBytes: Uint8Array,
    publicKeyBytes: Uint8Array,
  ) => boolean;
  jwks?: unknown;
  boundEvidenceTenant?: string;
  boundEvidenceOccurredAt?: string | null;
  freshnessWindowSeconds?: number;
  deviceRevocationResolver?: ((deviceId: string) => string) | null;
  /** Defaults to 'reserved' — the fail-closed capability gate. */
  capabilityStatus?: 'reserved' | 'active' | 'retired';
}

export declare const DEVICE_CLASS: Readonly<Record<string, DeviceClass>>;
export declare const ATTESTATION_PROTOCOL: Readonly<Record<string, AttestationProtocol>>;
export declare const VERIFIER_RULE: Readonly<Record<string, string>>;
export declare const DEVICE_CLASS_REASON: Readonly<Record<string, string>>;
export declare const DEVICE_REVOCATION_STATUS: Readonly<Record<string, string>>;
export declare const REQUIRED_PAYLOAD_FIELDS: readonly string[];
export declare const AA_2: string;
export declare const VALID_DEVICE_PROTOCOL_PAIRS: readonly (readonly [DeviceClass, AttestationProtocol])[];
export declare const SUBSTRATE_ERROR_REASONS: readonly string[];

export declare function deviceClassMatchesProtocol(
  deviceClass: string,
  attestationProtocol: string,
): boolean;
export declare function canonicalPayloadBytes(payload: unknown): Uint8Array;
export declare function payloadHash(payload: unknown): string;
export declare function buildDeviceAttestationPayload(input: Record<string, unknown>): Record<string, unknown>;
export declare function verifyDeviceAttestation(
  record: DeviceAttestationRecord,
  deps?: VerifyDeviceAttestationDeps,
): DeviceAttestationVerification;
export declare function ed25519SignatureVerifier(
  payloadBytes: Uint8Array,
  signatureBytes: Uint8Array,
  publicKeyBytes: Uint8Array,
): boolean;
export declare function renderDeviceClassBlock(
  attestationRecord: DeviceAttestationRecord | null | undefined,
  verification: DeviceAttestationVerification | null | undefined,
): DeviceClassBlock;
