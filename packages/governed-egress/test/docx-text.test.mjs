/**
 * Correctness + DoS-regression tests for src/artifact/docx-text.mjs.
 *
 * The correctness half proves the linear-time rewrite (see the file's own
 * header comment) is behaviorally equivalent to the original lazy-regex
 * implementation for every legitimate shape it needs to handle: multiple
 * paragraphs, tabs, breaks, XML entities, self-closing paragraphs/runs, and
 * sibling tags that share a `<w:p`/`<w:t` prefix without being one
 * (`<w:pPr>`, `<w:pStyle>`, `<w:tbl>`, `<w:tblGrid>`, `<w:tcPr>`).
 *
 * The DoS-regression half is a bounded-time assertion against an adversarial
 * payload built from many unclosed `<w:p ...>` openings — the exact shape
 * that made the pre-fix lazy-quantifier regex quadratic (measured: 51KB ->
 * 5.7s, 209KB -> 22.7s, before the fix). Under the linear scanners here it
 * completes in milliseconds; a regression back to a backtracking regex would
 * fail the bound named below by well over an order of magnitude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { extractDocxText, DocxExtractionError } from '../src/artifact/docx-text.mjs';

/**
 * Build a minimal, valid ZIP containing one entry. Defaults to STORE
 * (uncompressed) since these tests exercise docx-text.mjs's XML parsing,
 * not readZipEntry's inflate path (already covered by hardening-360.test.mjs's
 * decompression-bomb tests) — one deflate-path test below confirms both
 * compression methods still reach the same parser.
 */
function buildZip(entryName, contentUtf8, { deflate = false } = {}) {
  const raw = Buffer.from(contentUtf8, 'utf8');
  const data = deflate ? deflateRawSync(raw, { level: 9 }) : raw;
  const method = deflate ? 8 : 0;
  const name = Buffer.from(entryName, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localHeader = Buffer.concat([local, name]);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(method, 10);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(raw.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(0, 42);
  const central = Buffer.concat([cen, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localHeader.length + data.length, 16);

  return Buffer.concat([localHeader, data, central, eocd]);
}

/** Wraps a `<w:body>` fragment in the standard document.xml envelope. */
function wordDocXml(bodyFragment) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyFragment}</w:body></w:document>`;
}

function buildDocx(bodyFragment, opts = {}) {
  return buildZip('word/document.xml', wordDocXml(bodyFragment), opts);
}

// ── Correctness: legitimate documents ───────────────────────────────────

test('extracts a single paragraph of plain text', () => {
  const docx = buildDocx('<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>');
  assert.equal(extractDocxText(docx), 'Hello world');
});

test('joins multiple paragraphs with newlines', () => {
  const docx = buildDocx(
    '<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Third paragraph.</w:t></w:r></w:p>',
  );
  assert.equal(extractDocxText(docx), 'First paragraph.\nSecond paragraph.\nThird paragraph.');
});

test('tabs and breaks become literal tab/newline characters within a paragraph', () => {
  const docx = buildDocx(
    '<w:p><w:r><w:t>Name:</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Jane</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Line1</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Line2</w:t></w:r></w:p>',
  );
  assert.equal(extractDocxText(docx), 'Name:\tJane\nLine1\nLine2');
});

test('decodes named and numeric XML entities', () => {
  const docx = buildDocx(
    '<w:p><w:r><w:t>Tom &amp; Jerry &lt;3 &gt; &quot;quoted&quot; &apos;it&apos; &#65;&#x42;</w:t></w:r></w:p>',
  );
  assert.equal(extractDocxText(docx), 'Tom & Jerry <3 > "quoted" \'it\' AB');
});

test('a self-closing paragraph in the middle of the document produces a blank line', () => {
  const docx = buildDocx('<w:p><w:r><w:t>Before</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>After</w:t></w:r></w:p>');
  assert.equal(extractDocxText(docx), 'Before\n\nAfter');
});

test('a self-closing text run contributes no text', () => {
  const docx = buildDocx(
    '<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t/></w:r><w:r><w:t>B</w:t></w:r></w:p>',
  );
  assert.equal(extractDocxText(docx), 'AB');
});

test('paragraph and run properties (<w:pPr>, <w:pStyle>, <w:rPr>) do not leak into the extracted text', () => {
  const docx = buildDocx(
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr>' +
      '<w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>Bold Heading</w:t></w:r></w:p>',
  );
  assert.equal(extractDocxText(docx), 'Bold Heading');
});

test('same-prefixed sibling tags (<w:tbl>, <w:tblGrid>, <w:tcPr>) are not mistaken for text runs', () => {
  const docx = buildDocx(
    '<w:p><w:r><w:t>Before</w:t></w:r><w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr/></w:tc></w:tr></w:tbl><w:r><w:t>After</w:t></w:r></w:p>',
  );
  assert.equal(extractDocxText(docx), 'BeforeAfter');
});

test('a run with attributes (xml:space="preserve") preserves its raw content', () => {
  // The overall extracted text is .trim()'d (unchanged pre-existing
  // behavior), so the padded run is sandwiched between two other
  // paragraphs -- proving the INNER whitespace survives untouched while
  // only the whole-document boundary is trimmed.
  const docx = buildDocx(
    '<w:p><w:r><w:t>Before.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">  padded  </w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>After.</w:t></w:r></w:p>',
  );
  assert.equal(extractDocxText(docx), 'Before.\n  padded  \nAfter.');
});

test('a genuinely deflate-compressed document.xml parses identically to a stored one', () => {
  const body = '<w:p><w:r><w:t>Deflated content survives inflate + parse.</w:t></w:r></w:p>';
  const stored = buildDocx(body, { deflate: false });
  const deflated = buildDocx(body, { deflate: true });
  assert.equal(extractDocxText(stored), extractDocxText(deflated));
  assert.equal(extractDocxText(deflated), 'Deflated content survives inflate + parse.');
});

// ── Correctness: fail-closed paths ──────────────────────────────────────

test('refuses a ZIP with no word/document.xml entry', () => {
  const zip = buildZip('word/settings.xml', '<w:settings/>');
  assert.throws(() => extractDocxText(zip), (err) => {
    assert.ok(err instanceof DocxExtractionError);
    assert.equal(err.reasonCode, 'UNSUPPORTED_ARTIFACT');
    return true;
  });
});

test('refuses a document that extracts to no text at all', () => {
  const docx = buildDocx('<w:p><w:pPr/></w:p>');
  assert.throws(() => extractDocxText(docx), (err) => {
    assert.ok(err instanceof DocxExtractionError);
    assert.equal(err.reasonCode, 'UNSUPPORTED_ARTIFACT');
    assert.match(err.message, /no extractable text/);
    return true;
  });
});

// ── DoS regression: linear time on an adversarial, all-unclosed payload ──

test('an adversarial document with many unclosed <w:p> openings completes in linear time, not quadratic', () => {
  // No <w:t>/<w:p> in this payload is ever closed, so both scanners
  // (splitParagraphs looking for </w:p>, and — had any paragraph body been
  // captured — extractRuns looking for </w:t>) each do at most ONE
  // indexOf scan across the remaining buffer before giving up. That is the
  // property under test: total work bounded by input length once, not once
  // per candidate start position.
  const REPEATS = 60_000;
  const adversarial = '<w:p attr="unclosed-on-purpose">'.repeat(REPEATS);
  const docx = buildDocx(adversarial);

  const BOUND_MS = 3_000; // the pre-fix quadratic regex took ~7-8s at this size
  const start = process.hrtime.bigint();
  assert.throws(() => extractDocxText(docx), DocxExtractionError, 'no closing tag anywhere -> no extractable text');
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  assert.ok(
    elapsedMs < BOUND_MS,
    `extraction of ${REPEATS} unclosed <w:p> tags took ${elapsedMs.toFixed(1)}ms, expected < ${BOUND_MS}ms (a regression to backtracking regex parsing would multiply this by ~1000x+ at this input size)`,
  );
});

test('an adversarial mix of unclosed <w:p> and <w:t> tags inside one legitimate paragraph still completes in linear time', () => {
  // Same shape, one level down: a single real paragraph whose inner content
  // is flooded with unclosed <w:t ...> openings, exercising extractRuns's
  // own single-scan-to-EOF fallback rather than splitParagraphs's.
  const REPEATS = 60_000;
  const floodedInner = '<w:t attr="unclosed-on-purpose">'.repeat(REPEATS);
  const docx = buildDocx(`<w:p>${floodedInner}</w:p>`);

  const BOUND_MS = 3_000;
  const start = process.hrtime.bigint();
  assert.throws(() => extractDocxText(docx), DocxExtractionError, 'no closed run anywhere inside the paragraph -> no extractable text');
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  assert.ok(
    elapsedMs < BOUND_MS,
    `extraction of a paragraph flooded with ${REPEATS} unclosed <w:t> tags took ${elapsedMs.toFixed(1)}ms, expected < ${BOUND_MS}ms`,
  );
});
