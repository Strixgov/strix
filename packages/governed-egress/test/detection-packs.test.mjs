import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolvePacks, AVAILABLE_PACKS } from '../src/detection/packs.mjs';
import { scanText, createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { LAB_DEV } from '../accuracy/lab-packs/corpus-dev.mjs';
import { runBenchmark, strixRedactor } from '../accuracy/benchmark.mjs';
import { DOCS } from '../accuracy/corpus.mjs';
import { HELD_OUT } from '../accuracy/corpus-heldout.mjs';
import { LAB_DEV_P2 } from '../accuracy/lab-packs/corpus-dev-p2.mjs';

const PACKS = ['lab-requisition', 'eob-835'];
const ALL = ['lab-requisition', 'eob-835', 'denial-appeal', 'provider-ids'];

test('unknown and duplicated pack ids refuse; the set is closed', () => {
  assert.deepEqual([...AVAILABLE_PACKS].sort(), ['denial-appeal', 'eob-835', 'lab-requisition', 'provider-ids']);
  assert.throws(() => resolvePacks(['denial-appeals']), /unknown detection pack/);
  assert.throws(() => resolvePacks(['eob-835', 'eob-835']), /twice/);
  assert.throws(() => resolvePacks('eob-835'), /array/);
});

test('packs only add findings: every base finding is still there', () => {
  const packs = resolvePacks(PACKS);
  for (const d of [...LAB_DEV, ...LAB_DEV_P2, ...DOCS]) {
    const base = scanText(d.text).findings;
    const withPacks = scanText(d.text, { packs: resolvePacks(ALL) }).findings;
    for (const f of base) {
      assert.ok(withPacks.some((g) => g.start <= f.start && g.end >= f.end), `${d.id}: lost ${f.category} (all packs)`);
    }
  }
  for (const d of [...LAB_DEV, ...DOCS]) {
    const base = scanText(d.text).findings;
    const withPacks = scanText(d.text, { packs }).findings;
    for (const f of base) {
      assert.ok(withPacks.some((g) => g.start <= f.start && g.end >= f.end), `${d.id}: lost ${f.category}`);
    }
  }
});

test('the detector names the packs in force, by version and rule hash', () => {
  const det = createPatternDetector({ packs: PACKS });
  assert.deepEqual(det.info.packs.map((p) => p.id), PACKS);
  for (const p of det.info.packs) assert.match(p.rulesSha256, /^[0-9a-f]{64}$/);
  assert.equal(createPatternDetector().info.packs, undefined);
});

test('a sanitized X12 segment is released, not refused by its own tokens on rescan', async () => {
  const redact = await strixRedactor({ packs: PACKS });
  const out = await redact('CLP*PA0091772*4*120.00*0*0*12*20262390010442~NM1*QC*1*Lindqvist*Rosamund~SVC*HC:80048*120.00*0~');
  assert.ok(!out.refused, 'refused');
  for (const v of ['PA0091772', '20262390010442', 'Lindqvist', 'Rosamund']) assert.ok(!out.released.includes(v), v);
  assert.ok(out.released.includes('80048'));
});

test('on the lab dev split the packs cut survival and keep every preserved code', async () => {
  const [base] = (await runBenchmark(await strixRedactor(), [['dev', LAB_DEV]])).sets;
  const [packed] = (await runBenchmark(await strixRedactor({ packs: PACKS }), [['dev', LAB_DEV]])).sets;
  assert.ok(packed.survived < base.survived, `${packed.survived} vs ${base.survived}`);
  assert.equal(packed.decoysKept, packed.decoys);
  assert.equal(packed.refused, 0);
});

test('no regression on the base corpora with packs on', async () => {
  const r = await runBenchmark(await strixRedactor({ packs: PACKS }), [['main', DOCS], ['held-out', HELD_OUT]]);
  for (const s of r.sets) {
    assert.equal(s.survived, 0, s.corpus);
    assert.equal(s.decoysKept, s.decoys, s.corpus);
  }
});

test('the held-out split has not changed since it was committed ahead of the rules', () => {
  const recorded = readFileSync(new URL('../accuracy/lab-packs/HASHES.md', import.meta.url), 'utf8')
    .match(/corpus-heldout\.mjs` \| [^|]+ \| `([0-9a-f]{64})`/)[1];
  const actual = createHash('sha256').update(readFileSync(new URL('../accuracy/lab-packs/corpus-heldout.mjs', import.meta.url))).digest('hex');
  assert.equal(actual, recorded);
});

/** Findings the packs ADD over the base detector (by span). */
const added = (text, packs) => {
  const base = scanText(text).findings.map((f) => `${f.start}:${f.end}`);
  return scanText(text, { packs: resolvePacks(packs) }).findings.filter((f) => !base.includes(`${f.start}:${f.end}`)).map((f) => f.value);
};
const find = (text, packs, category) => scanText(text, { packs: resolvePacks(packs) }).findings
  .filter((f) => !category || f.category === category).map((f) => f.value);

test('denial-appeal: header references, prose claim numbers, salutations and patient signatures', () => {
  const p = ['denial-appeal'];
  assert.ok(find('Case number: APL-2026-0091846', p, 'OTHER_ID').includes('APL-2026-0091846'));
  assert.ok(find('Our reference: QX/5520193/APPEAL', p, 'OTHER_ID').includes('QX/5520193/APPEAL'));
  assert.ok(find('We appeal claim 20262770031904 today.', p, 'OTHER_ID').includes('20262770031904'));
  assert.ok(find('Dear Ms. Castellanos-Pyke,\nWe', p, 'PATIENT_NAME').includes('Castellanos-Pyke'));
  assert.ok(find('Dear Ruairi Mbeki-Sorensen:\nThe', p, 'PATIENT_NAME').includes('Ruairi Mbeki-Sorensen'));
  assert.ok(find('Thank you,\nHollis Varga-Eze (patient)', p, 'PATIENT_NAME').includes('Hollis Varga-Eze'));
});

test('denial-appeal negative controls: payers, roles, providers and policy ids are kept', () => {
  const p = ['denial-appeal'];
  assert.deepEqual(added('Dear Provider,\nDear Claims Department:\nDear Dr. Ines Halvorsen,', p), []);
  assert.deepEqual(added('The claim was paid for Blue Ridge Health Plan, see policy LAB-2026-114 (CARC 50).', p), []);
  assert.deepEqual(added('Reference range 3.5-5.0 mmol/L; claim CO-45 adjusted.', p), []);
  assert.deepEqual(added('Thanks for Maria Lopez, our new coordinator.', p), []);
});

test('provider-ids: provider identifiers are kept without the pack and replaced with it', async () => {
  const text = 'Rendering provider: Dr. Saoirse Adebayo-Klein, NPI 1999906612\nPatient: Leopold Tran-Whitaker';
  assert.deepEqual(find(text, [], 'PROVIDER_ID'), []);
  const ids = find(text, ['provider-ids'], 'PROVIDER_ID');
  assert.ok(ids.includes('1999906612'));
  assert.ok(ids.includes('Saoirse Adebayo-Klein'));
  const kept = await (await strixRedactor())(text);
  assert.ok(kept.released.includes('1999906612'));
  const out = await (await strixRedactor({ packs: ['provider-ids'] }))(text);
  assert.ok(!out.refused, 'a PROVIDER token must not fail its own rescan');
  assert.ok(!out.released.includes('1999906612') && out.released.includes('[PROVIDER_'));
  assert.ok(!out.released.includes('Saoirse') && !out.released.includes('Leopold'));
  // The provider is labelled as a provider, never as a patient.
  assert.equal((out.released.match(/\[PATIENT_/g) ?? []).length, 1);
});

test('provider-ids negative controls: organisations and a TIN in SSN form', () => {
  assert.deepEqual(find('Billing provider: Cascade Clinical Labs, CLIA 99D9955501', ['provider-ids'], 'PROVIDER_ID'), []);
  // A sole practitioner's TIN in SSN form is patient-grade data with or without the pack.
  assert.ok(find('Rendering: Marisol Quintero-Hale, TIN 987-65-4327', [], 'SSN').includes('987-65-4327'));
});

test('a mid-line patient label is found by the base detector', () => {
  assert.ok(find('NPI 1999905518. Patient: Bartholomew Ikeda.', [], 'PATIENT_NAME').some((v) => v.startsWith('Bartholomew Ikeda')));
});

test('no regression on the base corpora with the three document packs on', async () => {
  const r = await runBenchmark(await strixRedactor({ packs: ['lab-requisition', 'eob-835', 'denial-appeal'] }), [['main', DOCS], ['held-out', HELD_OUT]]);
  for (const s of r.sets) {
    assert.equal(s.survived, 0, s.corpus);
    assert.equal(s.decoysKept, s.decoys, s.corpus);
  }
});

test('with provider-ids on, the only base-corpus values lost are the provider ids the base corpus keeps by default', async () => {
  const redact = await strixRedactor({ packs: ALL });
  const lost = [];
  for (const d of [...DOCS, ...HELD_OUT]) {
    const out = await redact(d.text);
    assert.ok(!out.refused, d.id);
    for (const t of d.truth ?? []) assert.ok(!out.released.toLowerCase().includes(t.span.toLowerCase()), `${d.id}: ${t.span}`);
    for (const x of d.decoys ?? []) {
      const s = typeof x === 'string' ? x : x.span;
      if (!out.released.toLowerCase().includes(s.toLowerCase())) lost.push(`${d.id}:${s}`);
    }
  }
  // Both are provider ids the base corpus keeps by default (Q1); the pack replaces them by design.
  assert.deepEqual(lost.sort(), ['phone-decoys:1234567893', 'tax-id-forms:98-7654321']);
});

test('the Phase 2 held-out split has not changed since it was committed ahead of the rules', () => {
  const recorded = readFileSync(new URL('../accuracy/lab-packs/HASHES.md', import.meta.url), 'utf8')
    .match(/corpus-heldout-p2\.mjs` \| [^|]+ \| `([0-9a-f]{64})`/)[1];
  const actual = createHash('sha256').update(readFileSync(new URL('../accuracy/lab-packs/corpus-heldout-p2.mjs', import.meta.url))).digest('hex');
  assert.equal(actual, recorded);
});

test('pack name rules are case-sensitive on the value: lower-case words are never a name', async () => {
  // Found by the Phase 2 held-out run: under the `i` flag "physician Dr" read
  // as a name, the rescan found it beside the provider token and the release
  // was refused. "pt notified today" is the Phase 1 rule's version of it.
  assert.deepEqual(added('pt notified today by phone', ['lab-requisition']), []);
  const redact = await strixRedactor({ packs: ['provider-ids'] });
  const out = await redact('Referring physician Dr. Nnamdi Castellano (NPI 1999909914)');
  assert.ok(!out.refused, 'refused by its own rescan');
  assert.ok(!out.released.includes('Castellano') && !out.released.includes('1999909914'));
});
