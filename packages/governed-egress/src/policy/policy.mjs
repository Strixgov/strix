/**
 * Data-egress policy for external AI destinations (spec §12) — behavior as
 * DATA, validated fail-closed, never buried in code.
 *
 * v0.1 constraints the validator ENFORCES rather than documents:
 *  - `default` must be 'deny'. A permissive default is refused outright.
 *  - `phi.action` ∈ { 'deny', 'sanitize' }. There is deliberately NO
 *    "allow PHI to an approved HIPAA AI environment" value in v0.1 — the
 *    field shape leaves room for it, and the validator refuses it until
 *    that compliance surface is designed (spec §2: architect for it,
 *    don't ship it).
 *  - `phi.requirePostTransformVerification` must be true when action is
 *    'sanitize' — the second scan cannot be optional (spec §7).
 *  - `phi.failClosed` must be true.
 *  - `allowedData` entries ∈ { 'deidentified', 'non_sensitive' }; 'phi' in
 *    an allowlist is refused by name (ALLOWED_DATA_PHI_UNSUPPORTED).
 *
 * The classification→data-class map is TOTAL and an unknown classification
 * THROWS — never a nearest match (assurance-vocabulary-mapping-v1).
 */
export class PolicyValidationError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'PolicyValidationError';
    this.reasonCode = reasonCode;
  }
}

import { TOKEN_PREFIX } from '../detection/categories.mjs';

const ALLOWED_DATA_CLASSES = Object.freeze(['deidentified', 'non_sensitive']);

/**
 * Per-category actions (`phi.categories`, optional). Every action is at
 * least as strict as the default:
 *   - `tokenize` (the default for any category not listed): replaced by a
 *     consistent token, as today;
 *   - `flag`: tokenized the same way, and the release is marked for review
 *     (`flaggedCategories` on the result and the authorization evidence);
 *   - `block`: any finding of this category refuses the whole document.
 * There is deliberately NO `allow`: a value that leaves untransformed would
 * fail the release verification by construction, and a policy knob that
 * turns the verification off is the thing this package exists to refuse.
 */
export const CATEGORY_ACTIONS = Object.freeze(['tokenize', 'flag', 'block']);

/**
 * `phi.replacement` (optional): `token` (default) or `synthetic` — fictional
 * same-type values for names, phones and emails, tokens for everything else.
 * Synthetic replacement is LOCAL MODE only; see pipeline.mjs.
 */
export const REPLACEMENT_MODES = Object.freeze(['token', 'synthetic']);
const PHI_ACTIONS = Object.freeze(['deny', 'sanitize']);

/** Recursively freeze a plain-data object graph (arrays included). */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

/**
 * Validate an egress policy object and return an immutable SNAPSHOT of it.
 * Throws PolicyValidationError on any violation.
 *
 * The snapshot is the load-bearing part (found by a 360 probe, not by
 * review): the pipeline reads decision fields (`phi.action`, destination
 * eligibility) strictly AFTER awaiting caller-injected async deps, so a dep
 * that mutated the live policy object mid-flight could launder a validated
 * `action: 'deny'` into `'sanitize'` between validation and enforcement.
 * The boundary must enforce the policy it VALIDATED — the same rule as
 * "the artifact inspected must be the artifact transmitted", applied to the
 * policy itself. `structuredClone` also drops inherited/prototype state, so
 * a poisoned-prototype destinations object cannot survive into the
 * enforcement reads (own-property discipline, the client-profile 360 class).
 * A policy that cannot be structured-cloned (functions, proxies) is refused
 * by name — policy is DATA, and behavior smuggled into it is itself a
 * violation.
 */
export function validateEgressPolicy(policy) {
  if (policy === null || typeof policy !== 'object') {
    throw new PolicyValidationError('POLICY_INVALID', 'policy must be an object');
  }
  if (typeof policy.policyId !== 'string' || policy.policyId.length === 0) {
    throw new PolicyValidationError('POLICY_INVALID', 'policyId is required');
  }
  if (typeof policy.policyVersion !== 'string' || policy.policyVersion.length === 0) {
    throw new PolicyValidationError('POLICY_INVALID', 'policyVersion is required');
  }
  const externalAI = policy.dataEgress?.externalAI;
  if (externalAI === null || typeof externalAI !== 'object') {
    throw new PolicyValidationError('POLICY_INVALID', 'dataEgress.externalAI is required');
  }
  if (externalAI.default !== 'deny') {
    throw new PolicyValidationError(
      'POLICY_PERMISSIVE_DEFAULT',
      "dataEgress.externalAI.default must be 'deny' in v0.1",
    );
  }
  const phi = externalAI.phi;
  if (phi === null || typeof phi !== 'object') {
    throw new PolicyValidationError('POLICY_INVALID', 'externalAI.phi is required');
  }
  if (!PHI_ACTIONS.includes(phi.action)) {
    throw new PolicyValidationError(
      'POLICY_PHI_ACTION_UNSUPPORTED',
      `phi.action must be one of ${PHI_ACTIONS.join('|')} in v0.1 (got ${String(phi.action)})`,
    );
  }
  if (phi.action === 'sanitize' && phi.requirePostTransformVerification !== true) {
    throw new PolicyValidationError(
      'POLICY_VERIFICATION_NOT_OPTIONAL',
      'requirePostTransformVerification must be true — the second scan cannot be optional',
    );
  }
  if (phi.failClosed !== true) {
    throw new PolicyValidationError('POLICY_INVALID', 'phi.failClosed must be true in v0.1');
  }
  if (phi.replacement !== undefined && !REPLACEMENT_MODES.includes(phi.replacement)) {
    throw new PolicyValidationError(
      'POLICY_REPLACEMENT_UNSUPPORTED',
      `phi.replacement must be one of ${REPLACEMENT_MODES.join('|')} (got ${String(phi.replacement)})`,
    );
  }
  if (phi.categories !== undefined) {
    if (phi.categories === null || typeof phi.categories !== 'object' || Array.isArray(phi.categories)) {
      throw new PolicyValidationError('POLICY_INVALID', 'phi.categories must be an object of category → action');
    }
    for (const [category, action] of Object.entries(phi.categories)) {
      if (!Object.prototype.hasOwnProperty.call(TOKEN_PREFIX, category)) {
        throw new PolicyValidationError('POLICY_CATEGORY_UNKNOWN', `phi.categories names an unknown category ${category}`);
      }
      if (!CATEGORY_ACTIONS.includes(action)) {
        throw new PolicyValidationError(
          'POLICY_CATEGORY_ACTION_UNSUPPORTED',
          `phi.categories.${category} must be one of ${CATEGORY_ACTIONS.join('|')} (got ${String(action)}); there is no action that lets a value leave untransformed`,
        );
      }
    }
  }
  const destinations = externalAI.destinations;
  if (destinations === null || typeof destinations !== 'object') {
    throw new PolicyValidationError('POLICY_INVALID', 'externalAI.destinations is required');
  }
  for (const [name, dest] of Object.entries(destinations)) {
    if (dest === null || typeof dest !== 'object' || typeof dest.enabled !== 'boolean') {
      throw new PolicyValidationError('POLICY_INVALID', `destination ${name} must declare enabled`);
    }
    if (!Array.isArray(dest.allowedData)) {
      throw new PolicyValidationError('POLICY_INVALID', `destination ${name} must declare allowedData`);
    }
    for (const cls of dest.allowedData) {
      if (cls === 'phi') {
        throw new PolicyValidationError(
          'ALLOWED_DATA_PHI_UNSUPPORTED',
          `destination ${name} lists 'phi' in allowedData — raw PHI egress to an external AI is not implementable in v0.1`,
        );
      }
      if (!ALLOWED_DATA_CLASSES.includes(cls)) {
        throw new PolicyValidationError(
          'POLICY_INVALID',
          `destination ${name} allowedData entry ${String(cls)} is not a known data class`,
        );
      }
    }
  }

  let snapshot;
  try {
    snapshot = structuredClone(policy);
  } catch {
    throw new PolicyValidationError(
      'POLICY_INVALID',
      'policy must be plain, cloneable data — functions or exotic objects in a policy are refused',
    );
  }
  return deepFreeze(snapshot);
}

const CLASSIFICATION_TO_DATA_CLASS = Object.freeze({
  clear: 'non_sensitive',
  deidentified: 'deidentified',
  phi_detected: 'phi',
  unknown: 'unknown',
});

/** Total map; unknown classification throws (never a nearest match). */
export function classificationToDataClass(classification) {
  const dataClass = Object.prototype.hasOwnProperty.call(CLASSIFICATION_TO_DATA_CLASS, classification)
    ? CLASSIFICATION_TO_DATA_CLASS[classification]
    : undefined;
  if (dataClass === undefined) {
    throw new PolicyValidationError(
      'UNKNOWN_CLASSIFICATION',
      `classification ${String(classification)} has no data-class mapping`,
    );
  }
  return dataClass;
}

/**
 * Decide whether an artifact of `classification` may be released to
 * `destination` under `policy`. Pure; no default-to-permissive branch.
 *
 * @returns {{ eligible: true } | { eligible: false, reasonCode: string, detail: string }}
 */
export function decideDestination({ classification, destination, policy }) {
  const destinations = policy.dataEgress.externalAI.destinations;
  const provider = destination?.provider;
  // Own-property lookup only: `provider: 'constructor'` or '__proto__' must
  // resolve to "no policy entry", never to an inherited object that then
  // gets interrogated as though an operator had configured it.
  const dest =
    typeof provider === 'string' && Object.prototype.hasOwnProperty.call(destinations, provider)
      ? destinations[provider]
      : undefined;
  if (dest === undefined) {
    return {
      eligible: false,
      reasonCode: 'DESTINATION_NOT_ENABLED',
      detail: `no policy entry for provider ${String(destination?.provider)} — default is deny`,
    };
  }
  if (dest.enabled !== true) {
    return {
      eligible: false,
      reasonCode: 'DESTINATION_NOT_ENABLED',
      detail: `provider ${destination.provider} is disabled by policy`,
    };
  }
  const dataClass = classificationToDataClass(classification);
  if (!dest.allowedData.includes(dataClass)) {
    return {
      eligible: false,
      reasonCode: 'DATA_CLASS_NOT_ALLOWED',
      detail: `data class ${dataClass} is not in ${destination.provider}'s allowedData`,
    };
  }
  return { eligible: true };
}

/**
 * The action for a detected category under a VALIDATED policy. Own-property
 * read only; an unlisted category tokenizes.
 */
export function categoryAction(policy, category) {
  const map = policy?.dataEgress?.externalAI?.phi?.categories;
  if (map && Object.prototype.hasOwnProperty.call(map, category)) return map[category];
  return 'tokenize';
}

/** The replacement mode under a VALIDATED policy; `token` when unset. */
export function replacementMode(policy) {
  const phi = policy?.dataEgress?.externalAI?.phi;
  return phi && Object.prototype.hasOwnProperty.call(phi, 'replacement') ? phi.replacement : 'token';
}
