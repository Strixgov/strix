/**
 * The authenticated principal — what the CREDENTIAL proved, kept strictly
 * apart from what the caller DECLARED.
 *
 * WHY THIS IS A SEPARATE THING FROM `actor`. The refusal receipt already
 * carried `actor`, and it is honest about it: a caller-supplied string,
 * marked `DECLARED_UNVERIFIED`, because nothing in this package
 * authenticates it. Signing makes such a string tamper-evident AFTER the
 * fact; it does not make it true at the moment of assertion. You cannot
 * coach — still less discipline — a person on the strength of a name the
 * request itself chose. This module is the other half: a record of the
 * credential the boundary actually verified.
 *
 * THE RULE THAT MAKES IT WORTH HAVING: a declaration can never become the
 * principal. They are two fields, never merged, and the declared actor is
 * never promoted by the presence of a credential — not even a credential
 * that names a person. "We authenticated Bob" does not verify Bob's claim
 * that Alice did it. This is the three-identities discipline the sibling
 * platform already learned once (academy-platform, 2026-08-12): an
 * UNVERIFIED declaration may be recorded and may never reassign attribution.
 *
 * THE CEILING, WHICH IS THE PART MOST LIKELY TO BE OVERSTATED. Routing a
 * route through real authentication does NOT, by itself, tell you which
 * PERSON acted. A tenant API key names a key and the tenant it was issued
 * to; it is held by whoever holds it, which is usually a team and sometimes
 * a CI job. A service token names less than that — it says a trusted service
 * called, and nothing about who was at the keyboard. Only a session names a
 * person. So `identifiesPerson` is a literal field on every principal
 * (the Break Strix `evidenceAddressable` discipline), and on both AI-egress
 * routes today it is `false`. An organization can act on this — it can find
 * the team and the credential — and it cannot yet name the individual.
 *
 * DERIVED, NEVER ASSERTED. `identifies` and `identifiesPerson` are computed
 * from `authenticationMethod` through a total map; neither is read from the
 * input. There is therefore no input by which a caller — or a future
 * boundary that got it wrong — can claim `USER` without having actually
 * authenticated a session. An unrecognized method resolves to
 * `UNRECOGNIZED`, never to the nearest member: mapping an unknown
 * authentication method onto a known one would emit a confident, well-formed
 * assurance term naming a mechanism that did not run
 * (`assurance-vocabulary-mapping-v1`). `UNRECOGNIZED` is kept distinct from
 * `NONE` for the same reason SA-4 keeps UNVERIFIABLE apart from INVALID —
 * "no credential reached this record" and "a credential class we do not
 * understand reached this record" are different facts, and only the first is
 * a steady state.
 */

/** What an authenticated credential NAMES. Closed. */
export const PRINCIPAL_IDENTIFIES = Object.freeze([
  'USER', // a person
  'API_KEY', // a credential issued to a tenant, held by whoever holds it
  'SERVICE', // a service-to-service token; names no party inside the tenant
  'NONE', // no credential information reached this record
  'UNRECOGNIZED', // a method this vocabulary does not map — never bucketed
]);

/** How the boundary verified the caller. Closed; decides everything else. */
export const PRINCIPAL_AUTHENTICATION_METHODS = Object.freeze([
  'session',
  'tenant_api_key',
  'internal_service_token',
  'none',
]);

/**
 * Total map. The ONE place a method becomes a claim about what is named.
 * A method absent from this map yields `UNRECOGNIZED`, so adding a method
 * without deciding what it identifies cannot silently inherit `USER`.
 */
const IDENTIFIES_BY_METHOD = Object.freeze({
  session: 'USER',
  tenant_api_key: 'API_KEY',
  internal_service_token: 'SERVICE',
  none: 'NONE',
});

/** The only member that names a person. Deliberately a set of one. */
const IDENTIFIES_A_PERSON = Object.freeze(['USER']);

/**
 * A subject is meaningful only where the credential names something. A
 * service token names no party, so a `subject` presented alongside one is
 * dropped rather than recorded: it could only have come from somewhere other
 * than the credential, and a caller-supplied name sitting in a field whose
 * whole purpose is "what the credential proved" is the exact confusion this
 * module exists to prevent.
 */
const SUBJECT_BEARING = Object.freeze(['USER', 'API_KEY']);

const MAX_FIELD = 200;

function boundedString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD
    ? value
    : null;
}

/**
 * @param {{
 *   authenticationMethod?: string,
 *   subject?: string | null,
 *   tenantId?: string | null,
 * } | null | undefined} principal
 */
export function normalizePrincipal(principal) {
  const method =
    principal && typeof principal === 'object' && typeof principal.authenticationMethod === 'string'
      ? principal.authenticationMethod
      : 'none';

  const known = PRINCIPAL_AUTHENTICATION_METHODS.includes(method);
  const identifies = known ? IDENTIFIES_BY_METHOD[method] : 'UNRECOGNIZED';

  return {
    authenticationMethod: known ? method : 'unrecognized',
    identifies,
    // Derived from the method. Never read from the input — a planted
    // `identifiesPerson: true` alongside a service token has nowhere to land.
    identifiesPerson: IDENTIFIES_A_PERSON.includes(identifies),
    subject: SUBJECT_BEARING.includes(identifies) ? boundedString(principal?.subject) : null,
    tenantId: boundedString(principal?.tenantId),
  };
}
