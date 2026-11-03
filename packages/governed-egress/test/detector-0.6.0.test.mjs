/**
 * Detector 0.6.0 — the forms that survived release under 0.5.0.
 *
 * Every rule here either has a fixed, range-checked shape (ISO and
 * two-digit-year dates, PO boxes) or needs a marker word in the same
 * sentence (SSN, chart number, member ID, contact name). Each section pairs
 * the case it closes with the negative controls that keep it from firing on
 * ordinary text, because a rule that only has positives is untested in the
 * direction that costs answers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanText, DETECTOR_INFO, createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { verifySanitizedArtifact } from '../src/verification/verify.mjs';

const find = (s, category) => scanText(s).findings.filter((f) => f.category === category).map((f) => f.value);

// The version pin moved to detector-0.7.0.test.mjs; these behaviours stay.
test('version is 0.6.0 or later', () => {
  assert.notEqual(DETECTOR_INFO.version, '0.5.0');
});

test('ISO dates, with range-checked month and day', () => {
  assert.deepEqual(find('Seen 2023-02-28 and 2024/06/30; follow-up 2026-1-5.', 'DATE'), ['2023-02-28', '2024/06/30', '2026-1-5']);
  assert.deepEqual(find('Build 2024-13-45 and 2024-06-32 are ids.', 'DATE'), []);
  assert.deepEqual(find('Mixed 2024-06/30 is not one date.', 'DATE'), []);
  assert.deepEqual(find('Version 12024-06-30 is longer than a year.', 'DATE'), []);
  assert.deepEqual(find('Accession LX-20251103-0457 stays an accession.', 'DATE'), []);
});

test('two-digit-year dates take slashes only, and need three parts', () => {
  assert.deepEqual(find('Again on 3/14/24 and 12/1/25.', 'DATE'), ['3/14/24', '12/1/25']);
  assert.deepEqual(find('Scored 12/31, took 1/2 dose, ratio 10/20 mg, part 3-14-24.', 'DATE'), []);
  assert.deepEqual(find('Four-digit 3/14/2024 is still one date.', 'DATE'), ['3/14/2024']);
  assert.deepEqual(find('Month 13/14/24 is not a month.', 'DATE'), []);
});

test('PO boxes, but not other boxes', () => {
  assert.deepEqual(find('PO Box 2291, P.O. Box 88120, Post Office Box 7, po box 12.', 'ADDRESS'), ['PO Box 2291', 'P.O. Box 88120', 'Post Office Box 7', 'po box 12']);
  assert.deepEqual(find('Check box 12 and leave the comment box empty. Box 4 is blank.', 'ADDRESS'), []);
});

test('a bare nine-digit SSN needs the word social or SSN in the same sentence', () => {
  assert.deepEqual(find('She read out 987654323 as her social.', 'SSN'), ['987654323']);
  assert.deepEqual(find('SSN on file 987654325, confirmed.', 'SSN'), ['987654325']);
  assert.deepEqual(find('Ticket 987654321 was closed.', 'SSN'), []);
  // The marker does not reach across a sentence.
  assert.deepEqual(find('We discussed her social worker. Ticket 987654321 was closed.', 'SSN'), []);
  assert.deepEqual(find('Her social is 1234567890, a ten-digit number.', 'SSN'), []);
  assert.deepEqual(find('Social placeholder 999999999 only.', 'SSN'), []);
});

test('a chart number needs the word chart, medical record or MR#', () => {
  assert.deepEqual(find('Chart 00418872 merged; pulled chart #A2291034; MR# 5561023.', 'MRN'), ['00418872', 'A2291034', '5561023']);
  assert.deepEqual(find('Chart review pending; see chart notes for 2025.', 'MRN'), []);
  assert.deepEqual(find('Chart 12345 is too short to be a record number.', 'MRN'), []);
});

test('a member ID needs a payer or coverage word in the same sentence', () => {
  assert.deepEqual(find('Payer rejected XJH448120937 as inactive.', 'INSURANCE_ID'), ['XJH448120937']);
  assert.deepEqual(find('Coverage for member XQP77120045 ended.', 'INSURANCE_ID'), ['XQP77120045']);
  assert.deepEqual(find('The payer applied CPT99214 to the claim.', 'INSURANCE_ID'), []);
  assert.deepEqual(find('Order XJH448120937 shipped. The plan changed later.', 'INSURANCE_ID'), []);
  assert.deepEqual(find('Payer rejected xjh448120937 lower-case.', 'INSURANCE_ID'), []);
});

test('a contact phrase marks two or more capitalized words as a name', () => {
  assert.deepEqual(find('Spoke with Evangeline Thorsby about the bill.', 'PATIENT_NAME'), ['Evangeline Thorsby']);
  assert.deepEqual(find('Left a voicemail for Thaddeus Quirke today.', 'PATIENT_NAME'), ['Thaddeus Quirke']);
  assert.deepEqual(find('Met with Oluwaseun Adeyemi-Park and family.', 'PATIENT_NAME'), ['Oluwaseun Adeyemi-Park']);
  assert.deepEqual(find('Called Mercy Hospital, spoke with Billing Team, then called Aetna.', 'PATIENT_NAME'), []);
  assert.deepEqual(find('The team met Tuesday to review it.', 'PATIENT_NAME'), []);
});

test('a contact-marked name is propagated to its later mentions', () => {
  const values = find('Spoke with Evangeline Thorsby. Thorsby will call back.', 'PATIENT_NAME');
  assert.deepEqual(values, ['Evangeline Thorsby', 'Thorsby']);
});

test('the verification rescan uses the same rules, so a surviving form fails release', async () => {
  const r = await verifySanitizedArtifact({ text: 'Mail to PO Box 2291 by 2025-11-03.', originalFindings: [], detector: createPatternDetector() });
  assert.equal(r.status, 'failed');
  assert.equal(r.remainingProhibitedFindings, 2);
});
