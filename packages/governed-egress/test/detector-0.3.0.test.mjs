/**
 * Detector 0.3.0 — the detection gaps the 2026-09-24 360 review left open.
 * One section per gap; each names the leak it closes. Red-proofs in the
 * build summary plant the pre-fix shape and watch its own test fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanText, createPatternDetector, DETECTOR_INFO } from '../src/detection/pattern-detector.mjs';
import { DETECTION_CATEGORIES, TOKEN_PREFIX } from '../src/detection/categories.mjs';
import { GIVEN_NAMES } from '../src/detection/given-names.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { extractCsvText, CsvExtractionError } from '../src/artifact/csv-text.mjs';
import { extractPptxText } from '../src/artifact/pptx-text.mjs';
import { extractDocxText } from '../src/artifact/docx-text.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';
import { buildPptx, buildZip } from './_ooxml-fixture.mjs';

const find = (s, category) => scanText(s).findings.filter((f) => f.category === category).map((f) => f.value);
const names = (s) => find(s, 'PATIENT_NAME');

async function release(source) {
  const prepared = await prepareDocumentForEgress({
    source,
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

test('detector version and categories moved together', () => {
  // At least 0.3.0: later versions must keep what arrived here.
  const [maj, min] = DETECTOR_INFO.version.split('.').map(Number);
  const [wantMaj, wantMin] = '0.3.0'.split('.').map(Number);
  assert.ok(maj > wantMaj || (maj === wantMaj && min >= wantMin), DETECTOR_INFO.version);
  for (const c of ['PAYMENT_CARD', 'FINANCIAL_ACCOUNT', 'TAX_ID']) {
    assert.ok(DETECTION_CATEGORIES.includes(c), c);
    assert.equal(typeof TOKEN_PREFIX[c], 'string', c);
  }
});

// ── 1. A label and its value on separate lines ────────────────────────────

test('a name on the line after its label is found, with or without a blank line between', () => {
  // Given names outside the lexicon, so only the label rule can find them.
  assert.deepEqual(names('Patient:\nOttoline Varga\n'), ['Ottoline Varga']);
  assert.deepEqual(names('Patient Name\n\nVARGA, OTTOLINE\n'), ['VARGA, OTTOLINE']);
  assert.deepEqual(find('MRN:\nA12345\n', 'MRN'), ['A12345']);
});

test('a heading followed by prose, or by a word with no digit, is not read as a value', () => {
  assert.deepEqual(names('Patient\nwas stable overnight\n'), []);
  assert.deepEqual(names('Patient:\nStable After Surgery\n'), []);
  assert.deepEqual(find('MRN\nApproved\n', 'MRN'), []);
});

test('a label in one slide text box and the name in the next is not released', async () => {
  const deck = buildPptx([{ paragraphs: ['Patient:', 'Ottoline Varga', 'MRN:', 'A12345'] }]);
  const out = await release({ bytes: deck, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  assert.doesNotMatch(out, /Ottoline|Varga|A12345/, out);
});

test('a label in one Word paragraph and the name in the next is not released', async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const doc = buildZip([['word/document.xml', `<w:document ${W}><w:body>${p('Patient Name:')}${p('Ottoline Varga')}${p('Seen for follow-up.')}</w:body></w:document>`]]);
  assert.match(extractDocxText(doc), /Ottoline Varga/);
  const out = await release({ bytes: doc, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.doesNotMatch(out, /Ottoline|Varga/, out);
});

// ── 2. A single-word name under a name label ─────────────────────────────

test('a single capitalized word under an explicit name label is a name', () => {
  assert.deepEqual(names('Patient Name: Doe\n'), ['Doe']);
  assert.deepEqual(names('Guarantor: Varga\n'), ['Varga']);
  assert.match(extractCsvText('Patient Name,MRN\nDoe,A12345\n'), /^Patient Name: Doe$/m);
});

test('a single word that is a status or a role is not', () => {
  for (const s of ['Patient: Stable\n', 'Insured: Yes\n', 'Guarantor: Self\n', 'Subscriber: Spouse\n', 'Name: Unknown\n']) {
    assert.deepEqual(names(s), [], s);
  }
});

// ── 3. Names in uncased scripts ──────────────────────────────────────────

test('names in uncased scripts are found under a label', () => {
  assert.deepEqual(names('Name: 李小龙\n'), ['李小龙']);
  assert.deepEqual(names('Patient: 김민수\n'), ['김민수']);
  assert.deepEqual(names('Patient: محمد علي\n'), ['محمد علي']);
  assert.deepEqual(names('Patient Name: Иванов, Иван\n'), ['Иванов, Иван']);
});

test('an uncased-script name is removed where it reappears without spaces around it', async () => {
  const out = await release({ text: 'Name: 李小龙\n李小龙说他好了。' });
  assert.doesNotMatch(out, /李小龙/, out);
});

// ── 4. Names with no label ───────────────────────────────────────────────

test('a lexicon given name plus a surname is found without a label', () => {
  assert.deepEqual(names('Spoke with Jane Doe today.'), ['Jane Doe']);
  assert.deepEqual(names('JOHN SMITH called back'), ['JOHN SMITH']);
  assert.deepEqual(names("Called Michael O'Brien-Smith yesterday"), ["Michael O'Brien-Smith"]);
  assert.deepEqual(names('Doe, Jane was seen'), ['Doe, Jane']);
  assert.deepEqual(names('Referred by Mary Ann de la Cruz on intake'), ['Mary Ann de la Cruz']);
});

test('headings, places and salutations are not read as names', () => {
  for (const s of ['Claim Status: Denied', 'Service Date', 'John Street', 'Mary Hospital admitted', 'Thanks, John', 'Dear, Mary']) {
    assert.deepEqual(names(s), [], s);
  }
  assert.deepEqual(names('Seen by John Smith Hospital staff'), ['John Smith']);
});

test('the lexicon leaves out given names that are ordinary words', () => {
  for (const w of ['May', 'June', 'April', 'August', 'Will', 'Mark', 'Bill', 'Grace', 'Hope', 'Faith', 'Joy', 'Frank', 'Rose']) {
    assert.ok(!GIVEN_NAMES.includes(w), w);
  }
  assert.deepEqual(names('May Contain Nuts'), []);
});

test('an unlabelled name is removed everywhere, including its surname alone', async () => {
  const out = await release({ text: 'Spoke with Jane Doe about the denial. Doe agreed to appeal.' });
  assert.doesNotMatch(out, /\bJane\b|\bDoe\b/, out);
});

test('a headerless list of names is refused, not linearized under a name as its header', () => {
  assert.throws(
    () => extractCsvText('Jane Doe\nJohn Roe\n'),
    (e) => e instanceof CsvExtractionError && e.reasonCode === 'CSV_HEADER_INVALID',
  );
});

// ── 5. Financial and tax identifiers ─────────────────────────────────────

test('a payment card number with a valid check digit is found, however it is grouped', () => {
  assert.deepEqual(find('Card: 4111 1111 1111 1111', 'PAYMENT_CARD'), ['4111 1111 1111 1111']);
  assert.deepEqual(find('on file 4111-1111-1111-1111 exp 12/29', 'PAYMENT_CARD'), ['4111-1111-1111-1111']);
  assert.deepEqual(find('5500000000000004', 'PAYMENT_CARD'), ['5500000000000004']);
  assert.deepEqual(find('Amex 3782 822463 10005', 'PAYMENT_CARD'), ['3782 822463 10005']);
});

test('a digit run that fails the card checks is not a card', () => {
  for (const s of [
    '4111-1111-1111-1112',
    'Claim 1234567890123456',
    '4111 1111-1111 1111',
    '1111111111111111',
    '0000000000000000',
    // Luhn-valid as a digit string, but grouped as a list, not as a card.
    '4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1',
    '41 11 11 11 11 11 11 11',
  ]) {
    assert.deepEqual(find(s, 'PAYMENT_CARD'), [], s);
  }
});

test('bank routing, account and IBAN numbers are found; a following word is not absorbed', () => {
  assert.deepEqual(find('Routing: 021000021', 'FINANCIAL_ACCOUNT'), ['021000021']);
  assert.deepEqual(find('ABA routing number 021000021', 'FINANCIAL_ACCOUNT'), ['021000021']);
  assert.deepEqual(find('Acct: 12345678 due today', 'FINANCIAL_ACCOUNT'), ['12345678']);
  assert.deepEqual(find('IBAN DE89 3704 0044 0532 0130 00', 'FINANCIAL_ACCOUNT'), ['DE89 3704 0044 0532 0130 00']);
  assert.deepEqual(find('wire to GB82WEST12345698765432', 'FINANCIAL_ACCOUNT'), ['GB82WEST12345698765432']);
  assert.deepEqual(find('Checking eligibility for 2026', 'FINANCIAL_ACCOUNT'), []);
  assert.deepEqual(find('GB82WEST12345698765433', 'FINANCIAL_ACCOUNT'), []);
});

test('tax IDs are found under a label and in their own EIN shape', () => {
  assert.deepEqual(find('EIN: 12-3456789', 'TAX_ID'), ['12-3456789']);
  assert.deepEqual(find('Federal Tax ID 123456789', 'TAX_ID'), ['123456789']);
  assert.deepEqual(find('Payee 12-3456789 on invoice', 'TAX_ID'), ['12-3456789']);
});

test('financial and tax identifiers are tokenized out of the release', async () => {
  const out = await release({ text: 'Card: 4111 1111 1111 1111\nRouting: 021000021\nEIN: 12-3456789\n' });
  assert.doesNotMatch(out, /4111|021000021|3456789/, out);
  assert.match(out, /\[CARD_\d{3}\]/);
  assert.match(out, /\[ACCOUNT_\d{3}\]/);
  assert.match(out, /\[TAXID_\d{3}\]/);
});
