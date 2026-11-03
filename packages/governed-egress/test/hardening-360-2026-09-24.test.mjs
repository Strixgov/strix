/**
 * 2026-09-24 360 review — one pin per reconciled gap. Each test names the
 * defect it closes; the red-proofs in the build summary plant the pre-fix
 * shape and watch exactly the matching test fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanText, DETECTOR_INFO } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { extractCsvText, CsvExtractionError } from '../src/artifact/csv-text.mjs';
import { extractDocxText, DocxExtractionError } from '../src/artifact/docx-text.mjs';
import { extractPptxText, PptxExtractionError } from '../src/artifact/pptx-text.mjs';
import { extractXlsxText, XlsxExtractionError } from '../src/artifact/xlsx-text.mjs';
import { openZipContainer, ZipContainerError } from '../src/artifact/zip-container.mjs';
import { scanXml, OoxmlXmlError } from '../src/artifact/ooxml-xml.mjs';
import { ingestArtifact } from '../src/artifact/ingest.mjs';
import { buildZip, buildPptx, buildXlsx } from './_ooxml-fixture.mjs';

const names = (s) => scanText(s).findings.filter((f) => f.category === 'PATIENT_NAME').map((f) => f.value);
const refuses = (Cls, code, fn) =>
  assert.throws(fn, (e) => e instanceof Cls && e.reasonCode === code, `expected ${code}`);

// ── Detector: name forms the label-seeded detector used to release ─────────

test('detector version moved with the grammar', () => {
  assert.notEqual(DETECTOR_INFO.version, '0.2.0', 'the name grammar changed after 0.2.0');
});

test('surname-first, all-caps, accented, particle and lowercase names are found', () => {
  assert.deepEqual(names('Patient: DOE, JANE'), ['DOE, JANE']);
  assert.deepEqual(names("Patient Name: O'Brien-Smith, Mary Ann"), ["O'Brien-Smith, Mary Ann"]);
  assert.deepEqual(names('Patient: José Núñez'), ['José Núñez']);
  assert.deepEqual(names('Name: Mary Ann de la Cruz Smith'), ['Mary Ann de la Cruz Smith']);
  assert.deepEqual(names('patient: jane doe'), ['jane doe']);
});

test('person-role labels (guarantor, subscriber, …) are name labels', () => {
  for (const label of ['Guarantor', 'Subscriber', 'Insured', 'Beneficiary', 'Responsible Party']) {
    assert.deepEqual(names(`${label}: John Roe`), ['John Roe'], label);
  }
});

test('a clinical phrase after "Patient:" is not read as a name', () => {
  assert.deepEqual(names('Patient: stable after the transfusion'), []);
});

test('a surname-first name propagates in given-first order and by its parts', async () => {
  const text = 'Patient: DOE, JANE\nSpoke with Jane Doe; Doe agreed.';
  const released = (await createTokenizingTransformer().transform(text, scanText(text))).text;
  assert.doesNotMatch(released, /\bjane\b/i, released);
  assert.doesNotMatch(released, /\bdoe\b/i, released);
});

// ── Tables: a name the detector cannot confirm is never released ───────────

test('a name-column value the detector cannot read is refused, not released', () => {
  // 'Doe' and '李小龙' were refused here in 0.2.0; 0.3.0 reads a single
  // capitalized word and uncased scripts under a name label (see the 0.3.0 suite).
  for (const v of ['jane', 'Self', 'X Æ A-12']) {
    refuses(CsvExtractionError, 'CSV_NAME_VALUE_UNRECOGNIZED', () => extractCsvText(`Patient Name,MRN\n${v},A12345\n`));
  }
  assert.match(extractCsvText('Patient Name,MRN\nJANE DOE,A12345\n'), /^Patient Name: JANE DOE$/m);
});

test('a data row holding a field label is ambiguous and refused', () => {
  refuses(CsvExtractionError, 'CSV_AMBIGUOUS_LAYOUT', () => extractCsvText('Patient Name,MRN\nJane Doe,A12345\nMRN,x\n'));
});

test('a role value that merely names a role ("Patient") is not ambiguity', () => {
  assert.match(extractCsvText('Role,Status\nPatient,active\n'), /^Role: Patient$/m);
});

test('a header that looks like data is refused', () => {
  refuses(CsvExtractionError, 'CSV_HEADER_INVALID', () => extractCsvText('12345678,Status\na,b\n'));
});

test('partial-name and person-role headers the detector cannot label are refused', () => {
  for (const h of ['First Name', 'Patient (Last, First)', 'Client', 'Spouse']) {
    refuses(CsvExtractionError, 'CSV_UNRECOGNIZED_NAME_COLUMN', () => extractCsvText(`${h},Status\nJane Doe,x\n`));
  }
});

// ── Ingest: text sources ─────────────────────────────────────────────────

test('pasted delimited text with field labels is refused until declared CSV', () => {
  const table = 'Patient Name,MRN\nJane Doe,A12345\n';
  assert.equal(ingestArtifact({ text: table }).reasonCode, 'TABULAR_TEXT_UNDECLARED');
  const declared = ingestArtifact({ text: table, mimeType: 'text/csv' });
  assert.equal(declared.ok, true);
  assert.match(declared.text, /^Patient Name: Jane Doe$/m);
});

test('an uploaded .csv labelled text/plain is read as CSV', () => {
  const r = ingestArtifact({ bytes: Buffer.from('Patient Name,MRN\nJane Doe,A12345\n'), mimeType: 'text/plain', filename: ' claims.csv ' });
  assert.equal(r.ok, true);
  assert.equal(r.mimeType, 'text/csv');
});

test('pasted text may be declared text/plain or text/csv only', () => {
  assert.equal(ingestArtifact({ text: 'hello', mimeType: 'application/json' }).reasonCode, 'UNSUPPORTED_ARTIFACT');
});

test('invisible characters are removed and control characters become spaces in every released text', () => {
  const r = ingestArtifact({ text: 'Ja​ne\u0007Doe' });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Jane Doe');
});

// ── ZIP container ────────────────────────────────────────────────────────

test('bytes after the end-of-central-directory record are refused', () => {
  const zip = buildZip([['a.txt', 'x']]);
  assert.throws(() => openZipContainer(Buffer.concat([zip, Buffer.from('trailing')])), ZipContainerError);
});

test('names that collide case-insensitively are refused', () => {
  assert.throws(() => openZipContainer(buildZip([['word/document.xml', 'a'], ['WORD/Document.xml', 'b']])), ZipContainerError);
});

test('an entry whose inflated length differs from its declared size is refused', () => {
  const zip = buildZip([['a.txt', 'hello world']], { deflate: false });
  // Local header uncompressed size at 22, central at 30+name+data+24.
  const bad = Buffer.from(zip);
  bad.writeUInt32LE(5, 22);
  bad.writeUInt32LE(5, 30 + 5 + 11 + 24);
  assert.throws(() => openZipContainer(bad).read('a.txt'), ZipContainerError);
});

// ── OOXML XML ────────────────────────────────────────────────────────────

test('duplicate attributes, mismatched close tags and invalid character references are refused', () => {
  for (const xml of ['<a x="1" x="2"/>', '<a><b></a></b>', '<a>&#0;</a>', '<a x="1"y="2"/>']) {
    assert.throws(() => scanXml(xml, () => {}), OoxmlXmlError, xml);
  }
});

// ── DOCX ─────────────────────────────────────────────────────────────────

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body, extra = []) =>
  buildZip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', `<w:document ${W}><w:body>${body}</w:body></w:document>`], ...extra]);
const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;

test('DOCX hidden text, directly or through a style, is refused', () => {
  refuses(DocxExtractionError, 'DOCX_HIDDEN_CONTENT', () => extractDocxText(docx('<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>MRN A12345</w:t></w:r></w:p>')));
  const styles = ['word/styles.xml', `<w:styles ${W}><w:style><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`];
  refuses(DocxExtractionError, 'DOCX_HIDDEN_CONTENT', () => extractDocxText(docx(p('Visible'), [styles])));
  assert.equal(extractDocxText(docx('<w:p><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>Shown</w:t></w:r></w:p>')), 'Shown');
});

test('a DOCX with macros is refused', () => {
  refuses(DocxExtractionError, 'DOCX_UNSUPPORTED_CONTENT', () => extractDocxText(docx(p('x'), [['word/vbaProject.bin', 'x']])));
});

test('a truncated DOCX part is refused, never partially read', () => {
  const zip = buildZip([['word/document.xml', `<w:document ${W}><w:body>${p('Patient: Jane Doe')}<w:p><w:r><w:t>MRN A1`]]);
  refuses(DocxExtractionError, 'DOCX_MALFORMED', () => extractDocxText(zip));
});

test('a DOCX table is linearized with each value beside its label', () => {
  const row = (cells) => `<w:tr>${cells.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`;
  const out = extractDocxText(docx(`<w:tbl>${row(['Patient Name', 'MRN'])}${row(['Jane Doe', 'A12345'])}</w:tbl>`));
  assert.match(out, /^Patient Name: Jane Doe$/m);
  assert.match(out, /^MRN: A12345$/m);
});

test('DOCX table cells are held to the table rules', () => {
  const row = (cells) => `<w:tr>${cells.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`;
  refuses(DocxExtractionError, 'DOCX_UNRECOGNIZED_NAME_COLUMN', () =>
    extractDocxText(docx(`<w:tbl>${row(['First Name', 'Status'])}${row(['Jane', 'x'])}</w:tbl>`)),
  );
});

test('a tab stop in paragraph properties is not text, and mc:Fallback is not sent', () => {
  const body = `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>A</w:t></w:r></w:p>` +
    `<mc:AlternateContent><mc:Choice>${p('Shown')}</mc:Choice><mc:Fallback>${p('Fallback MRN A12345')}</mc:Fallback></mc:AlternateContent>`;
  const out = extractDocxText(docx(body));
  assert.equal(out, 'A\nShown');
});

// ── PPTX ─────────────────────────────────────────────────────────────────

test('a slide shape placed entirely off the slide is refused as hidden', () => {
  const deck = buildPptx([{ paragraphs: ['Visible'] }]);
  const zip = openZipContainer(deck);
  const slide = zip.read('ppt/slides/slide1.xml').toString('utf8').replace(
    '<p:txBody>',
    '<p:spPr><a:xfrm><a:off x="99999999" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody>',
  );
  const pres = zip.read('ppt/presentation.xml').toString('utf8').replace('</p:presentation>', '<p:sldSz cx="9144000" cy="6858000"/></p:presentation>');
  const part = (n) => (n === 'ppt/slides/slide1.xml' ? slide : n === 'ppt/presentation.xml' ? pres : zip.read(n));
  const rebuilt = buildZip(zip.names.map((n) => [n, part(n)]));
  const onSlide = buildZip(zip.names.map((n) => [n, n === 'ppt/presentation.xml' ? pres : zip.read(n)]));
  assert.match(extractPptxText(onSlide), /Visible/);
  refuses(PptxExtractionError, 'PPTX_HIDDEN_CONTENT', () => extractPptxText(rebuilt));
});

// ── XLSX ─────────────────────────────────────────────────────────────────

test('a number format that hides cell values (;;;) is refused', () => {
  const x = buildXlsx([{ name: 'S', rows: [['MRN'], [{ v: '12345', s: 1 }]] }], { numFmts: [[164, ';;;']], cellXfs: [0, 164] });
  refuses(XlsxExtractionError, 'XLSX_HIDDEN_CONTENT', () => extractXlsxText(x));
});

test('a zero-width column is refused as hidden', () => {
  const x = buildXlsx([{ name: 'S', rows: [['MRN', 'Status'], ['A12345', 'ok']], cols: '<cols><col min="1" max="1" width="0" customWidth="1"/></cols>' }]);
  refuses(XlsxExtractionError, 'XLSX_HIDDEN_CONTENT', () => extractXlsxText(x));
});
