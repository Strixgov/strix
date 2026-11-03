/**
 * Residual-value containment: a name part inside another word is not the
 * name, but an inflected, possessive or glued form of it is. Every case here
 * was probed against the pre-fix substring rule; the "unchanged" cases are the
 * ones a naive whole-word fix would have lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { containsResidual } from '../src/verification/verify.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';

async function prepare(text) {
  return prepareDocumentForEgress({
    source: { bytes: Buffer.from(text, 'utf8'), mimeType: 'text/plain' },
    prompt: 'Summarize the document.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'appeal_drafting',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'test',
    deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer() },
  });
}

// ── the defect ─────────────────────────────────────────────────────────────

test('a name part inside another word no longer refuses the document', async () => {
  for (const [doc, word] of [
    ['Patient: Ann Lee\nThe care planning meeting is set.', 'planning'],
    ['Patient: Ann Lee\nThe fleet vehicle was billed.', 'fleet'],
    ['Patient: Will Carter\nThe account was written off as goodwill.', 'goodwill'],
  ]) {
    const r = await prepare(doc);
    assert.equal(r.outcome, 'PREPARED', `${doc} -> ${r.reasonCode}`);
    assert.equal(r.artifact.verification.residualValueFindings, 0);
    assert.ok(r.releaseText.includes(word), 'the ordinary word survives');
    assert.ok(!/\bAnn\b|\bLee\b|\bWill\b|\bCarter\b/.test(r.releaseText), r.releaseText);
  }
});

// ── what must still refuse ────────────────────────────────────────────────

test('a surviving whole name part still counts', () => {
  assert.equal(containsResidual('reviewed by lee in person', 'lee'), true);
  assert.equal(containsResidual('lee reviewed it', 'lee'), true);
  assert.equal(containsResidual('(lee)', 'lee'), true);
});

test('an inflected, possessive or glued form still counts (the detector leaves these in place)', async () => {
  assert.equal(containsResidual('счёт для ковальчука', 'ковальчук'), true);
  assert.equal(containsResidual("frank's bill", 'frank'), true);
  assert.equal(containsResidual('the vargas file', 'varga'), true);
  assert.equal(containsResidual('annlee@example.org', 'ann'), true);
  // End to end: propagation tokenizes whole words only, so the inflected
  // surname is still in the text and the release must refuse.
  const r = await prepare('Patient: Оксана Ковальчук\nОплата от Ковальчука получена.');
  assert.equal(r.outcome, 'DENY');
  assert.equal(r.reasonCode, 'VERIFICATION_FAILED');
});

test('a name that starts an ordinary word still refuses (the accepted fail-safe cost)', async () => {
  assert.equal(containsResidual('we spoke frankly', 'frank'), true);
  const r = await prepare('Patient: Frank Lee\nWe spoke frankly about the bill.');
  assert.equal(r.outcome, 'DENY');
  assert.equal(r.reasonCode, 'VERIFICATION_FAILED');
});

test('a digit or underscore before a value does not excuse it', () => {
  assert.equal(containsResidual('user_ann logged in', 'ann'), true);
  assert.equal(containsResidual('ref 12ann', 'ann'), true);
});

test('uncased scripts and digit-led values stay plain substring matches', () => {
  assert.equal(containsResidual('张伟的账单已付', '张伟'), true);
  assert.equal(containsResidual('والحسن حضر', 'الحسن'), true);
  assert.equal(containsResidual('mrn x00123456', '00123456'), true);
});

test('an astral-plane letter before the value is read whole', () => {
  // U+1D400 MATHEMATICAL BOLD CAPITAL A is a letter encoded as a surrogate pair.
  assert.equal(containsResidual('\u{1D400}ann', 'ann'), false);
  assert.equal(containsResidual('\u{1F600}ann', 'ann'), true); // an emoji is not a letter
});

test('a mid-word occurrence does not hide a real one later in the text', () => {
  assert.equal(containsResidual('planning with ann', 'ann'), true);
});

// ── the transformer's own tokens (verification 0.3.0) ─────────────────────

test('a value that is a category word is not found inside the pipeline\'s own token', async () => {
  const { verifySanitizedArtifact } = await import('../src/verification/verify.mjs');
  const v = await verifySanitizedArtifact({
    text: '[PATIENT_001] called about the bill.',
    originalFindings: [{ category: 'PATIENT_NAME', value: 'patient', start: 0, end: 7 }],
    detector: createPatternDetector(),
  });
  assert.equal(v.residualValueFindings, 0);
});

test('only the real token grammar is masked, so a name cannot hide in a look-alike', async () => {
  const { verifySanitizedArtifact } = await import('../src/verification/verify.mjs');
  for (const leaked of ['[GRACE_001] called.', '[PATIENT_1] Grace', 'Grace [PATIENT_001]']) {
    const v = await verifySanitizedArtifact({
      text: leaked,
      originalFindings: [{ category: 'PATIENT_NAME', value: 'Grace', start: 0, end: 5 }],
      detector: createPatternDetector(),
    });
    assert.equal(v.residualValueFindings, 1, leaked);
  }
});
