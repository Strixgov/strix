/**
 * Per-category actions: `tokenize` (default), `flag` (tokenize + mark for
 * review), `block` (refuse the document). Each is at least as strict as the
 * default; there is no action that lets a value leave untransformed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governDocumentEgress, PIPELINE_DENY_CODES } from '../src/pipeline.mjs';
import { validateEgressPolicy, categoryAction, PolicyValidationError, CATEGORY_ACTIONS } from '../src/policy/policy.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../src/evidence/log.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { buildRecordText, buildCleanText, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const PROMPT = 'Summarize the encounter for the requesting physician.';

function withCategories(categories) {
  const p = structuredClone(HEALTHCARE_REFERENCE_POLICY);
  p.policyId = 'category-actions-test';
  p.dataEgress.externalAI.phi.categories = categories;
  return p;
}

function makeDeps() {
  return {
    detector: createPatternDetector(),
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
  };
}

async function govern(policy, text = buildRecordText(), transformer) {
  const deps = makeDeps();
  if (transformer) deps.transformer = transformer;
  const result = await governDocumentEgress({
    source: { text },
    prompt: PROMPT,
    destination: { provider: 'anthropic', service: 'claude' },
    purpose: 'clinical_summary',
    policy,
    deps,
  });
  return { result, deps };
}

test('validator: known categories and the three actions are accepted', () => {
  const v = validateEgressPolicy(withCategories({ SSN: 'block', DATE: 'flag', MRN: 'tokenize' }));
  assert.equal(categoryAction(v, 'SSN'), 'block');
  assert.equal(categoryAction(v, 'DATE'), 'flag');
  assert.equal(categoryAction(v, 'PHONE'), 'tokenize', 'unlisted tokenizes');
  assert.deepEqual([...CATEGORY_ACTIONS], ['tokenize', 'flag', 'block']);
});

test('validator: there is no action that lets a value leave', () => {
  for (const action of ['allow', 'pass', 'redact', '', null]) {
    assert.throws(
      () => validateEgressPolicy(withCategories({ SSN: action })),
      (e) => e instanceof PolicyValidationError && e.reasonCode === 'POLICY_CATEGORY_ACTION_UNSUPPORTED',
      String(action),
    );
  }
});

test('validator: an unknown category and a malformed map refuse', () => {
  assert.throws(() => validateEgressPolicy(withCategories({ PASSPORT: 'block' })), (e) => e.reasonCode === 'POLICY_CATEGORY_UNKNOWN');
  assert.throws(() => validateEgressPolicy(withCategories(['SSN'])), (e) => e.reasonCode === 'POLICY_INVALID');
  assert.throws(() => validateEgressPolicy(withCategories(null)), (e) => e.reasonCode === 'POLICY_INVALID');
});

test('categoryAction ignores inherited keys', () => {
  const inherited = Object.create({ SSN: 'block' });
  const p = withCategories(inherited);
  assert.equal(categoryAction(p, 'SSN'), 'tokenize');
});

test('block: a document with a blocked category refuses before transformation, naming only the category', async () => {
  let transformCalls = 0;
  const real = createTokenizingTransformer();
  const spy = { ...real, async transform(...a) { transformCalls += 1; return real.transform(...a); } };
  const { result, deps } = await govern(withCategories({ SSN: 'block' }), buildRecordText(), spy);
  assert.equal(result.outcome, 'DENY');
  assert.equal(result.reasonCode, 'CATEGORY_BLOCKED_BY_POLICY');
  assert.equal(transformCalls, 0, 'nothing was transformed');
  assert.ok(result.detail.includes('SSN'));
  assert.ok(!result.detail.includes(SYNTHETIC_PHI.ssn ?? '\u0000'));
  const s = JSON.stringify(deps.evidence.list()).toLowerCase();
  for (const v of Object.values(SYNTHETIC_PHI)) assert.ok(!s.includes(String(v).toLowerCase()));
  assert.ok(PIPELINE_DENY_CODES.includes('CATEGORY_BLOCKED_BY_POLICY'));
});

test('block does not touch a document without that category', async () => {
  const { result } = await govern(withCategories({ PAYMENT_CARD: 'block' }));
  assert.equal(result.outcome, 'SANITIZE');
});

test('block does not touch a clear document', async () => {
  const { result } = await govern(withCategories({ SSN: 'block' }), buildCleanText());
  assert.equal(result.outcome, 'ALLOW');
});

test('flag: tokenized exactly as the default, and the release is marked for review', async () => {
  const base = await govern(HEALTHCARE_REFERENCE_POLICY);
  const { result, deps } = await govern(withCategories({ DATE: 'flag', SSN: 'flag' }));
  assert.equal(result.outcome, 'SANITIZE');
  assert.equal(result.releaseText, base.result.releaseText, 'flag releases the same bytes as tokenize');
  assert.deepEqual(result.artifact.flaggedCategories, ['DATE', 'SSN']);
  const auth = deps.evidence.list().map((e) => e.entry ?? e).find((e) => e.type === 'egress_authorized');
  assert.deepEqual(auth.flaggedCategories, ['DATE', 'SSN']);
});

test('no categories configured: behavior is unchanged and nothing is flagged', async () => {
  const { result, deps } = await govern(HEALTHCARE_REFERENCE_POLICY);
  assert.equal(result.outcome, 'SANITIZE');
  assert.equal('flaggedCategories' in result.artifact, false);
  const auth = deps.evidence.list().map((e) => e.entry ?? e).find((e) => e.type === 'egress_authorized');
  assert.equal('flaggedCategories' in auth, false);
});
