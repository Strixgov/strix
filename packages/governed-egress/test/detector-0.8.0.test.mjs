/**
 * Detector 0.8.0 — provider identifiers are kept by default (operator
 * decision Q1, 2026-10-06). The provider-ids pack replaces them, as
 * PROVIDER, never PATIENT. Each positive has the control that keeps a
 * patient-grade value replaced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanText, DETECTOR_INFO } from '../src/detection/pattern-detector.mjs';
import { resolvePacks } from '../src/detection/packs.mjs';
import { strixRedactor } from '../accuracy/benchmark.mjs';

const values = (s, packs = []) => scanText(s, { packs: resolvePacks(packs) }).findings.map((f) => `${f.category}:${f.value}`);

test('version is 0.8.0', () => {
  assert.equal(DETECTOR_INFO.version, '0.8.0');
});

test('a doctor and a provider-labelled name are kept by default, wherever they recur', () => {
  assert.deepEqual(values('Seen by Dr. Varga. Dr. Varga will call back; Varga is on leave Friday.'), []);
  assert.deepEqual(values('Rendering provider: Saoirse Adebayo-Klein'), []);
});

test('an EIN-shaped TIN is kept only when its line names a provider', () => {
  assert.deepEqual(values('Billing provider: Cascade Clinical Labs, TIN 99-7654321'), []);
  assert.deepEqual(values('The practice files under TIN 98-7654321.'), []);
  // No provider on the line: still a tax ID.
  assert.deepEqual(values('EIN: 12-3456789'), ['TAX_ID:12-3456789']);
  assert.deepEqual(values('Payee 12-3456789 on invoice'), ['TAX_ID:12-3456789']);
});

test('controls: an SSN-form TIN, other titles, and a provider who is also the patient are replaced', () => {
  assert.ok(values('Rendering: Marisol Quintero-Hale, LCSW, TIN 987-65-4327').includes('SSN:987-65-4327'));
  assert.deepEqual(values('Ms. Okonkwo disputes the denial.'), ['PATIENT_NAME:Okonkwo']);
  const both = values('Patient: Ottoline Varga\nSeen by Dr. Varga');
  assert.ok(both.includes('PATIENT_NAME:Varga'), JSON.stringify(both));
});

test('with the provider-ids pack, every kept provider id is replaced as PROVIDER', async () => {
  const text = 'Billing provider: Cascade Clinical Labs, TIN 99-7654321\nSeen by Dr. Varga.\nPatient: Leopold Tran-Whitaker';
  const found = values(text, ['provider-ids']);
  assert.ok(found.includes('PROVIDER_ID:99-7654321'), JSON.stringify(found));
  assert.ok(found.includes('PROVIDER_ID:Varga'), JSON.stringify(found));
  const kept = await (await strixRedactor())(text);
  assert.ok(kept.released.includes('99-7654321') && kept.released.includes('Dr. Varga') && !kept.released.includes('Leopold'));
  const out = await (await strixRedactor({ packs: ['provider-ids'] }))(text);
  assert.ok(!out.refused, 'a PROVIDER token must not fail its own rescan');
  assert.ok(!out.released.includes('99-7654321') && !out.released.includes('Varga') && !out.released.includes('Leopold'));
});

test('a provider name rule does not swallow a following all-caps label', () => {
  const found = values('Rendering provider: Dr. Saoirse Adebayo-Klein   NPI 1999906612', ['provider-ids']);
  assert.ok(found.includes('PROVIDER_ID:Saoirse Adebayo-Klein'), JSON.stringify(found));
});

test('a titled name with repeated spaces is replaced over its whole span', () => {
  const text = 'Called Ms. Okonkwo   Reyes about the bill.';
  const f = scanText(text).findings.find((x) => x.category === 'PATIENT_NAME');
  assert.equal(text.slice(f.start, f.end), f.value);
  assert.equal(f.value, 'Okonkwo   Reyes');
});

test('a field label after a labelled name stays outside the name token', async () => {
  const text = 'Patient: Marguerite Oyelowo-Banks   DOB: 06/02/1961   MRN: 51200984';
  assert.ok(values(text).includes('PATIENT_NAME:Marguerite Oyelowo-Banks'), JSON.stringify(values(text)));
  const out = await (await strixRedactor())(text);
  assert.ok(out.released.includes('DOB: [DATE_'), out.released);
  assert.ok(!out.released.includes('Marguerite') && !out.released.includes('Oyelowo'));
});
