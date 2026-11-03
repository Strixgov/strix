import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestArtifact } from '../src/artifact/ingest.mjs';

function pdf(parts) { return Buffer.from(`%PDF-1.7\n${parts.join('\n')}\n%%EOF`, 'latin1'); }

test('CID PDF proceeds only through an embedded ToUnicode mapping', () => {
  const cmap = `1 beginbfchar\n<0001> <0048>\n<0002> <0069>\nendbfchar`;
  const content = `BT /F1 12 Tf <0001> Tj <0002> Tj ET`;
  const bytes = pdf([
    `1 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 2 0 R >> endobj`,
    `2 0 obj << /Length ${cmap.length} >> stream\n${cmap}\nendstream endobj`,
    `3 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    `4 0 obj << /Font << /F1 1 0 R >> >> endobj`,
  ]);
  const result = ingestArtifact({ bytes, mimeType: 'application/pdf', filename: 'cid.pdf' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hi');
  assert.match(result.originalHash, /^[a-f0-9]{64}$/);
});

test('CID PDF with unmapped glyph fails closed instead of guessing', () => {
  const cmap = `1 beginbfchar\n<0001> <0048>\nendbfchar`;
  const content = `BT /F1 12 Tf <0001> Tj <0002> Tj ET`;
  const bytes = pdf([
    `1 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 2 0 R >> endobj`,
    `2 0 obj << /Length ${cmap.length} >> stream\n${cmap}\nendstream endobj`,
    `3 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    `4 0 obj << /Font << /F1 1 0 R >> >> endobj`,
  ]);
  const result = ingestArtifact({ bytes, mimeType: 'application/pdf' });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'EXTRACTION_UNRELIABLE');
});

test('image-only PDF is named OCR_REQUIRED and retains source hash', () => {
  const bytes = pdf([`1 0 obj << /Type /XObject /Subtype /Image /Length 4 >> stream\nABCD\nendstream endobj`]);
  const result = ingestArtifact({ bytes, mimeType: 'application/pdf', filename: 'scan.pdf' });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'OCR_REQUIRED');
  assert.match(result.originalHash, /^[a-f0-9]{64}$/);
});
