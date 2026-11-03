import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import {
  governedOcrExtract,
  OCR_REFUSAL_CODES,
  OCR_WORD_CONFIDENCE_FLOOR,
  OCR_PROVES,
} from '../src/artifact/governed-ocr.mjs';
import { isPdfExtractionStage, OCR_STAGES } from '../src/artifact/pdf-extraction-stages.mjs';

// Two blank pages: PDF.js opens it and finds no text layer → OCR_REQUIRED, pageCount 2.
const IMAGE_ONLY_PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj
4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj
trailer<</Root 1 0 R>>`, 'latin1');

function words(line, text, confidence = 0.97) {
  return text.split(' ').map((t) => ({ text: t, confidence, line }));
}

function engine(pages, overrides = {}) {
  const calls = [];
  return {
    calls,
    id: 'test-ocr',
    version: '1.0.0',
    locality: 'local-in-process',
    async recognize(input) { calls.push(input); return { pages: typeof pages === 'function' ? pages(input) : pages }; },
    ...overrides,
  };
}

const CLEAN_PAGES = [
  { pageNumber: 1, words: [...words(0, 'Claim summary for review'), ...words(1, 'Patient: Jane Doe')] },
  { pageNumber: 2, words: words(0, 'Balance due 120 dollars') },
];

function input(deps = {}, evidence) {
  return {
    source: { bytes: IMAGE_ONLY_PDF, filename: 'scan.pdf' },
    prompt: 'Summarize this document.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'ocr-regression',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'ocr-actor',
    principal: { authenticationMethod: 'session', subject: 's', tenantId: 't' },
    deps: {
      detector: createPatternDetector(),
      transformer: createTokenizingTransformer(),
      evidence,
      ...deps,
    },
  };
}

// ── Dormancy: no engine means the pre-existing contract, unchanged ──────────

test('with no OCR engine an image-only PDF still refuses OCR_REQUIRED', async () => {
  const r = await prepareDocumentForEgress(input());
  assert.equal(r.outcome, 'DENY');
  assert.equal(r.reasonCode, 'OCR_REQUIRED');
  assert.equal(r.artifact.extraction.engine, 'mozilla-pdfjs');
});

test('an OCR engine is never consulted for a document that HAS a text layer', async () => {
  const e = engine(CLEAN_PAGES);
  const r = await prepareDocumentForEgress({ ...input({ ocr: e }), source: { text: 'Plain text note.', filename: 'a.txt' } });
  assert.notEqual(r.outcome, 'DENY');
  assert.equal(e.calls.length, 0);
});

// ── Success: OCR text enters the SAME inspection, with provenance ──────────

test('governed OCR text enters inspection and the identifier is tokenized', async () => {
  const e = engine(CLEAN_PAGES);
  const r = await prepareDocumentForEgress(input({ ocr: e }));
  assert.equal(r.outcome, 'PREPARED', r.detail);
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].pageCount, 2, 'page count comes from PDF.js, not the engine');
  assert.doesNotMatch(r.releaseText, /Jane Doe/);
  assert.match(r.releaseText, /\[PATIENT_001\]/);
  const x = r.artifact.extraction;
  assert.equal(x.engine, 'governed-ocr');
  assert.equal(x.textSource, 'ocr');
  assert.equal(x.outcome, 'extracted');
  assert.equal(x.mode, 'local-in-process');
  assert.deepEqual(x.ocrEngine, { id: 'test-ocr', version: '1.0.0' });
  assert.equal(x.pageCount, 2);
  assert.equal(x.proves, OCR_PROVES);
  assert.match(x.originalArtifactHash, /^[a-f0-9]{64}$/);
});

// ── Every way the engine can fall short is a NAMED refusal ─────────────────

async function refusedWith(deps, code, stage) {
  const entries = [];
  const r = await prepareDocumentForEgress(input(deps, { append: (x) => entries.push(x) }));
  assert.equal(r.outcome, 'DENY');
  assert.equal(r.reasonCode, code);
  assert.equal(r.artifact.extraction.engine, 'governed-ocr');
  assert.equal(r.artifact.extraction.stage, stage);
  assert.equal(r.receipt.reasonCode, code);
  assert.equal(r.receipt.extraction.stage, stage);
  assert.equal(r.receipt.disclosureStatus, 'not_disclosed');
  assert.equal(entries.length, 1);
  // The words the engine read never reach a receipt or evidence entry.
  assert.doesNotMatch(JSON.stringify({ receipt: r.receipt, entries }), /Jane|Doe|Balance/);
  return r;
}

test('an off-host engine is refused BEFORE it is handed the document', async () => {
  const e = engine(CLEAN_PAGES, { locality: 'remote-api' });
  await refusedWith({ ocr: e }, 'OCR_ENGINE_NOT_LOCAL', 'ocr_engine');
  assert.equal(e.calls.length, 0, 'raw PHI must never reach an off-host engine');
});

test('a missing locality declaration is treated as off-host, not as local', async () => {
  const e = engine(CLEAN_PAGES, { locality: undefined });
  await refusedWith({ ocr: e }, 'OCR_ENGINE_NOT_LOCAL', 'ocr_engine');
  assert.equal(e.calls.length, 0);
});

test('a dropped page is OCR_INCOMPLETE — the engine does not decide page count', async () => {
  await refusedWith({ ocr: engine([CLEAN_PAGES[0]]) }, 'OCR_INCOMPLETE', 'ocr_page_coverage');
});

test('an EXTRA page is OCR_INCOMPLETE — the result disagrees with the parser', async () => {
  const extra = [...CLEAN_PAGES, { pageNumber: 3, words: words(0, 'phantom page') }];
  await refusedWith({ ocr: engine(extra) }, 'OCR_INCOMPLETE', 'ocr_page_coverage');
});

test('pages out of order are OCR_INCOMPLETE', async () => {
  await refusedWith({ ocr: engine([CLEAN_PAGES[1], CLEAN_PAGES[0]]) }, 'OCR_INCOMPLETE', 'ocr_page_coverage');
});

test('one low-confidence word refuses the whole document', async () => {
  const pages = [
    { pageNumber: 1, words: [...words(0, 'Patient:'), { text: 'J4ne', confidence: 0.55, line: 0 }] },
    CLEAN_PAGES[1],
  ];
  await refusedWith({ ocr: engine(pages) }, 'OCR_LOW_CONFIDENCE', 'ocr_confidence');
});

test('a page whose mean is below the floor refuses even when no word is', async () => {
  const pages = [{ pageNumber: 1, words: words(0, 'a b c d', 0.85) }, CLEAN_PAGES[1]];
  await refusedWith({ ocr: engine(pages) }, 'OCR_LOW_CONFIDENCE', 'ocr_confidence');
});

test('a throwing engine is OCR_FAILED, never "no text"', async () => {
  const e = engine(CLEAN_PAGES, { async recognize() { throw new TypeError('boom'); } });
  await refusedWith({ ocr: e }, 'OCR_FAILED', 'ocr_engine');
});

test('a non-finite confidence is OCR_FAILED', async () => {
  const pages = [{ pageNumber: 1, words: [{ text: 'x', confidence: Number.NaN }] }, CLEAN_PAGES[1]];
  await refusedWith({ ocr: engine(pages) }, 'OCR_FAILED', 'ocr_engine');
});

test('a scan that reads as blank is OCR_NO_TEXT, not a clean document', async () => {
  const pages = [{ pageNumber: 1, words: [] }, { pageNumber: 2, words: [] }];
  await refusedWith({ ocr: engine(pages) }, 'OCR_NO_TEXT', null);
});

// ── Stricter-only thresholds ────────────────────────────────────────────────

test('thresholds can be raised but never lowered below the built-in floor', async () => {
  // Page mean 0.9175 clears the page floor; only the 0.7 word is below the
  // WORD floor — so this isolates the word-floor lowering attempt.
  const pages = [{ pageNumber: 1, words: [...words(0, 'a b c', 0.99), { text: 'd', confidence: 0.7, line: 0 }] }];
  const lowered = governedOcrExtract(IMAGE_ONLY_PDF, {
    pageCount: 1,
    engine: engine(pages),
    thresholds: { wordConfidenceFloor: 0.1 },
  });
  await assert.rejects(lowered, (e) => e.reasonCode === 'OCR_LOW_CONFIDENCE');

  const raised = governedOcrExtract(IMAGE_ONLY_PDF, {
    pageCount: 1,
    engine: engine([{ pageNumber: 1, words: words(0, 'hello there', 0.95) }]),
    thresholds: { wordConfidenceFloor: 0.99 },
  });
  await assert.rejects(raised, (e) => e.reasonCode === 'OCR_LOW_CONFIDENCE');
  assert.ok(OCR_WORD_CONFIDENCE_FLOOR >= 0.8);
});

test('the page-mean floor cannot be lowered either', async () => {
  const pages = [{ pageNumber: 1, words: words(0, 'a b c d', 0.85) }];
  await assert.rejects(
    governedOcrExtract(IMAGE_ONLY_PDF, { pageCount: 1, engine: engine(pages), thresholds: { pageMeanConfidenceFloor: 0.1 } }),
    (e) => e.reasonCode === 'OCR_LOW_CONFIDENCE',
  );
});

test('an unknown page count refuses rather than trusting the engine', async () => {
  await assert.rejects(
    governedOcrExtract(IMAGE_ONLY_PDF, { pageCount: null, engine: engine(CLEAN_PAGES) }),
    (e) => e.reasonCode === 'OCR_INCOMPLETE',
  );
});

// ── Vocabulary ──────────────────────────────────────────────────────────────

test('every OCR stage is in the closed vocabulary and every stage the module emits is declared', () => {
  for (const s of OCR_STAGES) assert.ok(isPdfExtractionStage(s));
  const src = readFileSync(new URL('../src/artifact/governed-ocr.mjs', import.meta.url), 'utf8');
  const emitted = [...src.matchAll(/refuse\(\s*'[A-Z_]+'\s*,[^;]*?,\s*'([a-z_]+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 5);
  for (const s of emitted) assert.ok(isPdfExtractionStage(s), `${s} not declared`);
  const codes = [...src.matchAll(/refuse\(\s*'([A-Z_]+)'/g)].map((m) => m[1]).filter((c) => c !== 'EXTRACTION_UNRELIABLE');
  for (const c of codes) assert.ok(OCR_REFUSAL_CODES.includes(c), `${c} missing from OCR_REFUSAL_CODES`);
});
