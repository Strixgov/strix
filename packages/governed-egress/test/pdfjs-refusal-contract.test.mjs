import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';

// Structurally valid enough for PDF.js to open, but with no text operators.
// The authoritative production parser must classify this as OCR_REQUIRED and
// robust preparation must preserve the ordinary refusal receipt/evidence contract.
const IMAGE_ONLY_PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj
trailer<</Root 1 0 R>>`, 'latin1');

function input(evidence) {
  return {
    source: { bytes: IMAGE_ONLY_PDF, filename: 'specimen.pdf' },
    prompt: 'Summarize this document.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'refusal-contract-regression',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'regression-actor',
    principal: { authenticationMethod: 'session', subject: 'regression-subject', tenantId: 'regression-tenant' },
    deps: {
      detector: createPatternDetector(),
      transformer: createTokenizingTransformer(),
      evidence,
    },
  };
}

test('authoritative PDF.js OCR refusal carries receipt and one safe evidence record', async () => {
  const entries = [];
  const result = await prepareDocumentForEgress(input({ append: (entry) => entries.push(entry) }));

  assert.equal(result.outcome, 'DENY');
  assert.equal(result.reasonCode, 'OCR_REQUIRED');
  assert.ok(result.receipt, 'PDF extraction refusal must carry a refusal receipt');
  assert.equal(result.receipt.reasonCode, 'OCR_REQUIRED');
  assert.equal(result.receipt.execution, 'not_attempted');
  assert.equal(result.receipt.disclosureStatus, 'not_disclosed');
  assert.equal(result.artifact.extraction.engine, 'mozilla-pdfjs');
  assert.equal(result.artifact.extraction.outcome, 'refused');

  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'egress_refused');
  assert.equal(entries[0].reasonCode, 'OCR_REQUIRED');
  assert.equal(entries[0].execution, 'not_attempted');
  assert.equal(entries[0].disclosureStatus, 'not_disclosed');

  const persisted = JSON.stringify({ receipt: result.receipt, evidence: entries });
  assert.doesNotMatch(persisted, /Summarize this document/);
  assert.doesNotMatch(persisted, /refusal-contract-regression/);
});

test('PDF.js refusal is terminal: production robust preparation contains no compatibility parser', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/robust-prepare.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /extractProductionPdfText/);
  assert.doesNotMatch(source, /strix-pdf-compat/);
});

test('OCR_REQUIRED carries NO stage: every substrate stage worked, the document has no text layer', async () => {
  const entries = [];
  const result = await prepareDocumentForEgress(input({ append: (entry) => entries.push(entry) }));

  assert.equal(result.reasonCode, 'OCR_REQUIRED');
  // A stage names the mechanism that FAILED. On OCR_REQUIRED nothing failed:
  // canvas loaded, PDF.js imported, the assets resolved, the document opened,
  // every page's text content was read — and it was empty. Stamping a stage
  // here would report a missing substrate to an operator whose substrate is
  // fine, sending them to redeploy a function that is already correct.
  assert.equal(result.artifact.extraction.stage, null);
  assert.equal(result.receipt.extraction.stage, null);
  // The engine still rides along on both, because "which parser refused" is
  // answerable and useful on every refusal, stage or no stage.
  assert.equal(result.receipt.extraction.engine, 'mozilla-pdfjs');
  assert.equal(entries[0].extraction.engine, 'mozilla-pdfjs');
  assert.equal(entries[0].extraction.stage, null);
});

test('the receipt refuses a stage outside the closed set, and never carries free text', async () => {
  const { buildRefusalReceipt } = await import('../src/evidence/refusal-receipt.mjs');
  const { PDF_EXTRACTION_STAGES } = await import('../src/artifact/pdf-extraction-stages.mjs');

  // Every declared stage survives the receipt builder verbatim. Derived from
  // the exported set rather than a list retyped here, so a stage added to the
  // vocabulary without a receipt path fails this test rather than shipping
  // silently as null.
  for (const stage of PDF_EXTRACTION_STAGES) {
    const receipt = buildRefusalReceipt({
      reasonCode: 'EXTRACTION_UNAVAILABLE',
      extraction: { engine: 'mozilla-pdfjs', stage },
    });
    assert.equal(receipt.extraction.stage, stage, `stage ${stage} must survive the receipt builder`);
  }

  // A parser exception message in the stage slot — the exact value the
  // 2026-09-16 refusal had and could not carry — is dropped, not persisted.
  const smuggled = buildRefusalReceipt({
    reasonCode: 'EXTRACTION_UNAVAILABLE',
    extraction: {
      engine: 'mozilla-pdfjs',
      stage: "Cannot find module '/var/task/node_modules/@napi-rs/canvas/index.js'",
    },
  });
  assert.equal(smuggled.extraction.stage, null);
  assert.doesNotMatch(JSON.stringify(smuggled), /var\/task|Cannot find module/);
});
