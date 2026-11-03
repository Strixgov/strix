import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRefusalReceipt } from '../src/evidence/refusal-receipt.mjs';
import { extractionRefusal, attachExtractionRefusal } from '../src/robust-prepare.mjs';
import { PdfExtractionError } from '../src/artifact/pdf-text.mjs';
import { PDF_EXTRACTION_STAGES } from '../src/artifact/pdf-extraction-stages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ARTIFACT = { originalHash: 'a'.repeat(64), mimeType: 'application/pdf', sizeBytes: 12, filename: 'MRN-99218472 chart.pdf' };
const INPUT = {
  actor: 'ops-user',
  principal: { authenticationMethod: 'session', subject: 'ops-user', tenantId: 'tenant-1' },
  destination: { provider: 'anthropic', service: 'messages' },
  purpose: 'summarize discharge note for patient Jane Roe',
  policy: { policyId: 'healthcare-reference', policyVersion: '1' },
};

test('a substrate refusal carries its stage on the artifact, the receipt, AND the evidence entry', () => {
  const err = new PdfExtractionError(
    'EXTRACTION_UNAVAILABLE',
    'Governed PDF extraction runtime is not ready at stage pdfjs_assets_wasm: pdfjs runtime asset missing: wasm/openjpeg.wasm (ENOENT: /var/task/node_modules/pdfjs-dist/wasm/openjpeg.wasm)',
    { stage: 'pdfjs_assets_wasm' },
  );
  const entries = [];
  const refusal = attachExtractionRefusal(extractionRefusal(err, ARTIFACT), { ...INPUT, deps: { evidence: { append: (e) => entries.push(e) } } });

  assert.equal(refusal.outcome, 'DENY');
  assert.equal(refusal.reasonCode, 'EXTRACTION_UNAVAILABLE');
  assert.equal(refusal.artifact.extraction.stage, 'pdfjs_assets_wasm');
  assert.deepEqual(refusal.receipt.extraction, { engine: 'mozilla-pdfjs', stage: 'pdfjs_assets_wasm' });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].extraction, { engine: 'mozilla-pdfjs', stage: 'pdfjs_assets_wasm' });
});

test('the free-text detail — which may name filesystem paths — never reaches the receipt or evidence', () => {
  const err = new PdfExtractionError('EXTRACTION_UNAVAILABLE', 'ENOENT: /var/task/secret/path', { stage: 'pdfjs_assets_cmaps' });
  const entries = [];
  const refusal = attachExtractionRefusal(extractionRefusal(err, ARTIFACT), { ...INPUT, deps: { evidence: { append: (e) => entries.push(e) } } });
  const persisted = JSON.stringify({ receipt: refusal.receipt, evidence: entries });
  assert.doesNotMatch(persisted, /var\/task/);
  assert.doesNotMatch(persisted, /ENOENT/);
  assert.doesNotMatch(persisted, /Jane Roe/);
  assert.doesNotMatch(persisted, /MRN-99218472/);
  // The detail is still available to the caller for a log line.
  assert.match(refusal.detail, /ENOENT/);
});

test('a document-stage failure carries its stage the same way', () => {
  const err = new PdfExtractionError('EXTRACTION_FAILED', 'PDF page-3-text failed (TypeError)', { stage: 'page_text' });
  const refusal = extractionRefusal(err, ARTIFACT);
  assert.equal(refusal.artifact.extraction.stage, 'page_text');
});

test('a content refusal with no stage carries stage null, never a guess', () => {
  const err = new PdfExtractionError('OCR_REQUIRED', 'no text layer');
  const refusal = extractionRefusal(err, ARTIFACT);
  assert.equal(refusal.artifact.extraction.stage, null);
  assert.equal(refusal.artifact.extraction.reasonCode, 'OCR_REQUIRED');
});

test('the receipt REFUSES a stage outside the closed set — prose cannot ride the stage slot', () => {
  const receipt = buildRefusalReceipt({
    reasonCode: 'EXTRACTION_UNAVAILABLE',
    extraction: { engine: 'mozilla-pdfjs', stage: 'page 3 mentions patient Jane Roe MRN 99218472' },
  });
  assert.deepEqual(receipt.extraction, { engine: 'mozilla-pdfjs', stage: null });
  assert.doesNotMatch(JSON.stringify(receipt), /Jane Roe|99218472/);
});

test('the receipt REFUSES an engine that is not an identifier', () => {
  const receipt = buildRefusalReceipt({ reasonCode: 'X', extraction: { engine: 'engine that says patient Roe', stage: 'page_text' } });
  assert.deepEqual(receipt.extraction, { engine: null, stage: 'page_text' });
});

test('a receipt with no extraction input carries extraction: null (non-PDF refusals unchanged)', () => {
  const receipt = buildRefusalReceipt({ reasonCode: 'PROMPT_CONTAINS_SENSITIVE_DATA' });
  assert.equal(receipt.extraction, null);
});

test('every member of the closed set is accepted by the receipt', () => {
  for (const stage of PDF_EXTRACTION_STAGES) {
    const receipt = buildRefusalReceipt({ reasonCode: 'EXTRACTION_FAILED', extraction: { engine: 'mozilla-pdfjs', stage } });
    assert.equal(receipt.extraction.stage, stage);
  }
});

test('robust-prepare hands the receipt builder the extraction block and forwards it to evidence', () => {
  const src = stripComments(readFileSync(resolve(here, '../src/robust-prepare.mjs'), 'utf8'));
  assert.match(src, /extraction:\s*refusal\.artifact\?\.extraction\s*\?\?\s*null/);
  assert.match(src, /extraction:\s*receipt\.extraction/);
});
