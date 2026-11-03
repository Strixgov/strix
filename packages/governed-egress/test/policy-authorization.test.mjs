import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEgressPolicy,
  decideDestination,
  classificationToDataClass,
  PolicyValidationError,
} from '../src/policy/policy.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import {
  mintEgressAuthorization,
  createInMemoryAuthorizationStore,
  bindingAddress,
} from '../src/authorization/authorize.mjs';
import { sha256Hex } from '../src/artifact/hash.mjs';

function policyWith(mutate) {
  const p = structuredClone(HEALTHCARE_REFERENCE_POLICY);
  mutate(p);
  return p;
}

test('the healthcare reference policy validates, and validation returns an immutable SNAPSHOT', () => {
  // The contract deliberately changed from `returns true` after 360 probe A:
  // the pipeline must enforce the policy it VALIDATED, so validation hands
  // back a deep-frozen clone and the boundary reads only that.
  const live = structuredClone(HEALTHCARE_REFERENCE_POLICY);
  const snapshot = validateEgressPolicy(live);
  assert.deepEqual(snapshot, live);
  assert.notEqual(snapshot, live, 'the snapshot must be a distinct object, not the live policy');
  // Deep-frozen: a post-validation mutation of the snapshot itself refuses.
  assert.throws(() => { snapshot.dataEgress.externalAI.phi.action = 'sanitize'; }, TypeError);
  // And mutating the LIVE object after validation must not reach the snapshot.
  live.dataEgress.externalAI.phi.action = 'sanitize-tampered';
  assert.equal(snapshot.dataEgress.externalAI.phi.action, 'sanitize');
});

test('the shipped pilot policy constant is deep-frozen — nested decision fields refuse mutation', () => {
  assert.throws(() => { HEALTHCARE_REFERENCE_POLICY.dataEgress.externalAI.phi.action = 'deny'; }, TypeError);
  assert.throws(() => { HEALTHCARE_REFERENCE_POLICY.dataEgress.externalAI.destinations.anthropic.enabled = false; }, TypeError);
});

test('a policy carrying a function is refused by name — policy is data', () => {
  assert.throws(
    () => validateEgressPolicy(policyWith((p) => { p.dataEgress.externalAI.phi.onDeny = () => {}; })),
    (e) => e instanceof PolicyValidationError && e.reasonCode === 'POLICY_INVALID',
  );
});

test("a permissive default is refused — 'deny' is the only v0.1 default", () => {
  assert.throws(
    () => validateEgressPolicy(policyWith((p) => { p.dataEgress.externalAI.default = 'allow'; })),
    (e) => e instanceof PolicyValidationError && e.reasonCode === 'POLICY_PERMISSIVE_DEFAULT',
  );
});

test("'phi' in a destination allowedData is refused by name (spec §2: not in v0.1)", () => {
  assert.throws(
    () => validateEgressPolicy(policyWith((p) => { p.dataEgress.externalAI.destinations.anthropic.allowedData.push('phi'); })),
    (e) => e.reasonCode === 'ALLOWED_DATA_PHI_UNSUPPORTED',
  );
});

test('the second scan cannot be configured away', () => {
  assert.throws(
    () => validateEgressPolicy(policyWith((p) => { p.dataEgress.externalAI.phi.requirePostTransformVerification = false; })),
    (e) => e.reasonCode === 'POLICY_VERIFICATION_NOT_OPTIONAL',
  );
});

test('failClosed=false and unknown phi actions are refused', () => {
  assert.throws(() => validateEgressPolicy(policyWith((p) => { p.dataEgress.externalAI.phi.failClosed = false; })));
  assert.throws(
    () => validateEgressPolicy(policyWith((p) => { p.dataEgress.externalAI.phi.action = 'allow_with_baa'; })),
    (e) => e.reasonCode === 'POLICY_PHI_ACTION_UNSUPPORTED',
  );
});

test('destination decisions: unknown provider, disabled provider, and wrong data class all refuse', () => {
  const unknown = decideDestination({ classification: 'deidentified', destination: { provider: 'openai' }, policy: HEALTHCARE_REFERENCE_POLICY });
  assert.deepEqual([unknown.eligible, unknown.reasonCode], [false, 'DESTINATION_NOT_ENABLED']);

  const disabled = decideDestination({
    classification: 'deidentified',
    destination: { provider: 'anthropic' },
    policy: policyWith((p) => { p.dataEgress.externalAI.destinations.anthropic.enabled = false; }),
  });
  assert.deepEqual([disabled.eligible, disabled.reasonCode], [false, 'DESTINATION_NOT_ENABLED']);

  const phi = decideDestination({ classification: 'phi_detected', destination: { provider: 'anthropic' }, policy: HEALTHCARE_REFERENCE_POLICY });
  assert.deepEqual([phi.eligible, phi.reasonCode], [false, 'DATA_CLASS_NOT_ALLOWED']);

  // The pipeline's OWN output class is eligible under the shipped pilot
  // policy. Stated explicitly because a header in the console flag module
  // once claimed the opposite — that an unratified policy kept the surface
  // dormant — while this assertion was passing. A suite cannot contradict a
  // docstring, so the honest reading belongs beside the fact: the policy
  // controls WHAT may leave, never WHETHER the surface is live.
  const ok = decideDestination({ classification: 'deidentified', destination: { provider: 'anthropic' }, policy: HEALTHCARE_REFERENCE_POLICY });
  assert.equal(ok.eligible, true);
  assert.equal(Object.prototype.hasOwnProperty.call(ok, 'reasonCode'), false);
});

test('the classification map is total — an unknown classification throws, never nearest-matches', () => {
  assert.equal(classificationToDataClass('clear'), 'non_sensitive');
  assert.equal(classificationToDataClass('deidentified'), 'deidentified');
  assert.throws(() => classificationToDataClass('mostly_clean'), (e) => e.reasonCode === 'UNKNOWN_CLASSIFICATION');
  // Prototype-chain names must not satisfy the map (own-property reads only).
  assert.throws(() => classificationToDataClass('toString'), (e) => e.reasonCode === 'UNKNOWN_CLASSIFICATION');
});

test('authorization claim is single-use: exactly one of N racing claims wins', () => {
  const store = createInMemoryAuthorizationStore();
  const auth = mintEgressAuthorization({
    store,
    artifactHash: sha256Hex('artifact'),
    promptHash: sha256Hex('prompt'),
    destination: { provider: 'anthropic', service: 'claude' },
    purpose: 'document_analysis',
  });
  const wins = [1, 2, 3, 4, 5].map(() => store.claim(auth.authorizationId, new Date().toISOString()));
  assert.deepEqual(wins, [true, false, false, false, false]);
});

test('the binding address is sensitive to every bound component', () => {
  const base = {
    artifactHash: sha256Hex('a'),
    promptHash: sha256Hex('p'),
    provider: 'anthropic',
    service: 'claude',
    purpose: 'document_analysis',
  };
  const addr = bindingAddress(base);
  assert.notEqual(addr, bindingAddress({ ...base, artifactHash: sha256Hex('b') }));
  assert.notEqual(addr, bindingAddress({ ...base, promptHash: sha256Hex('q') }));
  assert.notEqual(addr, bindingAddress({ ...base, provider: 'openai' }));
  assert.notEqual(addr, bindingAddress({ ...base, service: 'gpt' }));
  assert.notEqual(addr, bindingAddress({ ...base, purpose: 'other' }));
  assert.equal(addr, bindingAddress(base), 'deterministic for identical inputs');
});

test('the binding address is a tuple, not a delimiter join — boundary-shifted components never collide', () => {
  // The ("ab","c") vs ("a","bc") class: with a naive join these two would
  // share bytes; the JSON-tuple encoding keeps them distinct.
  const h = sha256Hex('x');
  const a = bindingAddress({ artifactHash: h, promptHash: h, provider: 'ab', service: 'c', purpose: 'p' });
  const b = bindingAddress({ artifactHash: h, promptHash: h, provider: 'a', service: 'bc', purpose: 'p' });
  assert.notEqual(a, b);
});

test('a prefixed hash is refused where a bare hash is bound (no dual-spelling bindings)', () => {
  assert.throws(() =>
    bindingAddress({
      artifactHash: `sha256:${sha256Hex('a')}`,
      promptHash: sha256Hex('p'),
      provider: 'anthropic',
      service: 'claude',
      purpose: 'x',
    }),
  );
});
