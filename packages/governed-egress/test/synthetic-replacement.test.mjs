/**
 * Synthetic same-type replacement (local mode only).
 *
 * Proven with the SYNTHETIC_PHI needles: no original value is released; the
 * generated values are fictional by construction; verification masks only
 * the generated spans and still catches a real value; the kernel path
 * refuses up front; re-identification and the response scan understand the
 * generated values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governDocumentEgress, prepareDocumentForEgress } from '../src/pipeline.mjs';
import { governedAnthropicDocumentRequest } from '../src/adapters/anthropic/index.mjs';
import {
  createSyntheticTransformer,
  syntheticValueFor,
  SYNTHETIC_CATEGORIES,
} from '../src/transformation/synthetic-transformer.mjs';
import { createTokenizingTransformer, createReplacingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { verifySanitizedArtifact, maskSpans, VERIFICATION_INFO } from '../src/verification/verify.mjs';
import { reidentifyResponse, ReidentificationError } from '../src/reidentification/reidentify.mjs';
import { validateEgressPolicy, replacementMode } from '../src/policy/policy.mjs';
import { createPatternDetector, scanText } from '../src/detection/pattern-detector.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../src/evidence/log.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { buildRecordText, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const PROMPT = 'Summarize the encounter for the requesting physician.';
const NEEDLES = Object.values(SYNTHETIC_PHI).map((v) => String(v).toLowerCase());
const DEST = { provider: 'anthropic', service: 'claude' };

const SYNTHETIC_POLICY = (() => {
  const p = structuredClone(HEALTHCARE_REFERENCE_POLICY);
  p.policyId = 'synthetic-replacement-test';
  p.dataEgress.externalAI.phi.replacement = 'synthetic';
  return p;
})();

function makeDeps(extra = {}) {
  return {
    detector: createPatternDetector(),
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
    ...extra,
  };
}

const leaked = (v) => NEEDLES.filter((n) => JSON.stringify(v).toLowerCase().includes(n));

async function governLocal(policy = SYNTHETIC_POLICY, deps = makeDeps()) {
  const r = await governDocumentEgress({ source: { text: buildRecordText() }, prompt: PROMPT, destination: DEST, purpose: 'clinical_summary', policy, deps });
  return { r, deps };
}

test('policy: replacement is token by default; synthetic accepted; anything else refused', () => {
  assert.equal(replacementMode(validateEgressPolicy(HEALTHCARE_REFERENCE_POLICY)), 'token');
  assert.equal(replacementMode(validateEgressPolicy(SYNTHETIC_POLICY)), 'synthetic');
  const bad = structuredClone(SYNTHETIC_POLICY);
  bad.dataEgress.externalAI.phi.replacement = 'realistic';
  assert.throws(() => validateEgressPolicy(bad), (e) => e.reasonCode === 'POLICY_REPLACEMENT_UNSUPPORTED');
});

test('local mode: names, phones and emails become fictional values; everything else stays a token; nothing original leaves', async () => {
  const { r, deps } = await governLocal();
  assert.equal(r.outcome, 'SANITIZE');
  assert.match(r.releaseText, /Avery Quillfeather/);
  assert.match(r.releaseText, /555-555-01\d\d/);
  assert.match(r.releaseText, /@example\.invalid/);
  assert.match(r.releaseText, /\[SSN_001\]/, 'an SSN is never given a realistic stand-in');
  assert.match(r.releaseText, /\[MRN_001\]/);
  assert.deepEqual(leaked(r.releaseText), [], 'release text');
  assert.deepEqual(leaked(r.artifact), [], 'artifact');
  assert.deepEqual(leaked(deps.evidence.list()), [], 'evidence');
  assert.equal(r.artifact.verification.status, 'passed');
  assert.equal(r.artifact.transformation.engine, 'strix-synthetic-replacer');
});

test('deterministic: the same document releases the same bytes', async () => {
  const a = await governLocal();
  const b = await governLocal();
  assert.equal(a.r.releaseText, b.r.releaseText);
});

test('the kernel path refuses synthetic replacement before anything is decided', async () => {
  const r = await prepareDocumentForEgress({ source: { text: buildRecordText() }, prompt: PROMPT, destination: DEST, purpose: 'clinical_summary', policy: SYNTHETIC_POLICY, deps: makeDeps() });
  assert.equal(r.outcome, 'DENY');
  assert.equal(r.reasonCode, 'SYNTHETIC_REPLACEMENT_LOCAL_ONLY');
});

test('a clear document is unaffected on the kernel path', async () => {
  const r = await prepareDocumentForEgress({ source: { text: 'Routine note with no identifiers.' }, prompt: 'Summarize.', destination: DEST, purpose: 'clinical_summary', policy: SYNTHETIC_POLICY, deps: makeDeps() });
  assert.equal(r.outcome, 'PREPARED');
});

test('generator: only the three fictional categories, capacity is bounded, and a value in the source is never used', () => {
  assert.deepEqual([...SYNTHETIC_CATEGORIES], ['PATIENT_NAME', 'PHONE', 'EMAIL']);
  for (const c of ['SSN', 'MRN', 'DATE', 'ADDRESS', 'PAYMENT_CARD', 'INSURANCE_ID']) assert.equal(syntheticValueFor(c, 1), null, c);
  assert.equal(syntheticValueFor('PATIENT_NAME', 101), null);
  assert.equal(syntheticValueFor('PATIENT_NAME', 1, 'a note from avery about x'), null, 'name part already in the source');
  assert.equal(syntheticValueFor('PHONE', 1, 'call 555-555-0100'), null);
  assert.equal(syntheticValueFor('PHONE', 1), '555-555-0100');
});

test('a collision falls back to the token for that entity', async () => {
  const text = 'Patient: Jane Doe\nNote: Avery reviewed the chart.';
  const d = scanText(text);
  const out = await createSyntheticTransformer().transform(text, d);
  assert.match(out.text, /\[PATIENT_001\]/);
  assert.doesNotMatch(out.text, /Avery Quillfeather/);
});

test('verification masks only the given spans, and still catches a real value outside them', async () => {
  const detector = createPatternDetector();
  const text = 'Phone: 555-555-0100. Other phone: 615-555-0142.';
  const spans = [{ start: 7, end: 19 }];
  assert.equal(maskSpans(text, spans).slice(7, 19).trim(), '');
  const v = await verifySanitizedArtifact({ text, originalFindings: [], detector, maskedSpans: spans });
  assert.equal(v.status, 'failed', 'the unmasked real phone is still found');
  assert.throws(() => maskSpans(text, [{ start: 10, end: 5 }]));
  assert.throws(() => maskSpans(text, [{ start: 0, end: 999 }]));
  assert.equal(VERIFICATION_INFO.version, '0.4.0');
});

test('a replacer that reports a span over a REAL value cannot hide it from the containment check', async () => {
  // Leaves the name in place but reports it as a generated span.
  const lying = createReplacingTransformer({
    engine: { name: 'lying', version: '0' },
    replacementFor: (category, n) => (category === 'PATIENT_NAME' ? SYNTHETIC_PHI.patientName : null),
  });
  const { r } = await governLocal(SYNTHETIC_POLICY, makeDeps({ syntheticTransformer: lying }));
  assert.equal(r.outcome, 'DENY');
  assert.equal(r.reasonCode, 'VERIFICATION_FAILED');
});

test('re-identification: v2 key restores generated values as whole words, and tokens as before', async () => {
  const { r } = await governLocal();
  const key = r.reidentification;
  assert.equal(key.keyVersion, 2);
  const nameEntry = key.entries.find((e) => e.kind === 'synthetic' && e.category === 'PATIENT_NAME');
  const ssnEntry = key.entries.find((e) => e.kind === 'token' && e.category === 'SSN');
  const answer = `${nameEntry.token} is stable; ${ssnEntry.token} on file. Not a name: ${nameEntry.token}son.`;
  const { text, report } = reidentifyResponse({ responseText: answer, key, releasedArtifactHash: key.releaseHash });
  assert.ok(text.startsWith(`${SYNTHETIC_PHI.patientName} is stable; ${SYNTHETIC_PHI.ssn} on file.`));
  assert.ok(text.endsWith(`${nameEntry.token}son.`), 'a generated value inside a longer word is not restored');
  assert.equal(report.restoredOccurrences, 2);
});

test('a v2 key entry without a kind, or a synthetic entry shaped like a token, refuses', async () => {
  const { r } = await governLocal();
  const key = r.reidentification;
  for (const entries of [
    [{ token: 'Avery Quillfeather', category: 'PATIENT_NAME', value: 'x' }],
    [{ token: '[PATIENT_001]', category: 'PATIENT_NAME', value: 'x', kind: 'synthetic' }],
  ]) {
    assert.throws(
      () => reidentifyResponse({ responseText: 'x', key: { ...key, entries }, releasedArtifactHash: key.releaseHash }),
      (e) => e instanceof ReidentificationError && e.reasonCode === 'KEY_MALFORMED',
    );
  }
});

test('adapter: an answer repeating the generated values scans clean, and re-identifies', async () => {
  const deps = makeDeps();
  const transport = {
    name: 'spy',
    async send(p) {
      const name = p.documentText.match(/Avery Quillfeather/)[0];
      const phone = p.documentText.match(/555-555-01\d\d/)[0];
      return { responseText: `Call ${name} at ${phone}.` };
    },
  };
  const result = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText() }, prompt: PROMPT, policy: SYNTHETIC_POLICY, deps, transport,
    scanResponse: { onFindings: 'withhold' }, reidentify: true,
  });
  assert.equal(result.responseScan.status, 'clean');
  assert.equal(result.reidentifiedResponse, `Call ${SYNTHETIC_PHI.patientName} at ${SYNTHETIC_PHI.phone}.`);
  assert.deepEqual(leaked(deps.evidence.list()), []);
});

test('adapter: a real-looking identifier the model invented is still found in synthetic mode', async () => {
  const deps = makeDeps();
  const transport = { name: 'spy', async send() { return { responseText: 'Call Avery Quillfeather at 615-555-0142.' }; } };
  const result = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText() }, prompt: PROMPT, policy: SYNTHETIC_POLICY, deps, transport, scanResponse: true,
  });
  assert.equal(result.responseScan.status, 'findings');
  assert.deepEqual([...result.responseScan.categories], ['PHONE']);
});
