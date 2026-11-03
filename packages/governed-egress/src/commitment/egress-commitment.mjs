/**
 * THE CANONICAL EGRESS COMMITMENT — what Strix actually authorizes when it
 * authorizes an outbound AI call.
 *
 * The failure this exists to prevent is a vague decision. Signing "Claude
 * send approved" commits to nothing checkable: it names no bytes, no
 * destination, no verification outcome, so any later payload satisfies it
 * and the signature attests to an intention rather than to an act. A
 * commitment is the opposite — a content address over every field that
 * decides whether THIS release was the authorized one.
 *
 * WHERE EACH FIELD COMES FROM IS THE SECURITY PROPERTY, not the field list.
 * There are exactly two sources and the caller is neither:
 *
 *   DERIVED — recomputed at the gate from the ACTUAL outbound material, so
 *     a caller cannot assert them:
 *       releasedArtifactHash   sha256 of the bytes about to be transmitted
 *       promptHash             sha256 of the prompt about to be transmitted
 *       provider, service      read off the transport adapter's OWN identity
 *       verificationResult     the second scan RE-RUN over those exact bytes
 *       verificationProves     the verifier's own honest ceiling
 *       remainingFindings      that re-run's count
 *
 *   AUTHORITY — read from the redeemed Strix decision's FROZEN actionParams,
 *     which a caller also cannot alter (the kernel froze them at EVALUATED):
 *       capability, tenantId, environment, actor, policyId, policyVersion,
 *       purpose, initialClassification, releasedClassification
 *
 * `initialClassification` deserves its own note because it is the one field
 * that is honestly NOT re-derivable at the gate: the gate sees only the
 * released bytes, never the original document, so it cannot know what the
 * artifact was before transformation. It therefore comes from authority and
 * never from material — recorded here rather than quietly sourced, because
 * a field a reader ASSUMES is re-derived and which is not is exactly how a
 * commitment starts overstating what it proves.
 *
 * CANONICALIZATION IS VERSIONED. `canon` is the first field of every
 * commitment and is covered by the hash, so two canon versions can never
 * collide and a verifier reading an unknown canon FAILS rather than
 * guessing (the assurance-vocabulary-mapping-v1 no-semantic-fallback rule).
 * Changing the field set, the order, or the serialization is a NEW canon
 * version — never an edit to this one, which would silently invalidate
 * every commitment ever computed under it.
 *
 * This module is pure: no I/O, no clock, no crypto beyond sha256 of its own
 * canonical bytes. It decides nothing — it states, in one hash, what a
 * decision committed to.
 */
import { sha256Hex } from '../artifact/hash.mjs';

/**
 * The canonicalization version. Covered by the hash as the FIRST field.
 * A new field, a reordering, or a serialization change is a new value here.
 */
export const EGRESS_COMMITMENT_CANON = 'strix-egress-commitment-v1';

/**
 * Locked field order for `strix-egress-commitment-v1`. Serialization is a
 * JSON array of [key, value] pairs in exactly this order — an array rather
 * than an object because object key order is a property of the writer, and
 * a canonical form must not depend on how the object was built.
 */
export const EGRESS_COMMITMENT_FIELDS = Object.freeze([
  'canon',
  'capability',
  'tenantId',
  'environment',
  'actor',
  'policyId',
  'policyVersion',
  'provider',
  'service',
  'purpose',
  'initialClassification',
  'releasedClassification',
  'releasedArtifactHash',
  'promptHash',
  'verificationResult',
  'verificationProves',
  'remainingProhibitedFindings',
]);

/** Fields sourced from the redeemed decision's frozen actionParams. */
export const AUTHORITY_SOURCED_FIELDS = Object.freeze([
  'capability',
  'tenantId',
  'environment',
  'actor',
  'policyId',
  'policyVersion',
  'purpose',
  'initialClassification',
  'releasedClassification',
]);

/** Fields recomputed at the gate from the actual outbound material. */
export const MATERIAL_DERIVED_FIELDS = Object.freeze([
  'provider',
  'service',
  'releasedArtifactHash',
  'promptHash',
  'verificationResult',
  'verificationProves',
  'remainingProhibitedFindings',
]);

const NUMERIC_FIELDS = new Set(['remainingProhibitedFindings']);

/**
 * Canonical bytes for a commitment. Fail-closed on every axis a defaulted
 * value could hide: a missing field, an unknown field, a wrong type, or an
 * empty string all THROW rather than serialize. A commitment that silently
 * defaulted a field would be a commitment to something nobody checked.
 */
export function canonicalizeEgressCommitment(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError('canonicalizeEgressCommitment: fields must be a plain object');
  }
  if (fields.canon !== EGRESS_COMMITMENT_CANON) {
    // Refusing an unrecognized canon here (rather than serializing it
    // anyway) is what stops a v2 commitment from being hashed by v1 rules
    // and compared as though the two agreed.
    throw new TypeError(
      `canonicalizeEgressCommitment: unsupported canon ${JSON.stringify(fields.canon)} — this module implements ${EGRESS_COMMITMENT_CANON} only`,
    );
  }

  const known = new Set(EGRESS_COMMITMENT_FIELDS);
  for (const key of Object.keys(fields)) {
    if (!known.has(key)) {
      throw new TypeError(
        `canonicalizeEgressCommitment: unknown field ${JSON.stringify(key)} — a field outside the locked ${EGRESS_COMMITMENT_CANON} set cannot be committed to`,
      );
    }
  }

  const pairs = [];
  for (const key of EGRESS_COMMITMENT_FIELDS) {
    // Own-property only: an inherited value must never satisfy a committed
    // field (the prototype-pollution class this repo has recorded twice).
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new TypeError(`canonicalizeEgressCommitment: missing required field ${JSON.stringify(key)}`);
    }
    const value = fields[key];
    if (NUMERIC_FIELDS.has(key)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new TypeError(`canonicalizeEgressCommitment: ${key} must be a non-negative integer`);
      }
    } else if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`canonicalizeEgressCommitment: ${key} must be a non-empty string`);
    }
    pairs.push([key, value]);
  }
  return JSON.stringify(pairs);
}

/**
 * Content-address a commitment.
 * @returns {{ canon: string, canonicalBytes: string, commitmentHash: string }}
 */
export function computeEgressCommitment(fields) {
  const canonicalBytes = canonicalizeEgressCommitment(fields);
  return {
    canon: EGRESS_COMMITMENT_CANON,
    canonicalBytes,
    commitmentHash: sha256Hex(canonicalBytes),
  };
}

/**
 * Assemble a commitment from its two sanctioned sources — and ONLY those
 * two. The signature is deliberately two parameters with no third: there is
 * no "overrides" argument a caller could reach for, because the whole
 * property being defended is that a caller contributes nothing to what the
 * commitment says.
 *
 * @param {{ authority: object, material: object }} input
 *   authority — the redeemed decision's frozen fields
 *   material  — values already DERIVED from the actual outbound bytes and
 *               the transport adapter's own identity (see reconstruct-at-gate)
 */
export function assembleEgressCommitment({ authority, material }) {
  if (authority === null || typeof authority !== 'object') {
    throw new TypeError('assembleEgressCommitment: authority must be an object');
  }
  if (material === null || typeof material !== 'object') {
    throw new TypeError('assembleEgressCommitment: material must be an object');
  }
  const fields = { canon: EGRESS_COMMITMENT_CANON };
  for (const key of AUTHORITY_SOURCED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(authority, key)) {
      throw new TypeError(`assembleEgressCommitment: authority is missing ${JSON.stringify(key)}`);
    }
    fields[key] = authority[key];
  }
  for (const key of MATERIAL_DERIVED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(material, key)) {
      throw new TypeError(`assembleEgressCommitment: material is missing ${JSON.stringify(key)}`);
    }
    fields[key] = material[key];
  }
  return computeEgressCommitment(fields);
}
