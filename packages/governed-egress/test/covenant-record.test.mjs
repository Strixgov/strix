/**
 * Covenant evidence record: verdicts are derived from the log, three-state,
 * worst-of, PHI-free, and re-derivable. Entries come from the REAL pipeline
 * where a real entry is needed, so the record is tested against the shapes the
 * package actually writes, not a hand-built imitation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governedAnthropicDocumentRequest } from '../src/adapters/anthropic/index.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../src/evidence/log.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import {
  buildCovenantEvidenceRecord,
  verifyCovenantRecord,
  COVENANT_TERMS,
  COVENANT_STATUS,
  COVENANT_COVERAGE,
  NOT_ESTABLISHED_REASONS,
} from '../src/evidence/covenant-record.mjs';
import { buildRecordText, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const ALL_TERMS = Object.values(COVENANT_TERMS);
const WINDOW = { windowFrom: '2000-01-01T00:00:00Z', windowTo: '2999-01-01T00:00:00Z' };
const REFS = { insuredRef: 'insured-0001', covenantRef: 'cov-ai-egress-2026' };

async function realLog() {
  const evidence = createInMemoryEvidenceLog();
  const result = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText() },
    prompt: 'Summarize the encounter for the requesting physician.',
    actor: 'analyst@insured.example',
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps: {
      detector: createPatternDetector(),
      transformer: createTokenizingTransformer(),
      store: createInMemoryAuthorizationStore(),
      evidence,
    },
    transport: { name: 'spy', async send() { return { responseText: 'ok' }; } },
  });
  assert.equal(result.released, true, 'precondition: the real pipeline released');
  return evidence;
}

const build = (entries, extra = {}) =>
  buildCovenantEvidenceRecord({ ...REFS, terms: ALL_TERMS, ...WINDOW, entries, ...extra });

test('a real governed release derives SATISFIED on both terms, with the facts it rests on', async () => {
  const log = await realLog();
  const record = build(log.list());
  assert.equal(record.overall, COVENANT_STATUS.SATISFIED);
  for (const t of record.terms) {
    assert.equal(t.status, COVENANT_STATUS.SATISFIED);
    assert.ok(t.examined >= 1, 'a SATISFIED term examined something — not an empty-set pass');
  }
  assert.equal(record.derivedFrom.facts.releasesAuthorized, 1);
  assert.equal(record.derivedFrom.facts.outcomes.disclosed, 1);
  assert.equal(record.derivedFrom.chain.valid, true);
  assert.match(record.derivedFrom.chain.headHash, /^[0-9a-f]{64}$/);
  assert.equal(record.underwriterDeterminationMade, false);
  assert.equal(record.proves, 'LOCAL_UNSIGNED_RECORD');
  assert.deepEqual(record.coverage, COVENANT_COVERAGE);
});

test('the record carries no PHI: needle-free, with the needles proven present in the source', async () => {
  const needles = Object.values(SYNTHETIC_PHI).map((v) => String(v).toLowerCase());
  const source = buildRecordText().toLowerCase();
  for (const n of needles) assert.ok(source.includes(n), `needle "${n}" is real`);
  const serialized = JSON.stringify(build((await realLog()).list())).toLowerCase();
  for (const n of needles) assert.ok(!serialized.includes(n), `"${n}" leaked into the record`);
});

test('an EMPTY window is NOT_ESTABLISHED, never SATISFIED', async () => {
  const log = await realLog();
  const record = build(log.list(), { windowFrom: '1999-01-01T00:00:00Z', windowTo: '1999-02-01T00:00:00Z' });
  assert.equal(record.overall, COVENANT_STATUS.NOT_ESTABLISHED);
  for (const t of record.terms) assert.equal(t.reason, NOT_ESTABLISHED_REASONS.NO_RELEASES_IN_WINDOW);
});

test('a log with zero entries is NOT_ESTABLISHED (the empty-set green)', () => {
  assert.equal(build([]).overall, COVENANT_STATUS.NOT_ESTABLISHED);
});

test('a broken chain is NOT_ESTABLISHED on every term — a tampered log cannot read as compliance', async () => {
  const entries = (await realLog()).list().map((e) => ({ ...e }));
  entries[0] = { ...entries[0], actor: 'someone-else' };
  const record = build(entries);
  assert.equal(record.derivedFrom.chain.valid, false);
  assert.equal(record.overall, COVENANT_STATUS.NOT_ESTABLISHED);
  for (const t of record.terms) assert.equal(t.reason, NOT_ESTABLISHED_REASONS.CHAIN_INVALID);
});

// A BREACH has to be a genuine, correctly chained log (a tampered one is
// NOT_ESTABLISHED above), so build one through the real log's append().
function logWith(authorized) {
  const log = createInMemoryEvidenceLog();
  log.append({ type: 'egress_authorized', initialClassification: 'phi_detected', ...authorized });
  return log.list();
}

test('a release that failed verification is BREACHED on the verification term', () => {
  const record = build(
    logWith({
      transformation: { detectedCount: 4, transformedCount: 4 },
      verification: { result: 'failed', remainingProhibitedFindings: 2 },
    }),
  );
  const t = Object.fromEntries(record.terms.map((x) => [x.term, x]));
  assert.equal(t[COVENANT_TERMS.RELEASES_PASSED_VERIFICATION].status, COVENANT_STATUS.BREACHED);
  assert.equal(t[COVENANT_TERMS.PHI_TRANSFORMED_BEFORE_RELEASE].status, COVENANT_STATUS.SATISFIED);
  assert.equal(record.overall, COVENANT_STATUS.BREACHED);
});

test('PHI classified but not (fully) transformed is BREACHED on the transformation term', () => {
  const partial = build(
    logWith({ transformation: { detectedCount: 5, transformedCount: 3 }, verification: { result: 'passed', remainingProhibitedFindings: 0 } }),
  );
  const none = build(logWith({ verification: { result: 'passed', remainingProhibitedFindings: 0 } }));
  for (const r of [partial, none]) {
    const t = r.terms.find((x) => x.term === COVENANT_TERMS.PHI_TRANSFORMED_BEFORE_RELEASE);
    assert.equal(t.status, COVENANT_STATUS.BREACHED);
  }
});

test('overall is worst-of: a breach outranks an unestablished term', () => {
  const record = build(logWith({ verification: { result: 'failed', remainingProhibitedFindings: 1 }, transformation: { detectedCount: 1, transformedCount: 1 } }));
  assert.equal(record.overall, COVENANT_STATUS.BREACHED);
});

test('inputs are closed: unknown terms, empty terms, free-text refs and bad windows refuse', async () => {
  const entries = (await realLog()).list();
  assert.throws(() => build(entries, { terms: ['ALL_AI_USE_GOVERNED'] }), /registry is closed/);
  assert.throws(() => build(entries, { terms: [] }), /non-empty/);
  assert.throws(() => build(entries, { terms: [ALL_TERMS[0], ALL_TERMS[0]] }), /repeat/);
  assert.throws(() => build(entries, { insuredRef: 'Jane Doe, 12 Elm St' }), /opaque token/);
  assert.throws(() => build(entries, { covenantRef: 'jane@example.com' }), /opaque token/);
  assert.throws(() => build(entries, { windowFrom: 'yesterday' }), /UTC ISO-8601/);
  assert.throws(() => build(entries, { windowFrom: '2999-01-01T00:00:00Z', windowTo: '2000-01-01T00:00:00Z' }), /strictly before/);
});

test('the record is content-addressed: terms order does not change the hash, content does', async () => {
  const entries = (await realLog()).list();
  const a = build(entries, { terms: [...ALL_TERMS] });
  const b = build(entries, { terms: [...ALL_TERMS].reverse() });
  assert.equal(a.recordHash, b.recordHash);
  assert.notEqual(a.recordHash, build(entries, { covenantRef: 'cov-other' }).recordHash);
});

test('verify re-derives from the log and refuses a record whose stored verdict was edited', async () => {
  const entries = (await realLog()).list();
  const good = build(entries);
  assert.deepEqual(verifyCovenantRecord(good, entries), { agrees: true, reasons: [], proves: 'INTERNAL_CONSISTENCY_ONLY' });

  // A breached log, with the stored verdict flipped to SATISFIED and the hash left alone.
  const breachedEntries = logWith({ verification: { result: 'failed', remainingProhibitedFindings: 1 }, transformation: { detectedCount: 1, transformedCount: 1 } });
  const breached = build(breachedEntries);
  const forged = { ...breached, overall: COVENANT_STATUS.SATISFIED };
  const v = verifyCovenantRecord(forged, breachedEntries);
  assert.equal(v.agrees, false);
  assert.ok(v.reasons.includes('OVERALL_VERDICT_DIFFERS'));
  assert.ok(v.reasons.includes('RECORD_HASH_MISMATCH'));

  // Even a re-hashed forgery fails, because the verdict is re-derived rather than read.
  const { recordHash: _drop, ...content } = forged;
  const { canonical } = await import('../src/evidence/log.mjs');
  const { createHash } = await import('node:crypto');
  const rehashed = { ...content, recordHash: `sha256:${createHash('sha256').update(canonical(content), 'utf8').digest('hex')}` };
  const v2 = verifyCovenantRecord(rehashed, breachedEntries);
  assert.equal(v2.agrees, false);
  assert.ok(v2.reasons.includes('NOT_REDERIVABLE_FROM_LOG'));
});

test('verify against a different log than the record was built from disagrees', async () => {
  const record = build((await realLog()).list());
  const other = await realLog();
  other.append({ type: 'egress_denied', reasonCode: 'X' });
  assert.equal(verifyCovenantRecord(record, other.list()).agrees, false);
});

test('verify never throws on garbage and reports it as unreadable', () => {
  const v = verifyCovenantRecord({ nonsense: true }, []);
  assert.equal(v.agrees, false);
  assert.ok(v.reasons[0].startsWith('UNREADABLE_RECORD'));
});
