/**
 * governDocumentEgress — the pre-egress pipeline (spec §1):
 *
 *   ingest → detect → [transform → rescan-verify] → destination policy
 *   → mint payload-bound authorization
 *
 * It produces an AUTHORIZATION and the exact release content; it transmits
 * nothing. Transmission happens only through egress/gate.mjs, which
 * re-derives every hash from the actual outbound bytes.
 *
 * Load-bearing property of the whole design: for PDF/DOCX sources the
 * RELEASED artifact is the EXTRACTED TEXT, never the original bytes — the
 * scan target and the release target are the same string, byte for byte,
 * so content the extractor could not read can never be released unscanned.
 *
 * The PROMPT is governed too, deliberately beyond the spec's §10 matrix:
 * it is scanned with the same detector (findings → DENY, not sanitize —
 * a caller controls its own prompt and can rephrase; silently rewriting an
 * instruction to a model is a different risk than rewriting a document),
 * and its hash is bound into the authorization so a post-authorization
 * prompt swap refuses at the gate. Without this, the prompt would be a
 * second, ungoverned channel to the same destination.
 *
 * Every failure is a NAMED refusal and every refusal is fail-closed:
 * detector/transformer/verifier failure, unsupported artifact, unknown
 * classification, policy-ineligible destination — nothing falls through to
 * a permissive branch.
 */
import { randomBytes } from 'node:crypto';
import { ingestArtifact } from './artifact/ingest.mjs';
import { sha256Hex, prefixedHash } from './artifact/hash.mjs';
import { validateEgressPolicy, decideDestination, PolicyValidationError, categoryAction, replacementMode } from './policy/policy.mjs';
import { createSyntheticTransformer } from './transformation/synthetic-transformer.mjs';
import { verifySanitizedArtifact, VERIFICATION_PROVES } from './verification/verify.mjs';
import { mintEgressAuthorization } from './authorization/authorize.mjs';
import { buildRefusalReceipt } from './evidence/refusal-receipt.mjs';
import { runSignals, validateSignals, coversAll, DetectionSignalError } from './detection/signals.mjs';
import { buildReidentificationKey } from './reidentification/reidentify.mjs';

/**
 * The refusal codes THIS module raises as literals, as a closed set.
 *
 * Declared here, beside the `deny(...)` calls, and pinned by a source scan in
 * `test/pipeline-deny-codes.test.mjs` that re-derives the set from this file
 * — never hand-maintained against memory. A consumer that needs to prove it
 * has customer-facing language for every refusal must be able to ENUMERATE
 * them; before this export the console's own completeness check listed the
 * ingest and policy codes under the name `PIPELINE_REFUSAL_CODES` and so
 * demanded a translation for none of the nine below.
 *
 * Deliberately NOT included: the codes this module re-raises from another
 * module (`ingest.reasonCode`, `decideDestination`'s `decision.reasonCode`,
 * and `PolicyValidationError.reasonCode`). Those belong to the modules that
 * define them, and folding them in here would make this set claim ownership
 * of vocabulary it does not control.
 */
export const PIPELINE_DENY_CODES = Object.freeze([
  'CATEGORY_BLOCKED_BY_POLICY',
  'DETECTION_SIGNAL_NOT_APPLIED',
  'DETECTOR_UNAVAILABLE',
  'EVIDENCE_UNAVAILABLE',
  'OBFUSCATED_SENSITIVE_DATA',
  'PHI_EGRESS_DENIED_BY_POLICY',
  'PROMPT_CONTAINS_SENSITIVE_DATA',
  'PROMPT_REQUIRED',
  'PURPOSE_REQUIRED',
  'SYNTHETIC_REPLACEMENT_LOCAL_ONLY',
  'TRANSFORMER_UNAVAILABLE',
  'VERIFICATION_FAILED',
]);

/**
 * `finding` is the STRUCTURED half of a refusal: `{scope, categories, count}`
 * and never a value. It exists so `attachRefusalReceipt` can record WHAT KIND
 * of identifier was found without reading `detail`, which interpolates
 * collaborator error text and must never be persisted (see
 * evidence/refusal-receipt.mjs). Sites with no category information pass
 * nothing and the receipt honestly carries `finding: null`.
 */
function deny(reasonCode, detail, artifact = null, finding = null) {
  return { outcome: 'DENY', reasonCode, detail, artifact, finding };
}

/** Multiset of findings keyed by (category, NFKC-lowercased value). */
function findingCounts(detection) {
  const counts = new Map();
  for (const f of detection?.findings ?? []) {
    if (typeof f?.value !== 'string' || typeof f?.category !== 'string') continue;
    // JSON-tuple key, never a delimiter join: a raw separator byte both
    // collides on boundary shifts and, as a literal NUL, makes grep read
    // this FILE as binary and skip it in every text-based source-scan lint
    // (the client-profile 360's store.ts finding, re-made here and caught).
    const key = JSON.stringify([f.category, f.value.normalize('NFKC').toLowerCase()]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Does scanning the NFKC-normalized text reveal findings the raw scan did
 * not account for? Compared as per-(category, normalized value) COUNTS, not
 * sets — a document carrying one ASCII SSN and one full-width copy of the
 * SAME number normalizes both to one value, and a set comparison would read
 * the pair as "already accounted for" while the transformer rewrites only
 * the ASCII occurrence (360 probe B's sharpest variant).
 *
 * Only a REVEAL refuses. A benign non-NFKC-stable document (PDF extraction
 * routinely yields ligatures — "ﬁnal", "ﬂuid") whose normalized scan finds
 * nothing the raw scan didn't still sanitizes normally; a blanket
 * refuse-on-any-normalization rule would make ordinary clinical PDFs
 * undeliverable, and over-refusal teaches operators to route around the
 * control (the LRCM verify-costs-you lesson).
 */
function normalizationRevealsFindings(rawDetection, nfkcDetection) {
  const rawCounts = findingCounts(rawDetection);
  for (const [key, count] of findingCounts(nfkcDetection)) {
    if (count > (rawCounts.get(key) ?? 0)) return true;
  }
  return false;
}

/**
 * prepareDocumentForEgress — steps 1 through 5, and DELIBERATELY NOT 6.
 *
 * This is the whole pipeline except the act of authorizing: ingest, detect,
 * the NFKC reveal check, the prompt scan, transform, the mandatory rescan,
 * and the destination-policy decision. It mints nothing and appends no
 * evidence, so calling it grants no authority and leaves no spendable state
 * behind — which is exactly what makes it safe to call from a route that
 * will then ask the KERNEL to authorize.
 *
 * WHY IT WAS EXTRACTED. Local mode (`governDocumentEgress`) and kernel mode
 * (the Phase-B propose route) must not have two detection paths. If they
 * did, the property this package sells — prohibited data cannot cross the
 * boundary — would hold to whatever degree the two implementations happened
 * to agree, and drift between them would be invisible until a release. So
 * the two modes differ in exactly ONE respect: who authorizes. Everything
 * that decides what may be released is this function, called by both.
 *
 * @param {{
 *   source: { text?: string, bytes?: Buffer, mimeType?: string, filename?: string },
 *   prompt: string,
 *   destination: { provider: string, service: string },
 *   purpose: string,
 *   policy: object,
 *   deps: {
 *     detector: { scan(text) },
 *     transformer: { transform(text, detection) },
 *     verifierDetector?: { scan(text) },   // independent second detector; defaults to `detector`
 *   },
 * }} input
 * @returns {Promise<{outcome:'DENY',reasonCode:string,detail:string,artifact:object|null}
 *   | {outcome:'PREPARED', artifact:object, releaseText:string, prompt:string,
 *      policy:object, destination:object, purpose:string, detection:object,
 *      transformation:object|null, sanitized:boolean}>}
 */
async function prepareDocumentForEgressInner(input, { localMode = false } = {}) {
  const { source, prompt, destination, purpose, deps } = input;
  const { detector, transformer } = deps;
  const verifierDetector = deps.verifierDetector ?? detector;

  // The boundary enforces the policy it VALIDATED: `policy` from here on is
  // the immutable snapshot validateEgressPolicy returns, never the caller's
  // live object. Every decision read below (phi.action, decideDestination)
  // happens AFTER awaiting caller-injected deps, and a dep that mutated the
  // live object mid-flight could otherwise launder `deny` into `sanitize`
  // between validation and enforcement (360 probe A — red-proven).
  let policy;
  try {
    policy = validateEgressPolicy(input.policy);
  } catch (err) {
    if (err instanceof PolicyValidationError) {
      return deny(err.reasonCode, err.message);
    }
    throw err;
  }

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return deny('PROMPT_REQUIRED', 'a non-empty prompt is required');
  }
  if (typeof purpose !== 'string' || purpose.trim().length === 0) {
    return deny('PURPOSE_REQUIRED', 'a non-empty purpose is required');
  }

  // 1. Local ingestion — fail-closed on anything unreadable (spec §13).
  const ingest = ingestArtifact(source);
  if (!ingest.ok) {
    return deny(ingest.reasonCode, ingest.detail);
  }

  const artifact = {
    artifactId: randomBytes(12).toString('hex'),
    originalHash: ingest.originalHash,
    mimeType: ingest.mimeType,
    sizeBytes: ingest.sizeBytes,
    filename: typeof source.filename === 'string' ? source.filename : undefined,
    classification: 'unknown',
    verification: { status: 'pending' },
  };

  // 1b. Detection signals (optional, stricter-only). A signal proposes spans
  // and decides nothing; its spans become seeds for the detector. Any failure
  // refuses: detector-only is a different policy pack, never a quiet fallback.
  const signals = deps.signals ?? [];
  let documentSeeds = [];
  let promptSignals = null;
  if (signals.length > 0) {
    try {
      validateSignals(signals);
      if (detector.acceptsSeeds !== true) {
        throw new DetectionSignalError('DETECTION_SIGNAL_NOT_APPLIED', 'the configured detector does not accept signal seeds');
      }
      const doc = await runSignals(signals, ingest.text, { timeoutMs: deps.signalTimeoutMs });
      documentSeeds = doc.seeds;
      promptSignals = typeof prompt === 'string' ? await runSignals(signals, prompt, { timeoutMs: deps.signalTimeoutMs }) : null;
      artifact.detectionSignals = doc.reports.map((r, i) => ({
        ...r,
        promptProposed: promptSignals?.reports[i]?.proposed ?? 0,
        promptAccepted: promptSignals?.reports[i]?.accepted ?? 0,
      }));
    } catch (err) {
      if (err instanceof DetectionSignalError) return deny(err.reasonCode, err.message, artifact);
      throw err;
    }
  }

  // 2. Sensitive-data detection over the document — detector failure is a
  // refusal, never a pass (spec §10: detector fails → DENY, fail closed).
  // `plainDetection` is the unseeded scan; the NFKC reveal check below uses
  // it, so extra seeded findings can never mask a reveal.
  let plainDetection;
  let detection;
  try {
    plainDetection = await detector.scan(ingest.text);
    detection = documentSeeds.length > 0
      ? await detector.scan(ingest.text, { seeds: documentSeeds })
      : plainDetection;
  } catch (err) {
    return deny('DETECTOR_UNAVAILABLE', `document scan failed: ${err?.message}`, artifact);
  }
  // The seeded scan must cover every seed AND every unseeded finding. A
  // detector that ignored the seeds, or dropped a finding when seeded, would
  // otherwise turn a stricter-only signal into a weaker scan.
  if (documentSeeds.length > 0
      && (!coversAll(detection, documentSeeds) || !coversAll(detection, plainDetection.findings ?? []))) {
    return deny('DETECTION_SIGNAL_NOT_APPLIED', 'the seeded scan does not cover the signal seeds and the unseeded findings', artifact);
  }

  // 2b. Unicode-obfuscation reveal check. The v0.1 detector matches ASCII
  // shapes, so identifiers written in NFKC-normalizable lookalikes
  // (full-width digits: ＳＳＮ １２３-４５-６７８９) walk straight past it —
  // proven by probe, not assumed. The boundary (not the replaceable
  // detector) therefore scans the NORMALIZED text with the same configured
  // detector, and any finding normalization REVEALS is a named refusal:
  // never a sanitize, because normalized-text offsets cannot be safely
  // mapped back onto the raw text the transformer rewrites, and a
  // misaligned rewrite would release partially-untransformed content.
  const nfkcText = ingest.text.normalize('NFKC');
  if (nfkcText !== ingest.text) {
    let nfkcDetection;
    try {
      nfkcDetection = await detector.scan(nfkcText);
    } catch (err) {
      return deny('DETECTOR_UNAVAILABLE', `normalized-form scan failed: ${err?.message}`, artifact);
    }
    if (normalizationRevealsFindings(plainDetection, nfkcDetection)) {
      artifact.classification = 'phi_detected';
      return deny(
        'OBFUSCATED_SENSITIVE_DATA',
        'unicode normalization (NFKC) reveals detector findings the raw scan did not — obfuscated identifiers cannot be safely transformed, so the artifact is refused outright',
        artifact,
        { scope: 'document', categories: nfkcDetection.categories, count: nfkcDetection.findingsCount },
      );
    }
  }

  // 3. Prompt scan with the same fail-closed posture — over the raw prompt
  // AND, when it differs, its NFKC form (a prompt is refused on ANY finding,
  // so no reveal comparison is needed here).
  let promptScan;
  try {
    promptScan = promptSignals && promptSignals.seeds.length > 0
      ? await detector.scan(prompt, { seeds: promptSignals.seeds })
      : await detector.scan(prompt);
    const nfkcPrompt = prompt.normalize('NFKC');
    if (!promptScan.detected && nfkcPrompt !== prompt) {
      promptScan = await detector.scan(nfkcPrompt);
    }
  } catch (err) {
    return deny('DETECTOR_UNAVAILABLE', `prompt scan failed: ${err?.message}`, artifact);
  }
  if (promptScan.detected) {
    return deny(
      'PROMPT_CONTAINS_SENSITIVE_DATA',
      `the prompt itself carries ${promptScan.findingsCount} detector finding(s) (${promptScan.categories.join(', ')}) — rephrase without identifiers`,
      artifact,
      { scope: 'prompt', categories: promptScan.categories, count: promptScan.findingsCount },
    );
  }

  // 4. Classification + (when needed) transformation and mandatory rescan.
  let releaseText;
  let transformation = null;
  // The caller-held key (token → original value). Deliberately NOT on
  // `artifact`, which reaches evidence and UI; see reidentification/.
  let reidentification = null;
  if (!detection.detected) {
    artifact.classification = 'clear';
    releaseText = ingest.text;
    // The detector scan above ran over these exact bytes; record it as the
    // verification of record for the ALLOW path.
    artifact.verification = {
      status: 'passed',
      scannedHash: sha256Hex(releaseText),
      remainingProhibitedFindings: 0,
      proves: VERIFICATION_PROVES,
    };
  } else {
    artifact.classification = 'phi_detected';
    const phiAction = policy.dataEgress.externalAI.phi.action;
    if (phiAction === 'deny') {
      return deny(
        'PHI_EGRESS_DENIED_BY_POLICY',
        'policy denies PHI-bearing documents outright',
        artifact,
        { scope: 'document', categories: detection.categories, count: detection.findingsCount },
      );
    }

    // Per-category actions: `block` refuses the document before anything is
    // transformed; `flag` tokenizes and marks the release for review.
    const blocked = detection.categories.filter((c) => categoryAction(policy, c) === 'block').sort();
    if (blocked.length > 0) {
      const count = detection.findings.filter((f) => blocked.includes(f.category)).length;
      return deny(
        'CATEGORY_BLOCKED_BY_POLICY',
        `policy blocks documents containing ${blocked.join(', ')}`,
        artifact,
        { scope: 'document', categories: blocked, count },
      );
    }
    const flagged = detection.categories.filter((c) => categoryAction(policy, c) === 'flag').sort();
    if (flagged.length > 0) artifact.flaggedCategories = flagged;

    // Synthetic replacement is local mode only. The kernel's execute route
    // re-runs the rescan over caller-supplied material with no mask (it
    // cannot trust a caller to report generated spans), so a synthetic
    // release would be refused there after its approvals were spent.
    // Refuse here instead, before anything is decided.
    const synthetic = replacementMode(policy) === 'synthetic';
    if (synthetic && !localMode) {
      return deny(
        'SYNTHETIC_REPLACEMENT_LOCAL_ONLY',
        'synthetic replacement is available in local mode only; the kernel release path requires tokens',
        artifact,
      );
    }
    const activeTransformer = synthetic ? (deps.syntheticTransformer ?? createSyntheticTransformer()) : transformer;

    let transformed;
    try {
      transformed = await activeTransformer.transform(ingest.text, detection);
    } catch (err) {
      return deny('TRANSFORMER_UNAVAILABLE', `transformation failed: ${err?.message}`, artifact);
    }
    let maskedSpans;
    if (synthetic) {
      if (!Array.isArray(transformed?.insertedSpans)) {
        return deny('TRANSFORMER_UNAVAILABLE', 'the synthetic replacer did not report its inserted spans', artifact);
      }
      maskedSpans = transformed.insertedSpans.filter((sp) => sp?.kind === 'synthetic');
    }

    let verification;
    try {
      verification = await verifySanitizedArtifact({
        text: transformed.text,
        originalFindings: detection.findings,
        detector: verifierDetector,
        ...(maskedSpans ? { maskedSpans } : {}),
      });
    } catch (err) {
      return deny('DETECTOR_UNAVAILABLE', `post-transform verification scan failed: ${err?.message}`, artifact);
    }

    artifact.sanitizedHash = verification.scannedHash;
    artifact.transformation = {
      engine: transformed.engine,
      version: transformed.version,
      detectedCount: transformed.detectedCount,
      transformedCount: transformed.transformedCount,
      mappings: transformed.mappings,
    };
    artifact.verification = verification;

    if (verification.status !== 'passed') {
      return deny(
        'VERIFICATION_FAILED',
        `post-transform rescan found ${verification.remainingProhibitedFindings} remaining finding(s) and ${verification.residualValueFindings} residual original value(s)`,
        artifact,
        { scope: 'document', categories: verification.rescan.categories, count: verification.rescan.findingsCount },
      );
    }
    artifact.classification = 'deidentified';
    releaseText = transformed.text;
    transformation = artifact.transformation;
    reidentification = buildReidentificationKey(transformed, releaseText);
  }

  // 5. Destination policy — classification × destination, default deny.
  let decision;
  try {
    decision = decideDestination({ classification: artifact.classification, destination, policy });
  } catch (err) {
    if (err instanceof PolicyValidationError) {
      return deny(err.reasonCode, err.message, artifact);
    }
    throw err;
  }
  if (!decision.eligible) {
    return deny(decision.reasonCode, decision.detail, artifact);
  }

  // The preparation phase ends here. Everything above decided WHAT may be
  // released; nothing above decided THAT it may be — that is the caller's
  // authorization mechanism, and there are exactly two (local mint below,
  // or a Strix kernel decision).
  return {
    outcome: 'PREPARED',
    artifact,
    releaseText,
    prompt,
    policy,
    destination,
    purpose,
    detection,
    transformation,
    reidentification,
    sanitized: detection.detected,
  };
}

/**
 * Mint the refusal receipt for a DENY and, when the caller supplied an
 * evidence log, append it — then hand the refusal back UNCHANGED except for
 * the added `receipt`.
 *
 * FAIL-OPEN, DELIBERATELY, AND THIS IS THE OPPOSITE OF THE ALLOW PATH. When
 * `governDocumentEgress` cannot write its authorization evidence it BURNS
 * the authorization and refuses (`EVIDENCE_UNAVAILABLE`), because there the
 * failure would leave spendable authority no record precedes. Here there is
 * no authority and no side effect to escalate to — the strictest available
 * outcome is the DENY we already have. So a receipt that cannot be built or
 * appended must never convert a refusal into anything else, and never into
 * a DIFFERENT refusal either: swapping the operator's real reason code for
 * `EVIDENCE_UNAVAILABLE` would hide the finding that actually stopped the
 * release behind an infrastructure complaint.
 *
 * Every field is read individually from named inputs — the caller's objects
 * are never spread into the entry, which is what keeps the evidence log's
 * no-PHI constraint a property of construction rather than of review.
 */
function attachRefusalReceipt(prepared, input) {
  let receipt = null;
  try {
    receipt = buildRefusalReceipt({
      reasonCode: prepared.reasonCode,
      actor: input.actor ?? null,
      // What the CREDENTIAL proved, as opposed to what the caller declared.
      // Read here for the same reason `actor` is: the deciding half must be
      // provably independent of who the caller is, and a principal that
      // could reach it is a principal that could change the verdict.
      principal: input.principal ?? null,
      finding: prepared.finding ?? null,
      artifact: prepared.artifact ?? null,
      destination: input.destination ?? null,
      purpose: input.purpose ?? null,
      policy: input.policy ?? null,
    });
  } catch {
    return prepared;
  }

  const evidence = input.deps?.evidence;
  if (evidence && typeof evidence.append === 'function') {
    try {
      evidence.append({
        type: 'egress_refused',
        receiptId: receipt.receiptId,
        reasonCode: receipt.reasonCode,
        actor: receipt.actor,
        actorAuthentication: receipt.actorAuthentication,
        // Flattened rather than nested so the log entry stays one level of
        // named scalars — every field read individually, nothing spread.
        principalMethod: receipt.principal.authenticationMethod,
        principalIdentifies: receipt.principal.identifies,
        principalIdentifiesPerson: receipt.principal.identifiesPerson,
        principalSubject: receipt.principal.subject,
        principalTenantId: receipt.principal.tenantId,
        finding: receipt.finding,
        originalArtifactHash: receipt.originalArtifactHash,
        classification: receipt.classification,
        destination: receipt.destination,
        purpose: receipt.purpose,
        policyId: receipt.policy.policyId,
        policyVersion: receipt.policy.policyVersion,
        execution: receipt.execution,
        disclosureStatus: receipt.disclosureStatus,
      });
    } catch (err) {
      // Loud, and non-fatal. The refusal stands on its own.
      // eslint-disable-next-line no-console
      console.error('[governed-egress] refusal evidence write failed:', err?.message);
    }
  }

  return { ...prepared, receipt };
}

/**
 * prepareDocumentForEgress — the pipeline (see `prepareDocumentForEgressInner`)
 * plus the refusal receipt.
 *
 * THE SPLIT IS THE POINT. The inner function decides; this one records what
 * it decided. `input.actor` and `input.principal` are read HERE and nowhere
 * inside, so a refusal can name both who attempted it and under which
 * verified credential, while the decision itself remains provably
 * independent of both — pinned by a source scan, because an identity that
 * could reach the decision path is an identity that could change it. That
 * matters more for the principal than for the declaration: a boundary that
 * let an authenticated credential influence the verdict would have built
 * exactly the privileged bypass this control exists to deny.
 */
export async function prepareDocumentForEgress(input) {
  return prepareWithMode(input, { localMode: false });
}

// The mode is chosen by which entry point is called, never by an input field.
async function prepareWithMode(input, mode) {
  const prepared = await prepareDocumentForEgressInner(input, mode);
  if (prepared.outcome !== 'DENY') return prepared;
  return attachRefusalReceipt(prepared, input);
}

/**
 * governDocumentEgress — LOCAL MODE: prepare, then mint this package's own
 * payload-bound single-use authorization.
 *
 * Unchanged in behavior from v0.1. On the KERNEL path this function is not
 * called at all: `production-binding.mjs` translates a redeemed Strix
 * decision into the gate's authority instead, and neither it nor the kernel
 * gate imports `authorize.mjs`. Two mechanisms that can each permit an
 * egress would be the parallel authorization system the Gate-D scope law
 * forbids, so the choice is made once, by which entry point a caller uses,
 * and never by a flag inside the pipeline.
 *
 * @param {{
 *   source: object, prompt: string, destination: object, purpose: string,
 *   policy: object, actor?: string,
 *   deps: {
 *     detector: { scan(text) },
 *     transformer: { transform(text, detection) },
 *     verifierDetector?: { scan(text) },
 *     store: object,                        // authorization store
 *     evidence: { append(entry) },
 *     ttlMs?: number,
 *     now?: () => number,
 *   },
 * }} input
 */
export async function governDocumentEgress(input) {
  const prepared = await prepareWithMode(input, { localMode: true });
  if (prepared.outcome === 'DENY') return prepared;

  const { actor, deps } = input;
  const { store, evidence } = deps;
  const { artifact, releaseText, prompt, policy, destination, purpose, detection, transformation } = prepared;

  // 6. Mint the payload-bound, single-use authorization.
  const releaseHash = sha256Hex(releaseText);
  const promptHash = sha256Hex(prompt);
  const authorization = mintEgressAuthorization({
    store,
    artifactHash: releaseHash,
    promptHash,
    destination,
    purpose,
    ttlMs: deps.ttlMs,
    now: deps.now,
  });

  // The authorization record is written in the same step the authorization
  // is minted; if the write fails, the just-minted authorization is BURNED
  // (claimed) before refusing, so no spendable authority exists that no
  // evidence entry precedes.
  const authorizedEntry = {
    type: 'egress_authorized',
    artifactId: artifact.artifactId,
    actor: actor ?? null,
    originalArtifactHash: prefixedHash(artifact.originalHash),
    releasedArtifactHash: prefixedHash(releaseHash),
    promptHash: prefixedHash(promptHash),
    initialClassification: detection.detected ? 'phi_detected' : 'clear',
    classification: artifact.classification,
    detector: detection.detector,
    ...(artifact.detectionSignals ? { detectionSignals: artifact.detectionSignals } : {}),
    detectedCategories: detection.categories,
    detectedCount: detection.findingsCount,
    ...(artifact.flaggedCategories ? { flaggedCategories: artifact.flaggedCategories } : {}),
    ...(transformation
      ? {
          transformation: {
            engine: transformation.engine,
            version: transformation.version,
            detectedCount: transformation.detectedCount,
            transformedCount: transformation.transformedCount,
          },
        }
      : {}),
    verification: {
      result: artifact.verification.status,
      remainingProhibitedFindings: artifact.verification.remainingProhibitedFindings ?? 0,
      proves: artifact.verification.proves,
    },
    destination: { provider: destination.provider, service: destination.service },
    purpose,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    authorizationId: authorization.authorizationId,
    authorizationBinding: prefixedHash(authorization.binding),
  };
  try {
    evidence.append(authorizedEntry);
  } catch (err) {
    store.claim(authorization.authorizationId, new Date().toISOString());
    // The one refusal raised OUTSIDE the prepare phase, so it does not
    // inherit the wrapper's receipt and mints its own. The evidence log is
    // the thing that just failed, so `attachRefusalReceipt`'s append attempt
    // will very likely fail too — which is exactly why that append is
    // non-fatal: the caller still receives a refusal carrying the reason,
    // the actor, and the voided authorization's artifact.
    return attachRefusalReceipt(
      deny(
        'EVIDENCE_UNAVAILABLE',
        `authorization evidence could not be written (${err?.message}); the minted authorization was voided`,
        artifact,
      ),
      input,
    );
  }

  return {
    outcome: detection.detected ? 'SANITIZE' : 'ALLOW',
    artifact,
    releaseText,
    prompt,
    authorization,
    reidentification: prepared.reidentification ?? null,
  };
}
