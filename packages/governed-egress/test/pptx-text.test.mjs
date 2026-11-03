/**
 * PPTX extraction — slide text, slide tables read both ways, hidden content
 * refused, notes never sent, container safety, end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PptxExtractionError, extractPptxText, twoColumnReading } from '../src/artifact/pptx-text.mjs';
import { DETECTOR_FIELD_LABELS } from '../src/artifact/table-linearize.mjs';
import { ingestArtifact, SUPPORTED_MIME_TYPES } from '../src/artifact/ingest.mjs';
import { scanText, createPatternDetector, NAME_LABELS } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';
import { buildPptx, buildXlsx } from './_ooxml-fixture.mjs';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function refusesWith(code, fn) {
  assert.throws(fn, (err) => err instanceof PptxExtractionError && err.reasonCode === code, `expected ${code}`);
}

test('slide text is sent in presentation order, one line per paragraph', () => {
  const x = buildPptx([{ paragraphs: ['Denials Q3', 'Up 4%'] }, { paragraphs: ['Next steps'] }]);
  assert.equal(extractPptxText(x), 'Slide 1\nDenials Q3\nUp 4%\n\nSlide 2\nNext steps\n');
});

test('runs are joined so a label and value in different runs stay on one line', () => {
  const x = buildPptx([{ paragraphs: [['Patient: ', 'Jane Doe']] }]);
  const out = extractPptxText(x);
  assert.match(out, /^Patient: Jane Doe$/m);
  assert.ok(scanText(out).categories.includes('PATIENT_NAME'));
});

test('a line break inside a paragraph becomes a space', () => {
  const x = buildPptx([{ paragraphs: [['MRN:', '\n', 'A12345']] }]);
  assert.match(extractPptxText(x), /^MRN: A12345$/m);
});

test('a key/value slide table is caught — the reading that treats row 1 as a header alone would miss it', () => {
  const x = buildPptx([{ table: [['Patient', 'Jane Doe'], ['MRN', 'A12345']] }]);
  const out = extractPptxText(x);
  const cats = scanText(out).categories;
  assert.ok(cats.includes('PATIENT_NAME'), out);
  assert.ok(cats.includes('MRN'), out);
});

test('a header slide table is linearized under its headers', () => {
  const x = buildPptx([{ table: [['Patient Name', 'MRN', 'Status'], ['Jane Doe', 'A12345', 'denied']] }]);
  const cats = scanText(extractPptxText(x)).categories;
  assert.ok(cats.includes('PATIENT_NAME'));
  assert.ok(cats.includes('MRN'));
});

test('a two-column header table of field labels is read as a header table', () => {
  const x = buildPptx([{ table: [['Patient Name', 'MRN'], ['Jane Doe', 'A12345']] }]);
  const cats = scanText(extractPptxText(x)).categories;
  assert.ok(cats.includes('PATIENT_NAME'));
  assert.ok(cats.includes('MRN'));
});

test('two-column readings: key/value, header, and refusal when the choice is unsafe', () => {
  assert.equal(twoColumnReading([['Patient', 'Jane Doe'], ['MRN', 'A12345']]), 'keyvalue');
  assert.equal(twoColumnReading([['Patient Name', 'MRN'], ['Jane Doe', 'A12345']]), 'header');
  assert.equal(twoColumnReading([['Claim', 'Status'], ['C-1', 'denied']]), 'header');
  // A known label mixed with ordinary keys: either reading could strand a value.
  assert.equal(twoColumnReading([['Patient', 'Jane Doe'], ['Status', 'denied']]), 'ambiguous');
  assert.equal(twoColumnReading([['MRN', 'Status'], ['A12345', 'denied']]), 'ambiguous');
  refusesWith('PPTX_AMBIGUOUS_TABLE', () =>
    extractPptxText(buildPptx([{ table: [['Patient', 'Jane Doe'], ['Status', 'denied']] }])),
  );
});

test('only one reading is emitted, so no value appears in two label contexts', () => {
  const out = extractPptxText(buildPptx([{ table: [['Patient', 'Jane Doe'], ['MRN', 'A12345']] }]));
  assert.equal(out.match(/A12345/g).length, 1);
  assert.doesNotMatch(out, /Table row/);
});

test('every field label the reading rule trusts is one the detector actually catches', () => {
  for (const label of DETECTOR_FIELD_LABELS) {
    const sample = NAME_LABELS.includes(label)
      ? 'Jane Doe'
      : /dob|birth/.test(label)
        ? '01/02/1980'
        : /ssn|social/.test(label)
          ? '123-45-6789'
          : /^(?:ein|tin|tax id|taxpayer id)$/.test(label)
            ? '12-3456789'
            : /^(?:routing number|aba)$/.test(label)
              ? '021000021'
              : /^iban$/.test(label)
                ? 'DE89370400440532013000'
                : 'AB12345';
    const title = label.replace(/\b\w/g, (c) => c.toUpperCase());
    assert.ok(scanText(`${title}: ${sample}\n`).findings.length > 0, `detector does not catch "${title}: ${sample}"`);
  }
});

test('an unlabelable name column or key refuses the deck', () => {
  refusesWith('PPTX_UNRECOGNIZED_NAME_COLUMN', () =>
    extractPptxText(buildPptx([{ table: [['First Name', 'Code', 'X'], ['Jane', 'A1', 'y']] }])),
  );
  refusesWith('PPTX_UNRECOGNIZED_NAME_COLUMN', () =>
    extractPptxText(buildPptx([{ table: [['Code', 'A1'], ['First Name', 'Jane']] }])),
  );
});

test('hidden slides and hidden shapes are refused', () => {
  refusesWith('PPTX_HIDDEN_CONTENT', () => extractPptxText(buildPptx([{ paragraphs: ['a'] }, { paragraphs: ['b'], show: '0' }])));
  refusesWith('PPTX_HIDDEN_CONTENT', () => extractPptxText(buildPptx([{ paragraphs: ['a'], hiddenShape: true }])));
});

test('speaker notes are never sent', () => {
  const x = buildPptx([{ paragraphs: ['Summary'] }], { notes: ['Patient: Jane Doe, MRN: A12345'] });
  const out = extractPptxText(x);
  assert.doesNotMatch(out, /Jane|A12345/);
});

test('a macro-enabled deck is refused', () => {
  const x = buildPptx([{ paragraphs: ['a'] }], { extraParts: [['ppt/vbaProject.bin', Buffer.from([1])]] });
  refusesWith('PPTX_UNSUPPORTED_CONTENT', () => extractPptxText(x));
});

test('a deck with no slide text is EMPTY_ARTIFACT', () => {
  refusesWith('EMPTY_ARTIFACT', () => extractPptxText(buildPptx([{ paragraphs: [] }])));
});

test('XLSX/PPTX/DOCX are told apart by the container; a mismatch is refused', () => {
  assert.ok(SUPPORTED_MIME_TYPES.includes(PPTX_MIME));
  const deck = buildPptx([{ paragraphs: ['Hello'] }]);
  const ok = ingestArtifact({ bytes: deck, mimeType: PPTX_MIME });
  assert.equal(ok.ok, true);
  assert.equal(ok.mimeType, PPTX_MIME);
  assert.equal(ingestArtifact({ bytes: deck }).mimeType, PPTX_MIME);
  const wrong = ingestArtifact({ bytes: deck, mimeType: XLSX_MIME });
  assert.equal(wrong.reasonCode, 'MIME_MISMATCH');
  const book = buildXlsx([{ name: 'S', rows: [['A'], ['1']] }]);
  assert.equal(ingestArtifact({ bytes: book, mimeType: PPTX_MIME }).reasonCode, 'MIME_MISMATCH');
});

test('end to end: a PHI-bearing deck releases with no identifier left', async () => {
  const deck = buildPptx([
    { paragraphs: ['Appeal review', [`Patient: `, 'Jane Doe']] },
    { table: [['MRN', 'A12345'], ['DOB', '01/02/1980']] },
  ]);
  const prepared = await prepareDocumentForEgress({
    source: { bytes: deck, mimeType: PPTX_MIME, filename: 'review.pptx' },
    prompt: 'Summarize the review.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'appeal_drafting',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'test',
    deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer() },
  });
  assert.equal(prepared.outcome, 'PREPARED', prepared.reasonCode);
  assert.doesNotMatch(prepared.releaseText, /Jane|Doe|A12345|01\/02\/1980/);
  assert.equal(prepared.artifact.verification.status, 'passed');
});
