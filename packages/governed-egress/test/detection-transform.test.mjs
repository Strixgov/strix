import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer, TransformationError } from '../src/transformation/tokenizing-transformer.mjs';
import { verifySanitizedArtifact, VERIFICATION_PROVES } from '../src/verification/verify.mjs';
import { sha256Hex } from '../src/artifact/hash.mjs';
import { buildRecordText, buildCleanText, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const text = buildRecordText();

test('the fixture record yields findings across the expected categories', () => {
  const r = scanText(text);
  assert.equal(r.detected, true);
  assert.ok(r.findingsCount >= 12, `expected >=12 findings, got ${r.findingsCount}`);
  for (const cat of ['PATIENT_NAME', 'DATE', 'MRN', 'SSN', 'PHONE', 'EMAIL', 'ADDRESS', 'INSURANCE_ID']) {
    assert.ok(r.categories.includes(cat), `missing category ${cat}`);
  }
});

test('detection is deterministic (identical results across scans)', () => {
  assert.deepEqual(scanText(text), scanText(text));
});

test('clean text yields zero findings', () => {
  const r = scanText(buildCleanText());
  assert.equal(r.detected, false);
  assert.equal(r.findingsCount, 0);
});

test('every occurrence of the patient name shares one entity key (label, free text, last name)', () => {
  const r = scanText(text);
  const names = r.findings.filter((f) => f.category === 'PATIENT_NAME');
  assert.ok(names.length >= 3, 'expected the labeled name, the prose repeat, and the Mr. <last> reference');
  const keys = new Set(names.map((f) => f.entityKey));
  assert.equal(keys.size, 1);
});

test('findings are non-overlapping and in-bounds', () => {
  const r = scanText(text);
  const sorted = [...r.findings].sort((a, b) => a.start - b.start);
  let last = -1;
  for (const f of sorted) {
    assert.ok(f.start >= last, 'overlap detected');
    assert.ok(f.end <= text.length);
    last = f.end;
  }
});

test('tokenization is entity-consistent: same entity -> same token, distinct entities -> distinct tokens', async () => {
  const detection = scanText(text);
  const t = await createTokenizingTransformer().transform(text, detection);
  const patientTokens = t.text.match(/\[PATIENT_\d{3}\]/g);
  assert.ok(patientTokens.length >= 3);
  assert.equal(new Set(patientTokens).size, 1, 'one patient entity must map to exactly one token');
  const phoneTokens = t.text.match(/\[PHONE_\d{3}\]/g);
  assert.equal(new Set(phoneTokens).size, 1, 'the repeated phone number must reuse its token');
  const dateTokens = new Set(t.text.match(/\[DATE_\d{3}\]/g));
  assert.ok(dateTokens.size >= 3, 'distinct dates must receive distinct tokens');
});

test('tokenization preserves the non-identifier clinical content', async () => {
  const detection = scanText(text);
  const t = await createTokenizingTransformer().transform(text, detection);
  assert.ok(t.text.includes('comprehensive metabolic panel'));
  assert.ok(t.text.includes('results reviewed with the patient'));
  assert.equal(t.transformedCount, t.detectedCount);
});

test('the transformation mapping summary carries category+token only, never raw values', async () => {
  const detection = scanText(text);
  const t = await createTokenizingTransformer().transform(text, detection);
  const serialized = JSON.stringify(t.mappings).toLowerCase();
  for (const value of Object.values(SYNTHETIC_PHI)) {
    assert.ok(!serialized.includes(String(value).toLowerCase()), `raw value leaked into mappings: ${value}`);
  }
});

test('an unmapped detection category REFUSES rather than bucketing', async () => {
  const finding = { category: 'NOT_A_CATEGORY', start: 0, end: 3, value: 'abc' };
  await assert.rejects(
    createTokenizingTransformer().transform('abcdef', { findings: [finding] }),
    (err) => err instanceof TransformationError && err.reasonCode === 'UNKNOWN_CATEGORY',
  );
});

test('overlapping or out-of-bounds findings REFUSE rather than partially applying', async () => {
  const overlapping = [
    { category: 'DATE', start: 0, end: 5, value: 'aaaaa' },
    { category: 'DATE', start: 3, end: 8, value: 'bbbbb' },
  ];
  await assert.rejects(
    createTokenizingTransformer().transform('aaaaabbbbb', { findings: overlapping }),
    (err) => err instanceof TransformationError && err.reasonCode === 'OVERLAPPING_FINDINGS',
  );
});

test('verification passes a properly sanitized record with zero remaining findings', async () => {
  const detection = scanText(text);
  const t = await createTokenizingTransformer().transform(text, detection);
  const v = await verifySanitizedArtifact({
    text: t.text,
    originalFindings: detection.findings,
    detector: createPatternDetector(),
  });
  assert.equal(v.status, 'passed');
  assert.equal(v.remainingProhibitedFindings, 0);
  assert.equal(v.residualValueFindings, 0);
  assert.equal(v.scannedHash, sha256Hex(t.text));
  assert.equal(v.proves, VERIFICATION_PROVES);
});

test('verification FAILS an identity "transformation" (raw text presented as sanitized)', async () => {
  const detection = scanText(text);
  const v = await verifySanitizedArtifact({
    text, // unchanged — the transformer graded itself and lied
    originalFindings: detection.findings,
    detector: createPatternDetector(),
  });
  assert.equal(v.status, 'failed');
  assert.ok(v.remainingProhibitedFindings > 0);
});

test('verification catches a leaked raw value the rescan alone cannot see', async () => {
  // A raw patient name whose "Patient:" label was tokenized away is
  // invisible to a rescan (the label was its detection seed). The
  // independent original-value check must catch it — this case is the
  // reason that check exists.
  const detection = scanText(text);
  const t = await createTokenizingTransformer().transform(text, detection);
  // The surname alone: since detector 0.3.0 the full name would be re-found
  // unlabelled (William is a lexicon given name), which is good detection
  // but would no longer isolate the value check this test exists for.
  const surname = SYNTHETIC_PHI.patientName.split(' ').pop();
  const leaked = `${t.text}\nAddendum: reviewed by the patient ${surname} in person.`;
  const rescan = scanText(leaked);
  const nameRefound = rescan.findings.some(
    (f) => f.category === 'PATIENT_NAME' && f.value.toLowerCase().includes('sampleton'),
  );
  assert.equal(nameRefound, false, 'precondition: the rescan alone must NOT re-find the unlabeled name — if it does, this test no longer proves the value check earns its keep');
  const v = await verifySanitizedArtifact({
    text: leaked,
    originalFindings: detection.findings,
    detector: createPatternDetector(),
  });
  assert.equal(v.status, 'failed');
  assert.ok(v.residualValueFindings > 0);
});

test('a throwing detector propagates (the caller must treat it as DENY)', async () => {
  await assert.rejects(
    verifySanitizedArtifact({
      text: 'x',
      originalFindings: [],
      detector: { scan: async () => { throw new Error('detector down'); } },
    }),
    /detector down/,
  );
});
