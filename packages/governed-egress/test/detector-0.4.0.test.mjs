/**
 * Detector 0.4.0 — context-marked names and accounts.
 *
 * Each rule reads a word NEXT to the value that says what the value is. They
 * are the deterministic, in-boundary form of the cases a hosted judgment
 * model caught in the offline recall experiment (experiments/jev-recall/).
 * Every section pairs the case it closes with a negative control, because a
 * context rule that fires on its marker alone would redact prose wholesale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanText, createPatternDetector, DETECTOR_INFO } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';

const find = (s, category) => scanText(s).findings.filter((f) => f.category === category).map((f) => f.value);
const names = (s) => find(s, 'PATIENT_NAME');
const accounts = (s) => find(s, 'FINANCIAL_ACCOUNT');

async function release(text) {
  const prepared = await prepareDocumentForEgress({
    source: { bytes: Buffer.from(text, 'utf8'), mimeType: 'text/plain' },
    prompt: 'Summarize the document.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'appeal_drafting',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'test',
    deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer() },
  });
  assert.equal(prepared.outcome, 'PREPARED', prepared.reasonCode);
  assert.equal(prepared.artifact.verification.status, 'passed');
  return prepared.releaseText;
}

test('detector version moved with the context rules', () => {
  // At least 0.4.0: later versions must keep what arrived here.
  const [maj, min] = DETECTOR_INFO.version.split('.').map(Number);
  const [wantMaj, wantMin] = '0.4.0'.split('.').map(Number);
  assert.ok(maj > wantMaj || (maj === wantMaj && min >= wantMin), DETECTOR_INFO.version);
});

// ── TITLE ─────────────────────────────────────────────────────────────────

// INVERTED 2026-10-06 (detector 0.8.0, operator decision Q1). This test
// used to assert that "Dr. Varga" is replaced like a patient. A doctor is
// the provider, not the patient, and Safe Harbor does not require removing
// provider names, so the base detector now keeps them; the provider-ids pack
// replaces them (as PROVIDER, never PATIENT). Other titles are unchanged.
test('a surname after a title is a name, including one not on any list; a doctor is kept as the provider', async () => {
  assert.deepEqual(names('Seen by Dr. Varga at Lakeside Clinic.'), []);
  assert.deepEqual(names('Escalated after Nurse Pellworth flagged it.'), ['Pellworth']);
  assert.deepEqual(names('Ms. Okonkwo disputes the denial.'), ['Okonkwo']);
  assert.deepEqual(names('Referred by Dr. Ottoline Varga-Quill.'), []);
  const out = await release('Follow-up visit. The patient was seen by Dr. Varga, who recommended Metformin.');
  assert.ok(out.includes('Dr. Varga'), out);
  assert.ok(out.includes('Metformin'), 'the clinical content survives');
});

test('negative: a title word used on its own, or followed by a non-name, is not a name', () => {
  assert.deepEqual(names('Ask the Dr about the plan.'), []);
  assert.deepEqual(names('Dr. Hospital billing is closed.'), []);
  assert.deepEqual(names('The nurse practitioner reviewed it.'), []);
});

test('a titled surname that is part of a known name joins that entity (one person, one token)', () => {
  const r = scanText('Patient: Thaddeus Quillfeather\nMr. Quillfeather called twice.');
  const keys = new Set(r.findings.filter((f) => f.category === 'PATIENT_NAME').map((f) => f.entityKey));
  assert.equal(keys.size, 1);
});

test('a titled surname propagates, so a later bare mention is tokenized too (over-redaction by design)', () => {
  // After "Mr. Lincoln" every "Lincoln" is tokenized, including the one in
  // "Lincoln Medical Center". This is the documented fail-safe direction.
  // (Was "Dr. Lincoln" until 0.8.0, which keeps a doctor's name.)
  const values = names('Mr. Lincoln reviewed the scan at Lincoln Medical Center.');
  assert.equal(values.length, 2);
});

// ── INITIAL ───────────────────────────────────────────────────────────────

test('an initial plus a surname is a name', () => {
  assert.deepEqual(names('Per J. Okafor, the claim was resubmitted; A. Lindqvist approved it.'), ['J. Okafor', 'A. Lindqvist']);
});

test('negative: an initialism or an initial before a non-name is not a name', () => {
  assert.deepEqual(names('Shipped via U.S. Mail to the provider.'), []);
  assert.deepEqual(names('See Appendix A. Medical records follow.'), []);
});

// ── SIGN-OFF ──────────────────────────────────────────────────────────────

test('the name line after a closing is a name; the department line after it is not', async () => {
  const doc = 'Please see the attached explanation of benefits.\n\nRegards,\nTamsin Oyelaran\nPatient Accounts, Brightwater Health';
  assert.deepEqual(names(doc), ['Tamsin Oyelaran']);
  const out = await release(doc);
  assert.ok(!out.includes('Oyelaran'), out);
  assert.ok(out.includes('Brightwater Health'));
});

test('negative: a closing followed by prose or a common-word line is not a name', () => {
  assert.deepEqual(names('Thanks,\nsee you Monday'), []);
  assert.deepEqual(names('Regards,\nPatient Accounts'), []);
  assert.deepEqual(names('Best,\nThe Billing Team'), []);
});

// ── FAMILY ────────────────────────────────────────────────────────────────

test('"the X family" is a surname', () => {
  assert.deepEqual(names('The Oyelaran family asked for a copy of the bill.'), ['Oyelaran']);
});

test('negative: "the X family" where X is an ordinary word or place noun is not a name', () => {
  assert.deepEqual(names('The Health family of plans changed.'), []);
  assert.deepEqual(names('the whole family came'), []);
});

test('a possessive surname stays a documented residual gap', () => {
  // "Varga's bill" has the same shape as "Aetna's policy"; no rule can tell
  // them apart, so 0.4.0 deliberately does not try.
  assert.deepEqual(names("They asked for Varga's itemized bill."), []);
});

// ── ACCOUNT ───────────────────────────────────────────────────────────────

test('a digit run after a money-movement phrase is an account number', async () => {
  assert.deepEqual(accounts('Please wire the overpayment to 000123456789 at the member bank.'), ['000123456789']);
  assert.deepEqual(accounts('Deposit the settlement into 4417023391 rather than mail a check.'), ['4417023391']);
  assert.deepEqual(accounts('Future ACH sent to 98760012345 going forward.'), ['98760012345']);
  assert.deepEqual(accounts('Reimburse the member via 00402217789.'), ['00402217789']);
  assert.deepEqual(accounts("Route the payout to the member's account 6011420098."), ['6011420098']);
  const out = await release('Refund approved. Please wire the overpayment to 000123456789 by Friday.');
  assert.ok(!out.includes('000123456789'), out);
});

test('negative: a claim, NPI or reference number in the same sentence is not an account', () => {
  assert.deepEqual(accounts('Claim 4417023391 was paid in error; send the refund to 5520931847 instead.'), ['5520931847']);
  assert.deepEqual(accounts('NPI 1457382916 billed under claim 20260915001.'), []);
  assert.deepEqual(accounts('Reference 3309127745 closes the dispute.'), []);
});

test('negative: an amount, a date or a short number after the phrase is not an account', () => {
  assert.deepEqual(accounts('Refund of 1840.00 to the member on 09/15/2026.'), []);
  assert.deepEqual(accounts('Transfer to 2026 plan year.'), []);
  assert.deepEqual(accounts('Send to 12345 for review.'), []);
  // A decimal amount must not be read as an account by stopping before the point.
  assert.deepEqual(accounts('Transfer to 250000.00 limit for the plan year.'), []);
  assert.deepEqual(accounts('Refund to 1234567,89 was issued.'), []);
});

test('the phrase must be in the same sentence as the number', () => {
  assert.deepEqual(accounts('We will send the letter. 4417023391 is the claim.'), []);
});

// ── WIDE LABEL GAP ────────────────────────────────────────────────────────

test('a name up to three blank lines below its label is found; four is not', () => {
  assert.deepEqual(names('Patient:\n\n\nOttoline Varga\nService: PT'), ['Ottoline Varga']);
  assert.deepEqual(names('Member Name:\n\n\n\nBarnaby Thistlewood\nPlan: Silver'), ['Barnaby Thistlewood']);
  assert.deepEqual(names('Patient:\n\n\n\n\nOttoline Varga'), []);
});

test('negative: a heading far above prose is not a name', () => {
  assert.deepEqual(names('Patient:\n\n\nstable after the transfusion'), []);
});

// ── determinism ───────────────────────────────────────────────────────────

test('the context rules are deterministic', () => {
  const doc = 'Dr. Varga, J. Okafor and the Oyelaran family.\nWire the refund to 000123456789.\n\nRegards,\nTamsin Oyelaran';
  assert.deepEqual(scanText(doc), scanText(doc));
});
