/**
 * Detection signals — the stricter-only seed seam (detector 0.5.0).
 *
 * Every test drives a FAKE signal. No model runs here and none is registered
 * anywhere in production; the real-model conformance run is a separate,
 * offline lane. What these tests pin is the contract a real model would be
 * held to:
 *
 *   - seeds only ever add findings (the seeded scan covers the unseeded scan),
 *   - a seeded name is tokenized everywhere, as one person,
 *   - every way a signal can fall short refuses, with the transformer never run,
 *   - a detector that claims to take seeds but ignores or weakens them refuses,
 *   - the verification rescan never sees seeds,
 *   - the record carries identity and counts, never content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scanText, acceptSeed, createPatternDetector, DETECTOR_INFO } from '../src/detection/pattern-detector.mjs';
import { SIGNAL_DENY_CODES, SIGNAL_WORD_CEILING } from '../src/detection/signals.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../src/evidence/log.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';
import { governDocumentEgress } from '../src/pipeline.mjs';
import { buildRecordText } from '../fixtures/synthetic-patient-record.mjs';

const INFO = Object.freeze({
  name: 'fake-signal',
  version: '0.0.1',
  model: 'fake/model',
  revision: 'deadbeef',
  threshold: 0.5,
  chunk: { maxWords: 200, overlap: 50 },
});

/** A signal that seeds every occurrence of the given words, as names. */
function wordSignal(words, category = 'PATIENT_NAME') {
  const calls = [];
  return {
    calls,
    info: INFO,
    async propose(text) {
      calls.push(text);
      const seeds = [];
      for (const w of words) {
        for (let i = text.indexOf(w); i !== -1; i = text.indexOf(w, i + 1)) {
          seeds.push({ category, start: i, end: i + w.length });
        }
      }
      return { seeds };
    },
  };
}

function spyTransformer() {
  const inner = createTokenizingTransformer();
  const t = { calls: 0, async transform(...a) { t.calls += 1; return inner.transform(...a); } };
  return t;
}

async function prepare(text, deps = {}, prompt = 'Summarize the document.') {
  const transformer = deps.transformer ?? spyTransformer();
  const result = await prepareDocumentForEgress({
    source: { bytes: Buffer.from(text, 'utf8'), mimeType: 'text/plain' },
    prompt,
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'appeal_drafting',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'test',
    deps: { detector: createPatternDetector(), ...deps, transformer },
  });
  return { result, transformer };
}

// ── closed vocabulary ─────────────────────────────────────────────────────

test('SIGNAL_DENY_CODES equals the codes signals.mjs raises', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/detection/signals.mjs', import.meta.url)), 'utf8')
    .replace(/export const SIGNAL_DENY_CODES = Object\.freeze\(\[[\s\S]*?\]\);/, '');
  const found = [...new Set([...src.matchAll(/new DetectionSignalError\(\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]))].sort();
  assert.ok(found.length > 0, 'the scan found no raise sites');
  assert.deepEqual([...SIGNAL_DENY_CODES].sort(), found);
});

test('the detector carries the seed contract (since 0.5.0)', () => {
  const [major, minor] = DETECTOR_INFO.version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 5, `detector ${DETECTOR_INFO.version} predates the seed contract`);
  assert.equal(createPatternDetector().acceptsSeeds, true);
});

// ── stricter-only ─────────────────────────────────────────────────────────

test('without seeds, the scan is exactly the unseeded scan', () => {
  const t = buildRecordText();
  assert.deepEqual(scanText(t, {}), scanText(t));
  assert.deepEqual(scanText(t, { seeds: [] }), scanText(t));
});

test('the seeded scan covers the unseeded scan, over randomized seed sets', () => {
  // A small deterministic PRNG so the property is reproducible.
  let x = 0x2f6b3c1d;
  const rnd = (n) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
  const texts = [
    buildRecordText(),
    'Seen by Dr. Varga. Grace called about the bill. Wire the refund to 000123456789.\n\nRegards,\nTamsin Oyelaran',
    'Patient: Ottoline Varga\nSSN 123-45-6789\nThe Oyelaran family asked for a copy.',
  ];
  for (const text of texts) {
    const plain = scanText(text);
    for (let trial = 0; trial < 60; trial++) {
      const seeds = [];
      for (let k = rnd(5); k > 0; k--) {
        const start = rnd(text.length - 1);
        const end = Math.min(text.length, start + 1 + rnd(24));
        seeds.push({ category: rnd(2) ? 'PATIENT_NAME' : 'FINANCIAL_ACCOUNT', start, end });
      }
      const seeded = scanText(text, { seeds });
      for (const f of plain.findings) {
        assert.ok(
          seeded.findings.some((g) => g.start <= f.start && g.end >= f.end),
          `an unseeded ${f.category} at ${f.start}-${f.end} is not covered with seeds ${JSON.stringify(seeds)}`,
        );
      }
      for (const s of seeds) {
        const r = acceptSeed(text, s);
        if (!r.ok) continue;
        assert.ok(seeded.findings.some((g) => g.start <= r.seed.start && g.end >= r.seed.end), 'an accepted seed is not covered');
      }
    }
  }
});

test('a seed that partly overlaps a detector finding widens to cover both', () => {
  // "Ms." rather than "Dr.": since 0.8.0 a doctor's name is kept by default
  // (provider), and this test is about widening, not about providers.
  const text = 'Called Ms. Varga today.';
  assert.deepEqual(scanText(text).findings.map((f) => f.value), ['Varga']);
  // The seed covers "Ms. Var" only; the union must still cover all of "Varga".
  const i = text.indexOf('Ms.');
  const seeded = scanText(text, { seeds: [{ category: 'PATIENT_NAME', start: i, end: i + 7 }] });
  assert.ok(seeded.findings.some((f) => f.value === 'Ms. Varga'), JSON.stringify(seeded.findings));
});

// ── what a seed does ──────────────────────────────────────────────────────

test('a seeded name the detector misses is tokenized everywhere, as one person', async () => {
  const text = 'Grace called on Monday. The billing office returned the call to Grace on Friday.';
  assert.deepEqual(scanText(text).findings, [], 'precondition: 0.4.0 rules alone miss a bare word-name');
  const signal = wordSignal(['Grace']);
  const { result } = await prepare(text, { signals: [signal] });
  assert.equal(result.outcome, 'PREPARED', result.reasonCode);
  assert.ok(!result.releaseText.includes('Grace'), result.releaseText);
  const tokens = result.releaseText.match(/\[PATIENT_\d+\]/g);
  assert.equal(tokens.length, 2);
  assert.equal(new Set(tokens).size, 1, 'one person, one token');
});

test('a seed only once still propagates to the other mentions', async () => {
  const text = 'Faith called about the bill. Later Faith asked for a copy.';
  const once = {
    info: INFO,
    // It also runs on the prompt, where the word is absent: no seed, not -1.
    async propose(t) { const i = t.indexOf('Faith'); return { seeds: i < 0 ? [] : [{ category: 'PATIENT_NAME', start: i, end: i + 5 }] }; },
  };
  const { result } = await prepare(text, { signals: [once] });
  assert.equal(result.outcome, 'PREPARED', result.reasonCode);
  assert.ok(!result.releaseText.includes('Faith'), result.releaseText);
});

test('a seed inside a known name joins that entity', () => {
  const text = 'Patient: Thaddeus Quillfeather\nLater Quillfeather called.';
  const i = text.lastIndexOf('Quillfeather');
  const r = scanText(text, { seeds: [{ category: 'PATIENT_NAME', start: i, end: i + 12 }] });
  const keys = new Set(r.findings.filter((f) => f.category === 'PATIENT_NAME').map((f) => f.entityKey));
  assert.equal(keys.size, 1);
});

test('an account seed is tokenized; a content-rejected seed is counted, never a refusal', async () => {
  const text = 'The member asked us to use 4417023391 and code 12 for the adjustment.';
  const signal = {
    info: INFO,
    async propose(t) {
      const a = t.indexOf('4417023391');
      const b = t.indexOf('12 for');
      if (a < 0) return { seeds: [] }; // the prompt
      return { seeds: [
        { category: 'FINANCIAL_ACCOUNT', start: a, end: a + 10 },
        { category: 'FINANCIAL_ACCOUNT', start: b, end: b + 2 }, // two digits: rejected
        { category: 'PATIENT_NAME', start: b, end: b + 2 }, // no letter: rejected
      ] };
    },
  };
  const { result } = await prepare(text, { signals: [signal] });
  assert.equal(result.outcome, 'PREPARED', result.reasonCode);
  assert.ok(!result.releaseText.includes('4417023391'));
  assert.ok(result.releaseText.includes('code 12'));
  const [report] = result.artifact.detectionSignals;
  assert.equal(report.proposed, 3);
  assert.equal(report.accepted, 1);
  assert.equal(report.rejected, 2);
});

// ── fail closed ───────────────────────────────────────────────────────────

async function assertRefused(deps, reasonCode, text = 'Grace called about the bill.') {
  const { result, transformer } = await prepare(text, deps);
  assert.equal(result.outcome, 'DENY');
  assert.equal(result.reasonCode, reasonCode, result.detail);
  assert.equal(transformer.calls, 0, 'the transformer must never run on a refusal');
  return result;
}

test('a signal that throws refuses', async () => {
  await assertRefused({ signals: [{ info: INFO, async propose() { throw new Error('model crashed'); } }] }, 'DETECTION_SIGNAL_UNAVAILABLE');
});

test('a signal that hangs refuses on the timeout', async () => {
  const hang = { info: INFO, propose: () => new Promise(() => {}) };
  await assertRefused({ signals: [hang], signalTimeoutMs: 20 }, 'DETECTION_SIGNAL_UNAVAILABLE');
});

test('malformed signal output refuses', async () => {
  for (const out of [
    null,
    {},
    { seeds: 'Grace' },
    { seeds: [{ category: 'PATIENT_NAME', start: 0, end: 999 }] },
    { seeds: [{ category: 'SSN', start: 0, end: 5 }] },
    { seeds: [{ category: 'PATIENT_NAME', start: 1.5, end: 3 }] },
  ]) {
    await assertRefused({ signals: [{ info: INFO, async propose() { return out; } }] }, 'DETECTION_SIGNAL_UNAVAILABLE');
  }
});

test('a signal missing its identity refuses', async () => {
  await assertRefused({ signals: [{ info: { name: 'x' }, async propose() { return { seeds: [] }; } }] }, 'DETECTION_SIGNAL_UNAVAILABLE');
  await assertRefused({ signals: [{ async propose() { return { seeds: [] }; } }] }, 'DETECTION_SIGNAL_UNAVAILABLE');
});

test('input over the word ceiling refuses before the signal runs', async () => {
  const signal = wordSignal(['Grace']);
  const big = 'word '.repeat(SIGNAL_WORD_CEILING + 1);
  await assertRefused({ signals: [signal] }, 'DETECTION_SIGNAL_INPUT_TOO_LARGE', big);
  assert.equal(signal.calls.length, 0);
});

test('a detector that does not declare seed support refuses', async () => {
  const inner = createPatternDetector();
  const detector = { info: inner.info, scan: (t) => inner.scan(t) };
  await assertRefused({ detector, signals: [wordSignal(['Grace'])] }, 'DETECTION_SIGNAL_NOT_APPLIED');
});

test('a detector that claims seed support but ignores the seeds refuses', async () => {
  const inner = createPatternDetector();
  const detector = { info: inner.info, acceptsSeeds: true, scan: (t) => inner.scan(t) };
  await assertRefused({ detector, signals: [wordSignal(['Grace'])] }, 'DETECTION_SIGNAL_NOT_APPLIED');
});

test('a detector that drops an unseeded finding when seeded refuses', async () => {
  const inner = createPatternDetector();
  const detector = {
    info: inner.info,
    acceptsSeeds: true,
    async scan(t, options) {
      const r = await inner.scan(t, options);
      if (!options?.seeds) return r;
      const findings = r.findings.filter((f) => f.category !== 'SSN');
      return { ...r, findings, findingsCount: findings.length };
    },
  };
  await assertRefused({ detector, signals: [wordSignal(['Grace'])] }, 'DETECTION_SIGNAL_NOT_APPLIED', 'Grace, SSN 123-45-6789, called.');
});

// ── the prompt (D4) ───────────────────────────────────────────────────────

test('a name the signal finds in the prompt refuses the prompt', async () => {
  const { result } = await prepare('The claim was paid in full.', { signals: [wordSignal(['Grace'])] }, "Summarize Grace's account.");
  assert.equal(result.outcome, 'DENY');
  assert.equal(result.reasonCode, 'PROMPT_CONTAINS_SENSITIVE_DATA');
  assert.equal(result.artifact.detectionSignals[0].promptAccepted, 1);
});

// ── verification and records ──────────────────────────────────────────────

test('the verification rescan never receives seeds', async () => {
  const seen = [];
  const inner = createPatternDetector();
  const verifierDetector = { info: inner.info, async scan(t, options) { seen.push(options); return inner.scan(t); } };
  const { result } = await prepare('Grace called about the bill.', { signals: [wordSignal(['Grace'])], verifierDetector });
  assert.equal(result.outcome, 'PREPARED', result.reasonCode);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((o) => o === undefined), JSON.stringify(seen));
});

test('the NFKC reveal check reads the unseeded scan', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/pipeline.mjs', import.meta.url)), 'utf8');
  assert.match(src, /normalizationRevealsFindings\(plainDetection, nfkcDetection\)/);
});

test('reports and evidence carry identity and counts, never content', async () => {
  const deps = {
    detector: createPatternDetector(),
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
    signals: [wordSignal(['Grace'])],
  };
  const text = 'Grace called about the bill on Monday.';
  const out = await governDocumentEgress({
    source: { text },
    prompt: 'Summarize the document.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'appeal_drafting',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'test',
    deps,
  });
  assert.equal(out.outcome, 'SANITIZE', out.reasonCode);
  const report = out.artifact.detectionSignals[0];
  assert.deepEqual(Object.keys(report).sort(), [
    'accepted', 'chunk', 'model', 'name', 'promptAccepted', 'promptProposed', 'proposed', 'rejected', 'revision', 'threshold', 'version',
  ]);
  const entry = deps.evidence.list().find((e) => e.type === 'egress_authorized');
  assert.deepEqual(entry.detectionSignals, out.artifact.detectionSignals);
  const log = JSON.stringify(deps.evidence.list());
  assert.ok(!log.includes('Grace'), 'no seeded value in evidence');
});

test('unknown identity keys a signal declares are not recorded', async () => {
  const signal = { info: { ...INFO, note: 'Grace', raw: { x: 1 } }, async propose() { return { seeds: [] }; } };
  const { result } = await prepare('The claim was paid.', { signals: [signal] });
  assert.equal(result.outcome, 'PREPARED', result.reasonCode);
  const report = result.artifact.detectionSignals[0];
  assert.equal(report.note, undefined);
  assert.equal(report.raw, undefined);
});

test('with no signal configured, no signal record exists', async () => {
  const { result } = await prepare('Grace called about the bill.');
  assert.equal(result.outcome, 'PREPARED');
  assert.equal(result.artifact.detectionSignals, undefined);
  assert.ok(result.releaseText.includes('Grace'), 'detector-only behaviour is unchanged: a bare word-name is still a documented gap');
});

// ── seed content rules, from the real-model conformance run ────────────────

test('role words and lower-case words are not name seeds; real names are', () => {
  const t = 'The patient and the member spoke to the reviewer. Patient Accounts called. Faith called. 张伟 called. J. Okafor signed.';
  const at = (s, n = 0) => { let i = -1; for (let k = 0; k <= n; k++) i = t.indexOf(s, i + 1); return { category: 'PATIENT_NAME', start: i, end: i + s.length }; };
  assert.deepEqual(acceptSeed(t, at('patient')), { ok: false, reason: 'NO_CAPITAL' });
  assert.deepEqual(acceptSeed(t, at('reviewer')), { ok: false, reason: 'NO_CAPITAL' });
  assert.deepEqual(acceptSeed(t, at('Patient Accounts')), { ok: false, reason: 'COMMON_WORD' });
  assert.equal(acceptSeed(t, at('Faith')).ok, true);
  assert.equal(acceptSeed(t, at('张伟')).ok, true, 'an uncased script needs no capital');
  assert.equal(acceptSeed(t, at('J. Okafor')).ok, true);
});

test('a document full of role words releases, with the role words intact', async () => {
  const text = 'The patient asked the reviewer about the member balance. Grace called later.';
  const signal = {
    info: INFO,
    async propose(t) {
      const seeds = [];
      for (const w of ['patient', 'reviewer', 'member', 'Grace']) {
        const i = t.indexOf(w);
        if (i >= 0) seeds.push({ category: 'PATIENT_NAME', start: i, end: i + w.length });
      }
      return { seeds };
    },
  };
  const { result } = await prepare(text, { signals: [signal] });
  assert.equal(result.outcome, 'PREPARED', result.reasonCode);
  assert.ok(result.releaseText.includes('The patient asked the reviewer about the member balance.'));
  assert.ok(!result.releaseText.includes('Grace'));
  assert.equal(result.artifact.detectionSignals[0].rejected, 3);
});
