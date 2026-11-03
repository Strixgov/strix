/**
 * XLSX extraction — linearization, the date and digit-template controls,
 * hidden-content refusal, formula handling, container safety, and the
 * end-to-end property that matters: no identifier survives into the release.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  XlsxExtractionError,
  applyDigitTemplate,
  classifyFormatCode,
  extractXlsxText,
  serialToDate,
  XLSX_MAX_COLUMNS,
} from '../src/artifact/xlsx-text.mjs';
import { ingestArtifact, SUPPORTED_MIME_TYPES } from '../src/artifact/ingest.mjs';
import { scanText, createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';
import { scanXml, OoxmlXmlError } from '../src/artifact/ooxml-xml.mjs';
import { buildXlsx, buildZip } from './_ooxml-fixture.mjs';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function refusesWith(code, fn) {
  assert.throws(fn, (err) => err instanceof XlsxExtractionError && err.reasonCode === code, `expected ${code}`);
}

// ── Linearization ─────────────────────────────────────────────────────────

test('each data row becomes Header: value lines under a Sheet line', () => {
  const x = buildXlsx([{ name: 'Claims', rows: [['Claim', 'Status'], ['C-1', 'denied'], ['C-2', 'paid']] }]);
  assert.equal(
    extractXlsxText(x),
    'Sheet 1\n\nRow 1\nClaim: C-1\nStatus: denied\n\nRow 2\nClaim: C-2\nStatus: paid\n',
  );
});

test('a workbook in raw cell order would hide identifiers; the linearized form exposes them', () => {
  const x = buildXlsx([{ name: 'S', rows: [['Patient Name', 'MRN'], ['Ottoline Varga', 'A12345']] }]);
  const cats = scanText(extractXlsxText(x)).categories;
  assert.ok(cats.includes('PATIENT_NAME'));
  assert.ok(cats.includes('MRN'));
  // The premise, stated as data: the same cells in row order carry no labels.
  // (A given name outside the lexicon, which would otherwise be found unlabelled.)
  assert.equal(scanText('Patient Name\tMRN\nOttoline Varga\tA12345\n').findings.length, 0);
});

test('sparse rows: missing trailing cells are empty, not ragged', () => {
  const x = buildXlsx([{ name: 'S', rows: [['A', 'B', 'C'], ['1']] }]);
  assert.match(extractXlsxText(x), /^A: 1\nB: \nC: $/m);
});

test('a value under no header is refused as ragged', () => {
  const x = buildXlsx([{ name: 'S', rows: [['A'], ['1', 'stray']] }]);
  refusesWith('XLSX_RAGGED_ROWS', () => extractXlsxText(x));
});

test('multiple sheets are each linearized; empty sheets are skipped', () => {
  const x = buildXlsx([
    { name: 'One', rows: [['A'], ['1']] },
    { name: 'Empty', rows: [] },
    { name: 'Two', rows: [['B'], ['2']] },
  ]);
  const out = extractXlsxText(x);
  assert.match(out, /^Sheet 1$/m);
  assert.match(out, /^Sheet 2$/m);
  assert.doesNotMatch(out, /Sheet 3|One|Two|Empty/);
});

test('a sheet name is never sent — a tab named after a patient cannot leak', () => {
  const x = buildXlsx([{ name: 'Patient: Ottoline Varga', rows: [['A'], ['1']] }]);
  const out = extractXlsxText(x);
  assert.doesNotMatch(out, /Ottoline|Varga|Patient/);
  // And the premise: on a Sheet: line the name rule would not have caught it
  // (a given name outside the lexicon, so the unlabelled rule cannot either).
  assert.equal(scanText('Sheet: Patient: Ottoline Varga\n').categories.includes('PATIENT_NAME'), false);
});

// ── Dates ─────────────────────────────────────────────────────────────────

test('serial dates convert through the 1900 leap-year bug', () => {
  assert.equal(serialToDate(1, false), '01/01/1900');
  assert.equal(serialToDate(59, false), '02/28/1900');
  assert.equal(serialToDate(61, false), '03/01/1900');
  assert.equal(serialToDate(29221, false), '01/01/1980');
  assert.equal(serialToDate(0, false), null);
  assert.equal(serialToDate(0 + 1, true), '01/02/1904');
});

test('format-code classification', () => {
  assert.equal(classifyFormatCode('mm/dd/yyyy'), 'date');
  assert.equal(classifyFormatCode('d-mmm-yy'), 'date');
  assert.equal(classifyFormatCode('[$-409]mmmm d, yyyy;@'), 'date');
  assert.equal(classifyFormatCode('h:mm:ss'), null);
  assert.equal(classifyFormatCode('"Day "0'), null);
  assert.equal(classifyFormatCode('0.00'), null);
  assert.equal(classifyFormatCode('000.000.0000'), null);
  assert.equal(classifyFormatCode('000-00-0000'), 'digits');
  assert.equal(classifyFormatCode('(000) 000-0000'), 'digits');
});

test('a date-styled DOB is sent as a date the detector recognizes, not a serial', () => {
  const x = buildXlsx([{ name: 'S', rows: [['DOB', 'Visit'], [{ v: 29221, s: 1 }, { v: 45000, s: 2 }]] }], {
    numFmts: [[164, 'mm/dd/yyyy']],
    cellXfs: [0, 14, 164],
  });
  const out = extractXlsxText(x);
  assert.match(out, /^DOB: 01\/01\/1980$/m);
  assert.doesNotMatch(out, /29221/);
  assert.ok(scanText(out).categories.includes('DATE'));
});

test('the 1904 date system is honoured', () => {
  const x = buildXlsx([{ name: 'S', rows: [['DOB'], [{ v: 27759, s: 1 }]] }], { cellXfs: [0, 14], date1904: true });
  assert.match(extractXlsxText(x), /^DOB: 01\/01\/1980$/m);
});

test('a time-only style is not rewritten as a date', () => {
  const x = buildXlsx([{ name: 'S', rows: [['Duration'], [{ v: 0.5, s: 1 }]] }], { cellXfs: [0, 20] });
  assert.match(extractXlsxText(x), /^Duration: 0.5$/m);
});

test('ISO t="d" cells are rewritten MM/DD/YYYY', () => {
  const x = buildXlsx([{ name: 'S', rows: [['DOB'], [{ t: 'd', v: '1980-01-02T00:00:00' }]] }]);
  assert.match(extractXlsxText(x), /^DOB: 01\/02\/1980$/m);
});

// ── Digit templates ───────────────────────────────────────────────────────

test('digit templates restore the separators the pattern rules need', () => {
  assert.equal(applyDigitTemplate('000-00-0000', '123456789'), '123-45-6789');
  assert.equal(applyDigitTemplate('000-00-0000', '12345678'), '012-34-5678');
  assert.equal(applyDigitTemplate('(000) 000-0000', '5551234567'), '(555) 123-4567');
  assert.equal(applyDigitTemplate('000-00-0000', '1234567890'), '1234567890');
  assert.equal(applyDigitTemplate('000-00-0000', '12.5'), '12.5');
  const x = buildXlsx([{ name: 'S', rows: [['Contact'], [{ v: 123456789, s: 1 }]] }], {
    numFmts: [[165, '000-00-0000']],
    cellXfs: [0, 165],
  });
  assert.ok(scanText(extractXlsxText(x)).categories.includes('SSN'));
});

// ── Hidden content, formulas, macros ──────────────────────────────────────

test('hidden and very-hidden sheets are refused', () => {
  for (const state of ['hidden', 'veryHidden']) {
    const x = buildXlsx([{ name: 'S', rows: [['A'], ['1']] }, { name: 'H', state, rows: [['B'], ['2']] }]);
    refusesWith('XLSX_HIDDEN_CONTENT', () => extractXlsxText(x));
  }
});

test('a hidden row, a hidden column and zero-height default rows are refused', () => {
  refusesWith('XLSX_HIDDEN_CONTENT', () =>
    extractXlsxText(buildXlsx([{ name: 'S', rows: [['A'], ['1']], rowAttrs: { 1: 'hidden="1"' } }])),
  );
  refusesWith('XLSX_HIDDEN_CONTENT', () =>
    extractXlsxText(buildXlsx([{ name: 'S', rows: [['A'], ['1']], cols: '<cols><col min="1" max="1" hidden="1"/></cols>' }])),
  );
  refusesWith('XLSX_HIDDEN_CONTENT', () =>
    extractXlsxText(buildXlsx([{ name: 'S', rows: [['A'], ['1']], formatPr: '<sheetFormatPr zeroHeight="1"/>' }])),
  );
});

test('a formula sends its cached value, never the formula text', () => {
  const x = buildXlsx([{ name: 'S', rows: [['Total'], [{ f: 'SUM("Jane Doe")', v: '42' }]] }]);
  const out = extractXlsxText(x);
  assert.match(out, /^Total: 42$/m);
  assert.doesNotMatch(out, /SUM|Jane/);
});

test('a formula with no cached value is refused', () => {
  const x = buildXlsx([{ name: 'S', rows: [['Total'], [{ f: 'A1+1' }]] }]);
  refusesWith('XLSX_FORMULA_UNCACHED', () => extractXlsxText(x));
});

test('a macro-bearing workbook is refused', () => {
  const x = buildXlsx([{ name: 'S', rows: [['A'], ['1']] }], { extraParts: [['xl/vbaProject.bin', Buffer.from([1, 2, 3])]] });
  refusesWith('XLSX_UNSUPPORTED_CONTENT', () => extractXlsxText(x));
});

test('a chart sheet is skipped; an unknown sheet type is refused', () => {
  const ok = buildXlsx([{ name: 'S', rows: [['A'], ['1']] }, { name: 'Chart', kind: 'chartsheet', rows: [] }]);
  assert.doesNotMatch(extractXlsxText(ok), /Chart/);
  const bad = buildXlsx([{ name: 'M', kind: 'dialogsheet', rows: [['A'], ['1']] }]);
  refusesWith('XLSX_UNSUPPORTED_CONTENT', () => extractXlsxText(bad));
});

// ── Headers ───────────────────────────────────────────────────────────────

test('the shared header rules apply: empty, duplicate and unlabelable name columns', () => {
  refusesWith('XLSX_HEADER_INVALID', () => extractXlsxText(buildXlsx([{ name: 'S', rows: [['A', 'a'], ['1', '2']] }])));
  refusesWith('XLSX_HEADER_INVALID', () => extractXlsxText(buildXlsx([{ name: 'S', rows: [['A', null, 'C'], ['1', '2', '3']] }])));
  refusesWith('XLSX_UNRECOGNIZED_NAME_COLUMN', () =>
    extractXlsxText(buildXlsx([{ name: 'S', rows: [['First Name'], ['Jane']] }])),
  );
});

// ── Container and XML safety ──────────────────────────────────────────────

test('a DOCTYPE or custom entity is refused, never expanded', () => {
  assert.throws(() => scanXml('<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>', () => {}), OoxmlXmlError);
  assert.throws(() => scanXml('<x>&a;</x>', () => {}), OoxmlXmlError);
  const x = buildZip([
    ['xl/workbook.xml', '<!DOCTYPE w [<!ENTITY e SYSTEM "file:///etc/passwd">]><workbook><sheets/></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships/>'],
  ]);
  refusesWith('XLSX_MALFORMED', () => extractXlsxText(x));
});

test('the XML scanner is linear on many unclosed tags', () => {
  const xml = '<x>' + '<c r="A1">'.repeat(200_000);
  const t0 = process.hrtime.bigint();
  assert.throws(() => scanXml(xml, () => {}), OoxmlXmlError);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1500, `took ${ms}ms`);
});

test('a missing workbook part is malformed; a broken container is refused', () => {
  refusesWith('XLSX_MALFORMED', () => extractXlsxText(buildZip([['xl/workbook.xml', '<workbook/>']])));
  refusesWith('XLSX_MALFORMED', () => extractXlsxText(Buffer.from('PK\u0003\u0004not a zip')));
});

test('a duplicate container entry is refused rather than guessed', () => {
  const x = buildZip([
    ['xl/workbook.xml', '<workbook/>'],
    ['xl/workbook.xml', '<workbook/>'],
  ]);
  refusesWith('XLSX_MALFORMED', () => extractXlsxText(x));
});

test('the inflate budget is shared across parts: many small bombs still refuse', () => {
  const big = 'A'.repeat(20 * 1024 * 1024);
  // Four parts, each 20 MiB inflated: every one is under the 64 MiB bound on
  // its own; together they exceed it.
  const padded = buildZip([
    ['xl/workbook.xml', '<workbook xmlns:r="r"><sheets>' + [1, 2, 3, 4].map((i) => `<sheet name="S${i}" r:id="rId${i}"/>`).join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships>' + [1, 2, 3, 4].map((i) => `<Relationship Id="rId${i}" Type="x/worksheet" Target="worksheets/s${i}.xml"/>`).join('') + '</Relationships>'],
    ...[1, 2, 3, 4].map((i) => [`xl/worksheets/s${i}.xml`, `<worksheet><sheetData/></worksheet><!--${big}-->`]),
  ]);
  refusesWith('ARTIFACT_TOO_LARGE', () => extractXlsxText(padded));
});

test('a column past the bound is refused, not truncated', () => {
  const row = Array.from({ length: XLSX_MAX_COLUMNS + 1 }, (_, i) => `c${i}`);
  refusesWith('ARTIFACT_TOO_LARGE', () => extractXlsxText(buildXlsx([{ name: 'S', rows: [row, row] }])));
});

// ── Ingestion ─────────────────────────────────────────────────────────────

test('XLSX is supported and dispatched by the container, not by name', () => {
  assert.ok(SUPPORTED_MIME_TYPES.includes(XLSX_MIME));
  const x = buildXlsx([{ name: 'S', rows: [['A'], ['1']] }]);
  const r = ingestArtifact({ bytes: x, mimeType: XLSX_MIME, filename: 'book.xlsx' });
  assert.equal(r.ok, true);
  assert.equal(r.mimeType, XLSX_MIME);
  const undeclared = ingestArtifact({ bytes: x });
  assert.equal(undeclared.mimeType, XLSX_MIME);
});

test('a workbook declared as DOCX (and the reverse) is a MIME mismatch', () => {
  const x = buildXlsx([{ name: 'S', rows: [['A'], ['1']] }]);
  const r = ingestArtifact({ bytes: x, mimeType: DOCX_MIME });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'MIME_MISMATCH');
});

test('an XLSX refusal keeps its own code and the original hash', () => {
  const x = buildXlsx([{ name: 'H', state: 'hidden', rows: [['A'], ['1']] }]);
  const r = ingestArtifact({ bytes: x, mimeType: XLSX_MIME });
  assert.equal(r.reasonCode, 'XLSX_HIDDEN_CONTENT');
  assert.match(r.originalHash, /^[0-9a-f]{64}$/);
});

test('end to end: a PHI-bearing workbook releases with no identifier left', async () => {
  const x = buildXlsx([{ name: 'Denials', rows: [['Patient Name', 'MRN', 'DOB', 'Status'], ['Jane Doe', 'A12345', { v: 29221, s: 1 }, 'denied']] }], {
    cellXfs: [0, 14],
  });
  const prepared = await prepareDocumentForEgress({
    source: { bytes: x, mimeType: XLSX_MIME, filename: 'denials.xlsx' },
    prompt: 'Summarize the denials.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'denial_review',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'test',
    deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer() },
  });
  assert.equal(prepared.outcome, 'PREPARED', prepared.reasonCode);
  assert.doesNotMatch(prepared.releaseText, /Jane|Doe|A12345|01\/01\/1980|29221/);
  assert.equal(prepared.artifact.verification.status, 'passed');
});
