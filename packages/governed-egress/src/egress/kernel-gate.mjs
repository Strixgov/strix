/**
 * THE POINT-OF-USE GATE, under Strix kernel authority.
 *
 * This is the choke point. It takes signed authority (a redeemed Strix
 * decision, translated by production-binding.mjs) plus the ACTUAL outbound
 * material, RECONSTRUCTS the canonical egress commitment from that material
 * itself, and refuses unless the reconstruction equals the commitment the
 * decision froze.
 *
 * The property is not "the gate checks a hash". It is WHAT THE GATE REFUSES
 * TO BE TOLD. Four things a caller might assert, and where each actually
 * comes from instead:
 *
 *   "verified: true"        → the gate RE-RUNS the second scan over the
 *                             exact bytes it is about to transmit. A
 *                             caller's verification claim is not an input;
 *                             there is no parameter to put it in.
 *   "artifactHash: …"       → recomputed here from the bytes themselves.
 *   "classification: …"     → read from the redeemed decision's frozen
 *                             actionParams, never from the call.
 *   "destination: anthropic"→ read from the ADAPTER'S OWN identity. The
 *                             adapter that will make the call declares
 *                             where it sends; a caller naming a destination
 *                             would be describing a route it does not
 *                             control.
 *
 * So the signature takes exactly `authority`, `material`, and collaborators
 * (adapter, detector, evidence, consume). There is deliberately no options
 * bag, no overrides argument, and no field a caller can use to tell the gate
 * something the gate can determine for itself — the absence is the control,
 * and a test pins that the parameter names for those four assertions do not
 * appear in this file's own input surface.
 *
 * THE RESOLVED ENDPOINT IS RECORDED, NEVER ASSERTED. `adapter.destination`
 * (provider/service) is a label a caller composes; it is not compared
 * anywhere to `adapter.endpoint.baseUrl`, the actual host the transport is
 * configured to reach — so a signed record could say "provider: anthropic"
 * while a misconfigured transport spoke to a different host and nothing
 * would ever disagree. The gate cannot fix that by REJECTING a mismatch —
 * there is no independent source of truth for "the correct host" to compare
 * against here, and inventing one would be a policy decision this file does
 * not own. What it CAN do, and does, is stop treating the label as if it
 * were the fact: `adapter.endpoint` (when the transport offers one) rides
 * every evidence entry this gate writes, additively and unhashed — never
 * inside the commitment, which is frozen at EVALUATED and would need a new
 * canon version to add a field — so an operator reading the evidence log
 * can see the real destination next to the asserted one instead of only the
 * asserted one.
 *
 * ORDERING, unchanged from the v0.1 gate and load-bearing:
 *   reconstruct → compare → consume authority atomically → write attempt
 *   evidence → transport. A refusal at any step provably precedes the
 *   transport, and every refusal path returns execution 'not_attempted'.
 *
 * A COMMITMENT MISMATCH NAMES THE FIELD. A bare "hash mismatch" is
 * unactionable and, worse, indistinguishable from a policy-version bump; the
 * diverging field names are hashes, classifications, policy ids and
 * destinations — never document content — so reporting them leaks nothing
 * and turns a refusal into a diagnosis.
 */
import { sha256Hex } from '../artifact/hash.mjs';
import { verifySanitizedArtifact } from '../verification/verify.mjs';
import {
  assembleEgressCommitment,
  canonicalizeEgressCommitment,
  EGRESS_COMMITMENT_CANON,
  EGRESS_COMMITMENT_FIELDS,
} from '../commitment/egress-commitment.mjs';

export const KERNEL_EGRESS_REFUSAL_CODES = Object.freeze([
  'AUTHORITY_REQUIRED',
  'AUTHORITY_CANON_UNSUPPORTED',
  'VERIFICATION_UNAVAILABLE',
  'COMMITMENT_UNCONSTRUCTIBLE',
  'COMMITMENT_MISMATCH',
  'AUTHORITY_CONSUMED',
  'EVIDENCE_UNAVAILABLE',
]);

function refusal(reasonCode, detail, extra = {}) {
  return {
    released: false,
    decision: 'DENY',
    reasonCode,
    detail,
    execution: 'not_attempted',
    disclosureStatus: 'not_disclosed',
    ...extra,
  };
}

function disclosureStatusFor(execution, errorKind) {
  if (execution === 'completed') return 'disclosed';
  if (errorKind === 'http') return 'disclosed';
  if (errorKind === 'unconfigured') return 'not_disclosed';
  return 'possibly_disclosed';
}

/**
 * `adapter.endpoint` when present, else nothing — spread into an evidence
 * entry. `endpoint` is OPTIONAL on the transport contract (a relay or test
 * double may not have one), so absence here means "unknown", never "safe".
 */
function endpointFields(adapter) {
  return adapter?.endpoint ? { endpoint: { ...adapter.endpoint } } : {};
}

function tryAppend(evidence, entry) {
  // Enforcement outranks evidence on refusal paths: a denial-evidence write
  // failure must never convert a DENY into anything else.
  try {
    return evidence.append(entry);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[governed-egress] denial evidence write failed:', err?.message);
    return null;
  }
}

/**
 * Which committed fields differ between the authorized commitment and the
 * reconstruction. Returns field names only.
 */
function divergentFields(authorizedFields, reconstructedFields) {
  const diverged = [];
  for (const key of EGRESS_COMMITMENT_FIELDS) {
    if (authorizedFields?.[key] !== reconstructedFields?.[key]) diverged.push(key);
  }
  return diverged;
}

/**
 * Release outbound material under a redeemed Strix decision.
 *
 * @param {object} input
 * @param {object} input.authority   From production-binding.mjs — the redeemed
 *   decision's frozen commitment fields plus its committed commitmentHash.
 *   Never constructed by a caller from request data.
 * @param {{ text: string, prompt: string }} input.material  The ACTUAL bytes
 *   about to be transmitted. The only caller-supplied input, and every claim
 *   about it is derived here rather than accepted.
 * @param {{ name: string, destination: {provider,service}, send(...) }} input.adapter
 * @param {{ scan(text) }} input.detector
 * @param {{ append(entry) }} input.evidence
 * @param {() => boolean} input.consumeAuthority  Atomic single-use consume of
 *   the kernel grant. Must be claim-by-INSERT / conditional-UPDATE shaped in
 *   any durable implementation, never read-then-write.
 */
export async function releaseUnderKernelAuthority(input) {
  const { authority, material, adapter, detector, evidence, consumeAuthority } = input;
  const now = input.now ?? Date.now;

  if (authority === null || typeof authority !== 'object' || typeof authority.commitmentHash !== 'string') {
    return refusal('AUTHORITY_REQUIRED', 'no redeemed Strix authority was presented');
  }
  if (authority.canon !== EGRESS_COMMITMENT_CANON) {
    // No semantic fallback across canon versions: a commitment written
    // under rules this gate does not implement is refused, never
    // re-interpreted under the rules it does implement.
    return refusal(
      'AUTHORITY_CANON_UNSUPPORTED',
      `authority commitment canon ${JSON.stringify(authority.canon)} is not ${EGRESS_COMMITMENT_CANON}; this gate cannot re-derive it`,
    );
  }

  const artifactText = material?.text ?? '';
  const prompt = material?.prompt ?? '';

  // ── DERIVE, never accept ────────────────────────────────────────────────
  // The second scan is RE-RUN here over the exact outbound bytes. This is
  // the gate's own verification, not a report of someone else's.
  let verification;
  try {
    verification = await verifySanitizedArtifact({ text: artifactText, originalFindings: [], detector });
  } catch (err) {
    // A verifier that cannot run is not a pass. Fail closed.
    const r = refusal(
      'VERIFICATION_UNAVAILABLE',
      `the gate could not re-run verification over the outbound bytes (${err?.message}); a release whose verification did not run is refused`,
    );
    tryAppend(evidence, { type: 'egress_denied', reasonCode: r.reasonCode, transportName: adapter?.name, ...endpointFields(adapter) });
    return r;
  }

  let reconstructed;
  try {
    reconstructed = assembleEgressCommitment({
      authority,
      material: {
        // The adapter declares its own destination — a caller does not.
        provider: adapter?.destination?.provider,
        service: adapter?.destination?.service,
        releasedArtifactHash: sha256Hex(artifactText),
        promptHash: sha256Hex(prompt),
        verificationResult: verification.status,
        verificationProves: verification.proves,
        remainingProhibitedFindings: verification.remainingProhibitedFindings,
      },
    });
  } catch (err) {
    // A commitment that cannot be BUILT is refused by name, never thrown.
    // If this escaped, the CALLER'S try/catch would decide the verdict and
    // "the gate was misconfigured" would be indistinguishable from "the
    // process fell over" — the worst available outcome at an egress
    // boundary, and the exact shape the AA-2 verifier's absent-key TypeError
    // took before it was made a fail-closed refusal. The commonest real
    // cause is an adapter that declares no destination, so the detail names
    // the adapter.
    const r = refusal(
      'COMMITMENT_UNCONSTRUCTIBLE',
      `the gate could not construct a commitment for this release (${err?.message}); adapter ${JSON.stringify(adapter?.name ?? null)} may declare no destination`,
    );
    tryAppend(evidence, {
      type: 'egress_denied',
      reasonCode: r.reasonCode,
      decisionId: authority.decisionId,
      transportName: adapter?.name,
      ...endpointFields(adapter),
    });
    return r;
  }

  if (reconstructed.commitmentHash !== authority.commitmentHash) {
    // Name what diverged. The authorized field set is re-parsed from the
    // authority's own canonical bytes rather than trusted as a side object,
    // so the diagnosis describes what was actually committed to.
    let authorizedFields = null;
    try {
      authorizedFields = Object.fromEntries(JSON.parse(authority.canonicalBytes));
    } catch {
      authorizedFields = null;
    }
    const reconstructedFields = Object.fromEntries(JSON.parse(reconstructed.canonicalBytes));
    const diverged = authorizedFields ? divergentFields(authorizedFields, reconstructedFields) : ['<authorized commitment unreadable>'];
    const r = refusal(
      'COMMITMENT_MISMATCH',
      `the material presented does not reconstruct the authorized egress commitment; diverging field(s): ${diverged.join(', ')}`,
      { divergentFields: diverged, authorizedCommitmentHash: authority.commitmentHash, reconstructedCommitmentHash: reconstructed.commitmentHash },
    );
    // A mismatch does NOT consume the grant: refusing a substitution must
    // not burn authority the legitimate release still needs, and an
    // attacker cannot succeed without the exact bytes — possessing which IS
    // the authorized release.
    tryAppend(evidence, {
      type: 'egress_denied',
      reasonCode: r.reasonCode,
      decisionId: authority.decisionId,
      divergentFields: diverged,
      authorizedCommitmentHash: authority.commitmentHash,
      reconstructedCommitmentHash: reconstructed.commitmentHash,
      transportName: adapter?.name,
      ...endpointFields(adapter),
    });
    return r;
  }

  // ── CONSUME, then evidence, then transport ──────────────────────────────
  if (typeof consumeAuthority !== 'function' || consumeAuthority() !== true) {
    const r = refusal('AUTHORITY_CONSUMED', 'the kernel authority was already consumed, or could not be consumed');
    tryAppend(evidence, {
      type: 'egress_denied',
      reasonCode: r.reasonCode,
      decisionId: authority.decisionId,
      commitmentHash: authority.commitmentHash,
      transportName: adapter?.name,
      ...endpointFields(adapter),
    });
    return r;
  }

  try {
    evidence.append({
      type: 'egress_attempt',
      decisionId: authority.decisionId,
      commitmentHash: authority.commitmentHash,
      canon: EGRESS_COMMITMENT_CANON,
      transportName: adapter.name,
      ...endpointFields(adapter),
    });
  } catch (err) {
    return refusal(
      'EVIDENCE_UNAVAILABLE',
      `attempt evidence could not be written (${err?.message}); the provider was never contacted, and the authority is spent`,
    );
  }

  let execution;
  let providerMeta = null;
  let responseText = null;
  let transportError = null;
  try {
    const result = await adapter.send({
      documentText: artifactText,
      prompt,
      purpose: authority.purpose,
      destination: { ...adapter.destination },
    });
    execution = 'completed';
    providerMeta = result?.providerMeta ?? null;
    responseText = result?.responseText ?? null;
  } catch (err) {
    execution = err?.kind === 'timeout' ? 'unknown' : 'failed';
    transportError = { kind: err?.kind ?? 'error', message: String(err?.message ?? err) };
  }

  const disclosureStatus = disclosureStatusFor(execution, transportError?.kind);

  let outcomeRecord = null;
  let outcomeEvidenceRecorded = true;
  try {
    outcomeRecord = evidence.append({
      type: 'egress_outcome',
      decisionId: authority.decisionId,
      commitmentHash: authority.commitmentHash,
      execution,
      disclosureStatus,
      transportName: adapter.name,
      ...endpointFields(adapter),
      ...(providerMeta ? { providerMeta } : {}),
      ...(transportError ? { transportError } : {}),
    });
  } catch (err) {
    outcomeEvidenceRecorded = false;
    // eslint-disable-next-line no-console
    console.error('[governed-egress] outcome evidence write failed:', err?.message);
  }

  return {
    released: execution === 'completed',
    decision: 'ALLOW',
    execution,
    disclosureStatus,
    decisionId: authority.decisionId,
    commitmentHash: authority.commitmentHash,
    canon: EGRESS_COMMITMENT_CANON,
    // The chain head AFTER the outcome entry — this is what gets bound into
    // signed evidence so the local chain gains an external authenticity
    // anchor (see production-binding.mjs).
    evidenceChainHead: outcomeRecord?.entryHash ?? null,
    reconstructedCommitmentHash: reconstructed.commitmentHash,
    providerMeta,
    responseText,
    transportError,
    outcomeEvidenceRecorded,
    now: now(),
  };
}

/** Re-export for callers building an authority DTO in tests. */
export { canonicalizeEgressCommitment };
