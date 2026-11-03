/**
 * PHASE-B KERNEL BINDING — the Strix decision becomes the authority.
 *
 * This module translates a redeemed Strix `Decision` for the capability
 * `ai.external.document.send` into the narrow authority object the
 * point-of-use gate consumes. It is a TRANSLATOR, not a decider: it
 * evaluates no policy, mints no grant, and has no way to permit anything
 * the kernel did not. Every refusal here is a refusal to REPRESENT an
 * authority that does not exist.
 *
 * WHY THIS REPLACES THE LOCAL AUTHORIZATION RATHER THAN SITTING BESIDE IT.
 * v0.1 shipped its own payload-bound single-use grant (authorization/
 * authorize.mjs). That was the right shape for a package with no kernel,
 * and it is the wrong thing to keep once there is one: two mechanisms that
 * can each permit an egress is a parallel authorization system, which is
 * exactly what the Gate-D scope law forbids and what this repo has spent
 * several workstreams NOT building. So on the kernel path:
 *   - the DECISION is the authorization (created, evaluated, approved and
 *     token-redeemed by DecisionService — none of it here);
 *   - single-use comes from the kernel's own token redemption, surfaced to
 *     the gate as one `consumeAuthority()` callback;
 *   - payload binding comes from the canonical egress commitment frozen in
 *     the decision's own `actionParams`.
 * `authorize.mjs` is demoted to the local-mode fallback and is not imported
 * by this module or by the kernel gate — a structural test pins that.
 *
 * THE STORED HASH IS NEVER TRUSTED. The decision may carry a
 * `commitmentHash` in its frozen params; this module RE-DERIVES it from the
 * frozen commitment fields and refuses on disagreement. Trusting a stored
 * hash is how a bundle swapped after hashing activates against a stale
 * certification (the HIGH finding the client-profile 360 recorded); the
 * cost of re-deriving is one sha256, and it converts a trusted field into a
 * checked one.
 *
 * DEPENDENCY DIRECTION. This package imports nothing from the console —
 * the decision arrives as a plain DTO assembled by the console-side caller.
 * That keeps `@strixgov/governed-egress` verifiable in isolation and makes
 * "the library cannot decide" a fact about the import graph rather than a
 * promise in a comment.
 */
import { EGRESS_CAPABILITY_ID } from '../capability.mjs';
import { sha256Hex } from '../artifact/hash.mjs';
import {
  AUTHORITY_SOURCED_FIELDS,
  EGRESS_COMMITMENT_CANON,
  computeEgressCommitment,
} from '../commitment/egress-commitment.mjs';

/** The one capability this binding will represent (single declaration). */
export { EGRESS_CAPABILITY_ID } from '../capability.mjs';

/**
 * Decision states in which authority genuinely exists. `EXECUTING` is
 * included deliberately, carried forward from the dependency-governance
 * ceremony finding: the binding is useful at exactly one moment — after
 * redemption and before the write — and an EXECUTED-only check can only be
 * satisfied by calling postReceipt(success) before doing the work.
 */
export const AUTHORIZED_DECISION_STATES = Object.freeze(['EXECUTING', 'EXECUTED']);

export const BINDING_REFUSAL_CODES = Object.freeze([
  'DECISION_MISSING',
  'DECISION_NOT_EXECUTED',
  'TOKEN_NOT_REDEEMED',
  'TENANT_MISMATCH',
  'CAPABILITY_MISMATCH',
  'COMMITMENT_FIELDS_INVALID',
  'COMMITMENT_HASH_DISAGREEMENT',
]);

class BindingRefusal extends Error {
  constructor(reasonCode, detail) {
    super(detail);
    this.name = 'BindingRefusal';
    this.reasonCode = reasonCode;
    this.detail = detail;
  }
}

export { BindingRefusal };

/**
 * Build the gate's authority from a redeemed decision.
 *
 * @param {object} input
 * @param {object} input.decision  DTO of the kernel decision:
 *   { id, state, actionType, tenantId, tokenRedeemed, actionParams }
 *   `actionParams` are the FROZEN params the kernel captured at EVALUATED.
 * @param {string} input.tenantId  The tenant the release is running under.
 * @param {() => boolean} input.consumeAuthority  Atomic single-use consume,
 *   supplied by the console-side caller and backed by the kernel's own token
 *   redemption. Passed through to the gate untouched.
 * @returns {{ authority: object, consumeAuthority: () => boolean }}
 * @throws {BindingRefusal}
 */
export function bindDecisionToEgressAuthority({ decision, tenantId, consumeAuthority }) {
  if (decision === null || typeof decision !== 'object') {
    throw new BindingRefusal('DECISION_MISSING', 'no decision was supplied; there is no authority to represent');
  }
  if (!AUTHORIZED_DECISION_STATES.includes(decision.state)) {
    throw new BindingRefusal(
      'DECISION_NOT_EXECUTED',
      `decision ${decision.id} is in state ${JSON.stringify(decision.state)}; authority exists only in ${AUTHORIZED_DECISION_STATES.join(' or ')}`,
    );
  }
  if (decision.tokenRedeemed !== true) {
    throw new BindingRefusal(
      'TOKEN_NOT_REDEEMED',
      `decision ${decision.id} has no redeemed execution token; an unredeemed decision authorizes nothing`,
    );
  }
  if (typeof tenantId !== 'string' || tenantId.length === 0 || decision.tenantId !== tenantId) {
    throw new BindingRefusal(
      'TENANT_MISMATCH',
      `decision ${decision.id} belongs to a different tenant than the release is running under`,
    );
  }
  if (decision.actionType !== EGRESS_CAPABILITY_ID) {
    // A token minted for some other capability must never be spendable
    // here, whatever its tier.
    throw new BindingRefusal(
      'CAPABILITY_MISMATCH',
      `decision ${decision.id} authorizes ${JSON.stringify(decision.actionType)}, not ${EGRESS_CAPABILITY_ID}`,
    );
  }

  const params = decision.actionParams;
  if (params === null || typeof params !== 'object') {
    throw new BindingRefusal('COMMITMENT_FIELDS_INVALID', `decision ${decision.id} froze no actionParams`);
  }

  // Assemble the AUTHORITY half of the commitment from frozen params only.
  // `capability` is taken from the decision's own actionType rather than
  // from a params field, so a params field claiming a different capability
  // cannot survive: the two would produce different commitments and the
  // hash check below is what catches it.
  const authorityFields = {};
  for (const key of AUTHORITY_SOURCED_FIELDS) {
    const value = key === 'capability' ? decision.actionType : params[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new BindingRefusal(
        'COMMITMENT_FIELDS_INVALID',
        `decision ${decision.id} froze no usable ${JSON.stringify(key)}; the commitment cannot be re-derived and the release is refused`,
      );
    }
    authorityFields[key] = value;
  }

  // Re-derive the FULL commitment from the frozen fields. The material half
  // is frozen too (the decision committed to specific outbound bytes), so a
  // complete commitment is derivable here without any material present —
  // which is what lets the gate compare, later, against something the
  // kernel actually signed off on rather than against a caller's copy.
  const frozenMaterial = {};
  for (const key of ['provider', 'service', 'releasedArtifactHash', 'promptHash', 'verificationResult', 'verificationProves']) {
    const value = params[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new BindingRefusal(
        'COMMITMENT_FIELDS_INVALID',
        `decision ${decision.id} froze no usable ${JSON.stringify(key)}; the commitment cannot be re-derived and the release is refused`,
      );
    }
    frozenMaterial[key] = value;
  }
  const remaining = params.remainingProhibitedFindings;
  if (!Number.isInteger(remaining) || remaining < 0) {
    throw new BindingRefusal(
      'COMMITMENT_FIELDS_INVALID',
      `decision ${decision.id} froze no usable remainingProhibitedFindings`,
    );
  }
  frozenMaterial.remainingProhibitedFindings = remaining;

  let derived;
  try {
    derived = computeEgressCommitment({
      canon: EGRESS_COMMITMENT_CANON,
      ...authorityFields,
      ...frozenMaterial,
    });
  } catch (err) {
    throw new BindingRefusal('COMMITMENT_FIELDS_INVALID', `frozen params do not form a valid commitment: ${err?.message}`);
  }

  // If the decision ALSO carries a stored hash, it must agree with the
  // re-derivation. Disagreement means the params and the hash describe
  // different releases; refusing is the only safe reading of that.
  if (typeof params.commitmentHash === 'string' && params.commitmentHash !== derived.commitmentHash) {
    throw new BindingRefusal(
      'COMMITMENT_HASH_DISAGREEMENT',
      `decision ${decision.id} stores commitmentHash ${params.commitmentHash.slice(0, 16)}… but its frozen fields re-derive ${derived.commitmentHash.slice(0, 16)}…`,
    );
  }

  return {
    authority: Object.freeze({
      decisionId: decision.id,
      canon: derived.canon,
      commitmentHash: derived.commitmentHash,
      canonicalBytes: derived.canonicalBytes,
      ...authorityFields,
    }),
    consumeAuthority,
  };
}

/**
 * THE PROPOSE SIDE — the actionParams a console route freezes into the
 * decision, derived from a completed pipeline run.
 *
 * This is the counterpart of `bindDecisionToEgressAuthority`: that one
 * re-derives a commitment from frozen params, this one produces the params
 * to freeze. Both go through `computeEgressCommitment`, so the propose side
 * cannot mint a params shape the redeem side would reject — the two agree
 * by construction rather than by two people keeping two field lists in sync.
 *
 * The route hands the RESULT of a real pipeline run, never caller input:
 * the released bytes, the prompt, and the verification the pipeline itself
 * performed. What the kernel then evaluates is a specific release, which is
 * the whole point — a decision that said only "Claude send approved" would
 * be satisfied by any later payload.
 *
 * Note the deliberate asymmetry with the gate: HERE the verification result
 * comes from the pipeline that just ran it, because at propose time there is
 * no outbound material yet to re-verify. At the GATE it is re-run over the
 * actual bytes. The commitment is what forces those two to agree.
 */
export function egressCommitmentParamsFromPipeline({
  tenantId,
  environment,
  actor,
  policyId,
  policyVersion,
  purpose,
  initialClassification,
  releasedClassification,
  destination,
  releasedText,
  prompt,
  verification,
}) {
  const fields = {
    canon: EGRESS_COMMITMENT_CANON,
    capability: EGRESS_CAPABILITY_ID,
    tenantId,
    environment,
    actor,
    policyId,
    policyVersion,
    provider: destination?.provider,
    service: destination?.service,
    purpose,
    initialClassification,
    releasedClassification,
    releasedArtifactHash: sha256Hex(releasedText ?? ''),
    promptHash: sha256Hex(prompt ?? ''),
    verificationResult: verification?.status,
    verificationProves: verification?.proves,
    remainingProhibitedFindings: verification?.remainingProhibitedFindings,
  };
  // Throws on any missing/invalid field rather than freezing a params
  // object the redeem side would later refuse — failing at propose time is
  // strictly cheaper than failing after a human approved something.
  const { commitmentHash, canonicalBytes } = computeEgressCommitment(fields);
  const { canon: _canon, capability: _capability, ...params } = fields;
  return {
    actionParams: { ...params, commitmentHash },
    commitmentHash,
    canonicalBytes,
  };
}

/**
 * ITEM 5 — bind the local evidence chain head into signed evidence.
 *
 * The local hash chain proves INTERNAL CONSISTENCY, not authenticity: the
 * log is unsigned and locally held, so a party who can rewrite one entry can
 * rewrite them all and re-chain. Signing the chain's committed HEAD is what
 * fixes that, and it is deliberately the head rather than the N entries —
 * one anchor gives the whole chain external authenticity without minting N
 * signed artifacts or widening any frozen schema.
 *
 * What a verifier can do with this afterwards, stated plainly because it is
 * the whole value: take the signed DecisionEvidence, read `evidenceChainHead`
 * out of its result, and run `verifyEvidenceChain` over a presented log. If
 * the chain verifies AND its head equals the signed head, the log is the one
 * Strix signed over. If the head differs, the log was rewritten after the
 * fact — which the local chain alone could never have told anyone.
 *
 * @returns the `result` object to hand DecisionService.postReceipt, so the
 *   head lands inside the signed evidence rather than beside it.
 */
export function receiptResultForSignedEvidence(gateResult) {
  if (gateResult === null || typeof gateResult !== 'object') {
    throw new TypeError('receiptResultForSignedEvidence: gateResult must be an object');
  }
  return {
    capability: EGRESS_CAPABILITY_ID,
    canon: gateResult.canon ?? EGRESS_COMMITMENT_CANON,
    commitmentHash: gateResult.commitmentHash ?? null,
    execution: gateResult.execution ?? null,
    disclosureStatus: gateResult.disclosureStatus ?? null,
    // The anchor. Null is honest — an outcome-evidence write that failed
    // leaves no head to sign, and a fabricated one would be worse than none.
    evidenceChainHead: gateResult.evidenceChainHead ?? null,
    evidenceChainHeadRecorded: typeof gateResult.evidenceChainHead === 'string',
    proves: 'CHAIN_HEAD_ANCHORED_TO_SIGNED_EVIDENCE',
  };
}
