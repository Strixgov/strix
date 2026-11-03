import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  probePdfjsRuntimeReadiness,
  assertPdfjsRuntimeReady,
  REQUIRED_RUNTIME_ASSETS,
} from '../src/artifact/pdfjs-runtime-readiness.mjs';
import { PDFJS_SUBSTRATE_STAGES, PDF_EXTRACTION_STAGES, isPdfExtractionStage } from '../src/artifact/pdf-extraction-stages.mjs';
import { PdfExtractionError } from '../src/artifact/pdf-text.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── The happy path, against the real install ────────────────────────────────

test('PDF.js production runtime readiness exercises native runtime and traced assets', async () => {
  const report = await probePdfjsRuntimeReadiness();
  assert.equal(report.ready, true, JSON.stringify(report));
  assert.equal(report.engine, 'mozilla-pdfjs');
  assert.deepEqual(report.assets, ['cmaps', 'standard_fonts', 'wasm']);
  assert.deepEqual(report.stagesVerified, [...PDFJS_SUBSTRATE_STAGES]);
});

test('assertion exposes the same executable readiness contract', async () => {
  const report = await assertPdfjsRuntimeReady();
  assert.equal(report.ready, true);
});

// ── Every substrate stage can fail, and each failure names ITSELF ───────────
//
// A probe whose only exercised path is the green one proves nothing about
// its red paths — the 2026-09-16 shape, where the probe existed and the
// production refusal still could not say which substrate was missing. Each
// stage is failed in isolation through the injected seam, and the assertion
// is on the STAGE, because the stage is the only field a receipt may carry.

const ok = {
  loadRuntime: async () => ({ installed: [] }),
  importPdfjs: async () => ({ getDocument: () => {} }),
  assetReadable: async () => {},
};

const failingAsset = (needle) => async (path) => {
  // Compare with forward slashes: on Windows the probe hands us C:\...\cmaps\...
  if (path.replaceAll('\\', '/').includes(needle)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
};

const STAGE_CASES = [
  ['canvas_binding', { loadRuntime: async () => { throw new PdfExtractionError('EXTRACTION_UNAVAILABLE', 'no binding', { stage: 'canvas_binding' }); } }],
  ['canvas_globals', { loadRuntime: async () => { throw new PdfExtractionError('EXTRACTION_UNAVAILABLE', 'no DOMMatrix', { stage: 'canvas_globals' }); } }],
  ['pdfjs_module', { importPdfjs: async () => { throw new Error('Cannot find module pdfjs-dist'); } }],
  ['pdfjs_module', { importPdfjs: async () => ({}) }],
  ['pdfjs_assets_cmaps', { assetReadable: failingAsset('/cmaps/') }],
  ['pdfjs_assets_fonts', { assetReadable: failingAsset('/standard_fonts/') }],
  ['pdfjs_assets_wasm', { assetReadable: failingAsset('/wasm/') }],
];

for (const [stage, override] of STAGE_CASES) {
  test(`a ${stage} failure reports stage=${stage} under EXTRACTION_UNAVAILABLE`, async () => {
    const report = await probePdfjsRuntimeReadiness({ ...ok, ...override });
    assert.equal(report.ready, false);
    assert.equal(report.reasonCode, 'EXTRACTION_UNAVAILABLE');
    assert.equal(report.stage, stage);
    assert.ok(isPdfExtractionStage(report.stage));
    assert.equal(typeof report.detail, 'string');
  });
}

test('the throwing form carries the stage on the extractor\'s own error type', async () => {
  await assert.rejects(
    () => assertPdfjsRuntimeReady({ ...ok, assetReadable: failingAsset('/wasm/') }),
    (err) => err instanceof PdfExtractionError && err.reasonCode === 'EXTRACTION_UNAVAILABLE' && err.stage === 'pdfjs_assets_wasm',
  );
});

test('a non-typed runtime failure is attributed to the earliest stage, never a later one', async () => {
  // A bare Error from the runtime loader means canvas never came up; blaming
  // pdfjs_module for it would send an operator to the wrong fix.
  const report = await probePdfjsRuntimeReadiness({ ...ok, loadRuntime: async () => { throw new Error('dlopen failed'); } });
  assert.equal(report.stage, 'canvas_binding');
});

test('stages fail in dependency order: an earlier failure masks a later one', async () => {
  const report = await probePdfjsRuntimeReadiness({
    ...ok,
    importPdfjs: async () => { throw new Error('module'); },
    assetReadable: failingAsset('/cmaps/'),
  });
  assert.equal(report.stage, 'pdfjs_module');
});

test('the asset check names FUNCTIONAL files, not license stubs', () => {
  for (const files of Object.values(REQUIRED_RUNTIME_ASSETS)) {
    assert.ok(files.length > 0);
    for (const f of files) assert.doesNotMatch(f, /LICENSE/i, `${f} is a license file, not a runtime asset`);
  }
  assert.ok(REQUIRED_RUNTIME_ASSETS.pdfjs_assets_cmaps.some((f) => f.endsWith('.bcmap')));
  assert.ok(REQUIRED_RUNTIME_ASSETS.pdfjs_assets_fonts.some((f) => /\.(pfb|ttf)$/.test(f)));
  assert.ok(REQUIRED_RUNTIME_ASSETS.pdfjs_assets_wasm.every((f) => f.endsWith('.wasm')));
});

test('every required asset exists in the installed pdfjs-dist, and fonts/wasm are named by its worker', async () => {
  // Derived from the shipped package, not remembered: a renamed or dropped
  // asset in a pdfjs-dist upgrade must fail here rather than leave a stale
  // probe reporting green. CMap NAMES are built at runtime from a font's
  // CIDSystemInfo (`${registry}-${ordering}-UCS2`), so for cmaps the unit is
  // existence of the file; fonts and wasm are named literally by the worker.
  const { createRequire } = await import('node:module');
  const { access } = await import('node:fs/promises');
  const require = createRequire(import.meta.url);
  const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const root = resolve(dirname(workerPath), '../..');
  const worker = readFileSync(workerPath, 'utf8');
  assert.ok(worker.includes('.bcmap'), 'the worker no longer loads binary CMaps; revisit the cmaps stage');
  for (const [stage, files] of Object.entries(REQUIRED_RUNTIME_ASSETS)) {
    for (const f of files) {
      await access(resolve(root, f));
      if (stage !== 'pdfjs_assets_cmaps') {
        const base = f.split('/').pop();
        assert.ok(worker.includes(base), `${base} is not referenced by pdf.worker.mjs`);
      }
    }
  }
});

// ── The vocabulary is closed and every extractor refusal uses it ────────────

test('the stage vocabulary is closed, unique, and content-free by shape', () => {
  assert.deepEqual([...new Set(PDF_EXTRACTION_STAGES)], [...PDF_EXTRACTION_STAGES]);
  for (const s of PDF_EXTRACTION_STAGES) assert.match(s, /^[a-z][a-z0-9_]{2,40}$/);
  assert.equal(isPdfExtractionStage('a patient name'), false);
  assert.equal(isPdfExtractionStage(''), false);
  assert.equal(isPdfExtractionStage(null), false);
});

test('every stage literal the extractor emits is a member of the closed set', () => {
  const src = stripComments(read('../src/artifact/pdfjs-text.mjs'));
  const emitted = [...src.matchAll(/(?:unavailable|safeStageFailure)\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 6, `expected the extractor to emit stages, found ${emitted.length}`);
  for (const s of emitted) assert.ok(isPdfExtractionStage(s), `${s} is not in PDF_EXTRACTION_STAGES`);
  // And no EXTRACTION_UNAVAILABLE may be raised WITHOUT a stage: the only
  // two-argument refuse() of that code would be a stage-less one.
  assert.doesNotMatch(src, /refuse\(\s*'EXTRACTION_UNAVAILABLE'\s*,\s*[^,()]*(?:\([^()]*\)[^,()]*)*\)/);
  assert.ok(/refuse\(\s*'EXTRACTION_UNAVAILABLE'\s*,\s*message\s*,\s*stage\s*\)/.test(src), 'the unavailable() helper must forward the stage');
});

// ── THE WIRING — the defect #2419 shipped ───────────────────────────────────

test('production extraction has exactly one PDF.js runtime gate', () => {
  // Readiness is an operator health surface, not an independent preflight
  // gate. The production request must enter the extractor directly so it
  // cannot be refused by a second resolver that the extractor does not use.
  const src = stripComments(read('../src/robust-prepare.mjs'));
  assert.doesNotMatch(src, /assertPdfjsRuntimeReady/);
  assert.match(src, /await extractPdfTextWithPdfJs\(bytes\)/);
});

test('readiness and extraction share the same authoritative asset resolver', () => {
  const readiness = stripComments(read('../src/artifact/pdfjs-runtime-readiness.mjs'));
  const extractor = stripComments(read('../src/artifact/pdfjs-text.mjs'));
  assert.match(readiness, /resolvePdfjsRuntimeAssets/);
  assert.match(extractor, /export function resolvePdfjsRuntimeAssets/);
  assert.doesNotMatch(readiness, /resolvePdfjsEntryPath/);
});
