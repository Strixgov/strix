export const SE_V1_SIGNATURE_ALGORITHM = "Ed25519" as const;
export const EVIDENCE_VERIFICATION_CONTRACT_VERSION = 2 as const;

export type VerificationLayerStatus = "PASS" | "FAIL" | "NOT_PERFORMED" | "NOT_APPLICABLE";
export type EvidenceVerificationStatus = "FULLY_VERIFIED" | "ENVELOPE_VERIFIED" | "LEGACY_UNSIGNED" | "UNAVAILABLE_RUNTIME" | "SIGNING_KEY_UNKNOWN" | "UNSUPPORTED_ALGORITHM" | "INVALID" | "NOT_FOUND";
export interface VerificationCheck { status: VerificationLayerStatus; performed: boolean; valid: boolean | null; reason: string; }
export interface EvidenceVerificationContractV2 {
  contractVersion: 2;
  recordType: "signed_evidence_v1" | "legacy_unsigned_evidence" | "unavailable_runtime_evidence";
  verificationStatus: EvidenceVerificationStatus;
  verificationReason: string;
  checks: {
    keyResolution: VerificationCheck & { keyId: string | null; candidateCount: number | null };
    algorithm: VerificationCheck & { declared: string | null; expected: "Ed25519" };
    signature: VerificationCheck & { present: boolean; algorithm: "Ed25519" | null; keyId: string | null };
    signedEnvelope: VerificationCheck;
    evidenceHashAuthenticated: VerificationCheck;
    evidenceHashValid: VerificationCheck;
    chainLinkAuthenticated: VerificationCheck;
    chainLinkValid: VerificationCheck;
    fullChainValid: VerificationCheck;
  };
}

export function isFullyVerified(contract: EvidenceVerificationContractV2): boolean {
  return contract.verificationStatus === "FULLY_VERIFIED" &&
    contract.checks.keyResolution.status === "PASS" &&
    contract.checks.algorithm.status === "PASS" &&
    contract.checks.signature.status === "PASS" &&
    contract.checks.evidenceHashValid.status === "PASS" &&
    (contract.checks.chainLinkValid.status === "PASS" || contract.checks.chainLinkValid.status === "NOT_APPLICABLE") &&
    contract.checks.fullChainValid.status === "PASS";
}
