/**
 * Refusal receipt — a durable, structured record of an egress attempt that
 * was REFUSED, minted at the moment of refusal.
 *
 * WHY THIS EXISTS. An ALLOWED release was already attributable end to end:
 * `actor` reaches the `egress_authorized` evidence entry, and on the kernel
 * path `actorId` is field 7 of the signed SE v1 payload. A REFUSED attempt
 * produced no durable record of any kind — `prepareDocumentForEgress`
 * returned its DENY one line above where `governDocumentEgress` even reads
 * `input.actor`, and the console route answered 409 having created nothing.
 * So the asymmetry ran backwards for the one thing an operator actually
 * needs it for: refusals are the HIGH-FREQUENCY event and the coachable
 * one, and they were the half with no record. This is the REL-EV-7 pattern
 * (solo-builder-core `release_evidence_log.py`) applied to AI egress: a
 * portable object minted at the refusal, before any side effect could
 * exist — because on this path none ever did.
 *
 * WHAT IT CARRIES, AND THE ONE RULE THAT DECIDES IT: the CATEGORY of what
 * was found, never the VALUE.
 *
 *   PROMPT_CONTAINS_SENSITIVE_DATA + { scope: 'prompt',
 *     categories: ['PATIENT_NAME','MRN'], count: 2 } + actor + destination
 *
 * is coachable — an operator learns which person pasted which KIND of
 * identifier into which instruction — without writing a patient's name into
 * an audit log that is, by design, append-only and forever. The guarantee is
 * STRUCTURAL, not a convention: `RefusalFinding` has no `value` field for a
 * value to travel in, and `normalizeCategories` refuses any category token
 * that is not identifier-shaped rather than passing a replaceable detector's
 * arbitrary string through.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY:
 *
 *  - `detail`. The pipeline's own refusal details interpolate collaborator
 *    error text and may contain caller data; persistence would turn a refusal
 *    record into a second sensitive-data store.
 *  - `filename`. Caller-supplied free text, routinely containing names/MRNs.
 *  - raw `purpose`. Purpose is caller-supplied free text too. The receipt
 *    stores only a SHA-256 commitment so attempts can be correlated without
 *    persisting the value the egress control exists to protect.
 *
 * WHAT IT MAY CARRY ABOUT AN EXTRACTION REFUSAL, AND WHY THAT IS NOT AN
 * EXCEPTION TO THE RULE: `extraction: { engine, stage }`. The stage is a
 * member of the CLOSED `PDF_EXTRACTION_STAGES` set — it names a library, a
 * global, or an asset directory, never a document — and `normalizeExtraction`
 * refuses any other value by mapping it to null. This is the 2026-09-16
 * lesson: a receipt that said only `EXTRACTION_UNAVAILABLE` could not tell an
 * operator whether canvas, PDF.js, the CMaps, the fonts, or the WASM was
 * missing from the deployed function, and the free-text `detail` that could
 * have was (correctly) barred from persistence.
 *
 * HONEST CEILING, carried as a literal FIELD on every receipt: this is an
 * UNSIGNED local record produced by the same process that performed the
 * refusal. It records that THIS process refused; it proves nothing to a third
 * party, and it is not the signed `DecisionEvidence` a kernel-path refusal
 * would mint.
 */
import { createHash, randomBytes } from 'node:crypto';
import { prefixedHash } from '../artifact/hash.mjs';
import { normalizePrincipal } from './principal.mjs';
import { isPdfExtractionStage } from '../artifact/pdf-extraction-stages.mjs';

export const REFUSAL_RECEIPT_PROVES = 'LOCAL_UNSIGNED_REFUSAL_RECORD';

/** Shape every real DETECTION_CATEGORIES member has. */
const CATEGORY_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function normalizeCategories(categories) {
  if (!Array.isArray(categories)) return [];
  const seen = new Set();
  for (const c of categories) {
    seen.add(typeof c === 'string' && CATEGORY_TOKEN.test(c) ? c : 'UNRECOGNIZED_CATEGORY');
  }
  return [...seen].sort();
}

/** `{ scope, categories, count }` — never a value, because there is no field for one. */
function normalizeFinding(finding) {
  if (finding === null || typeof finding !== 'object') return null;
  const scope = finding.scope === 'prompt' || finding.scope === 'document' ? finding.scope : 'unknown';
  const count = Number.isInteger(finding.count) && finding.count >= 0 ? finding.count : null;
  return { scope, categories: normalizeCategories(finding.categories), count };
}

/** `{ engine, stage }` with `stage` from the closed set, else no stage. */
function normalizeExtraction(extraction) {
  if (extraction === null || typeof extraction !== 'object') return null;
  const engine = typeof extraction.engine === 'string' && /^[a-z0-9-]{1,40}$/.test(extraction.engine)
    ? extraction.engine
    : null;
  const stage = isPdfExtractionStage(extraction.stage) ? extraction.stage : null;
  if (engine === null && stage === null) return null;
  return { engine, stage };
}

function purposeCommitment(purpose) {
  if (typeof purpose !== 'string' || purpose.length === 0) return null;
  return `sha256:${createHash('sha256').update(purpose, 'utf8').digest('hex')}`;
}

/**
 * @param {{
 *   capability?: string,
 *   reasonCode: string,
 *   actor?: string | null,
 *   finding?: { scope?: string, categories?: string[], count?: number } | null,
 *   artifact?: object | null,
 *   extraction?: { engine?: string, stage?: string } | null,
 *   destination?: { provider?: string, service?: string } | null,
 *   purpose?: string | null,
 *   policy?: { policyId?: string, policyVersion?: string } | null,
 *   principal?: { authenticationMethod?: string, subject?: string | null, tenantId?: string | null } | null,
 * }} input
 */
export function buildRefusalReceipt({
  capability = 'ai.external.document.send',
  reasonCode,
  actor = null,
  finding = null,
  artifact = null,
  extraction = null,
  destination = null,
  purpose = null,
  policy = null,
  principal = null,
}) {
  const declaredActor = typeof actor === 'string' && actor.length > 0 ? actor : null;
  return {
    receiptId: randomBytes(12).toString('hex'),
    capability,
    decision: 'DENY',
    reasonCode,
    actor: declaredActor,
    // Two axes, never collapsed: what was CLAIMED, then what was PROVED.
    actorAuthentication: declaredActor === null ? 'ABSENT' : 'DECLARED_UNVERIFIED',
    principal: normalizePrincipal(principal),
    finding: normalizeFinding(finding),
    originalArtifactHash: artifact?.originalHash ? prefixedHash(artifact.originalHash) : null,
    classification: artifact?.classification ?? 'unknown',
    extraction: normalizeExtraction(extraction),
    destination: { provider: destination?.provider ?? null, service: destination?.service ?? null },
    purposeCommitment: purposeCommitment(purpose),
    policy: {
      policyId: typeof policy?.policyId === 'string' ? policy.policyId : null,
      policyVersion: typeof policy?.policyVersion === 'string' ? policy.policyVersion : null,
    },
    execution: 'not_attempted',
    disclosureStatus: 'not_disclosed',
    proves: REFUSAL_RECEIPT_PROVES,
    timestamp: new Date().toISOString(),
  };
}
