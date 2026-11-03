/**
 * Proof receipt for a governed egress operation (spec §11).
 *
 * Constructed field-by-field from hashes, counts, categories, verdicts and
 * identifiers — never from document text, finding values, or prompts (the
 * spec's "no PHI in the receipt" constraint, proven by
 * test/evidence-no-phi.test.mjs).
 *
 * HONEST CEILING, stated here because a receipt is the surface most likely
 * to be over-read: a v0.1 receipt is an UNSIGNED local record produced by
 * the same process that performed the release. It identifies the artifact,
 * policy, decision, destination and outcome; it does not prove them to a
 * third party. Signing (binding into Strix's Ed25519 DecisionEvidence via
 * the kernel) is the named Phase-B integration — see README §Phase B.
 */
import { randomBytes } from 'node:crypto';
import { prefixedHash } from '../artifact/hash.mjs';

export const RECEIPT_PROVES = 'LOCAL_UNSIGNED_RECORD';

export function buildEgressReceipt({
  capability = 'ai.external.document.send',
  decision,
  reasonCode = null,
  actor = null,
  artifact,
  promptHash = null,
  transformation = null,
  verification = null,
  destination,
  authorizationBinding = null,
  execution,
  disclosureStatus,
  detector = null,
  policy,
}) {
  return {
    receiptId: randomBytes(12).toString('hex'),
    capability,
    decision,
    ...(reasonCode ? { reasonCode } : {}),
    actor,
    originalArtifactHash: artifact?.originalHash ? prefixedHash(artifact.originalHash) : null,
    releasedArtifactHash: artifact?.sanitizedHash
      ? prefixedHash(artifact.sanitizedHash)
      : artifact?.verification?.scannedHash
        ? prefixedHash(artifact.verification.scannedHash)
        : null,
    promptHash,
    initialClassification: artifact?.classification === 'deidentified' ? 'phi_detected' : artifact?.classification ?? 'unknown',
    classification: artifact?.classification ?? 'unknown',
    ...(transformation
      ? {
          transformation: {
            result: 'deidentified',
            engine: transformation.engine,
            version: transformation.version,
            findings: transformation.detectedCount,
            transformed: transformation.transformedCount,
          },
        }
      : {}),
    ...(verification
      ? {
          verification: {
            result: verification.status,
            remainingProhibitedFindings: verification.remainingProhibitedFindings ?? 0,
            proves: verification.proves,
          },
        }
      : {}),
    ...(detector ? { detector: { name: detector.name, version: detector.version } } : {}),
    destination: { provider: destination?.provider ?? null, service: destination?.service ?? null },
    authorizationBinding,
    execution,
    disclosureStatus,
    policy: { policyId: policy?.policyId ?? null, policyVersion: policy?.policyVersion ?? null },
    proves: RECEIPT_PROVES,
    timestamp: new Date().toISOString(),
  };
}
