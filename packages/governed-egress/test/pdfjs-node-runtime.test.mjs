import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { extractPdfTextWithPdfJs, loadPdfjsNodeRuntime, openPdfjsDocumentForText } from '../src/artifact/pdfjs-text.mjs';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../src/artifact/pdfjs-text.mjs'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// A one-page PDF with a text run. No xref table on purpose — pdfjs indexes
// objects itself, which is the path the production specimen exercises.
const TEXT_PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 20 40 Td (Hello Strix) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>`, 'latin1');

test('pdfjs-text keeps governed text extraction independent of native canvas', () => {
  const code = stripComments(src);
  assert.doesNotMatch(code, /@napi-rs\/canvas/);
  assert.match(code, /import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/);
  assert.match(
    code,
    /const pdfjs = await importPdfjsAfterNodeRuntime\(\);/,
    'the legacy parser remains the production text-extraction authority',
  );
  assert.doesNotMatch(code, /^import \* as pdfjs from /m, 'a module-level PDF.js import obscures the deployed parser path');
});

test('loadPdfjsNodeRuntime preloads the PDF.js fake worker for serverless extraction', async () => {
  const { installed } = await loadPdfjsNodeRuntime();
  assert.deepEqual(installed, ['pdfjs_worker']);
  assert.equal(typeof globalThis.pdfjsWorker?.WorkerMessageHandler, 'function');
});

test('document open retries in text-only mode when optional deployed assets fail', async () => {
  const calls = [];
  let firstTaskDestroyed = false;
  let secondTaskDestroyed = false;
  const doc = { numPages: 1 };
  const pdfjs = {
    getDocument(options) {
      calls.push(options);
      if (calls.length === 1) {
        return {
          promise: Promise.reject(new Error('optional asset file could not be opened')),
          destroy: async () => { firstTaskDestroyed = true; },
        };
      }
      return {
        promise: Promise.resolve(doc),
        destroy: async () => { secondTaskDestroyed = true; },
      };
    },
  };
  const assets = {
    cMapUrl: 'file:///var/task/.pdfjs-runtime/cmaps/',
    standardFontDataUrl: 'file:///var/task/.pdfjs-runtime/standard_fonts/',
    wasmUrl: 'file:///var/task/.pdfjs-runtime/wasm/',
  };

  const opened = await openPdfjsDocumentForText(pdfjs, TEXT_PDF, assets);

  assert.equal(opened.doc, doc);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cMapUrl, assets.cMapUrl);
  assert.equal(calls[1].cMapUrl, undefined);
  assert.equal(calls[1].standardFontDataUrl, undefined);
  assert.equal(calls[1].wasmUrl, undefined);
  assert.equal(calls[1].useWasm, false);
  assert.equal(firstTaskDestroyed, true);
  await opened.task.destroy();
  assert.equal(secondTaskDestroyed, true);
});

test('the production parser extracts text with no canvas/polyfill warnings', async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  let text;
  try {
    text = await extractPdfTextWithPdfJs(TEXT_PDF);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(text, 'Hello Strix');
  const runtimeWarnings = warnings.filter((w) => /napi-rs\/canvas|Cannot polyfill/.test(w));
  assert.deepEqual(runtimeWarnings, [], `pdfjs-dist warned about its Node runtime: ${JSON.stringify(runtimeWarnings)}`);
});

test('robust prepare reports engine mozilla-pdfjs for a PDF the production parser read', async () => {
  const result = await prepareDocumentForEgress({
    source: { bytes: TEXT_PDF, filename: 'hello.pdf' },
    prompt: 'Summarize this document.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'runtime-pin',
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer() },
  });
  // Whatever the downstream policy decides, the extraction record must name
  // the production engine — that is the fact the 2026-09-16 refusal lacked.
  assert.equal(result?.artifact?.extraction?.engine, 'mozilla-pdfjs');
});
