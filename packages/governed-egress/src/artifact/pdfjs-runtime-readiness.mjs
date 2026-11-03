import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PdfExtractionError } from './pdf-text.mjs';
import { loadPdfjsNodeRuntime, resolvePdfjsRuntimeAssets } from './pdfjs-text.mjs';
import { PDFJS_SUBSTRATE_STAGES } from './pdf-extraction-stages.mjs';

export { PDFJS_SUBSTRATE_STAGES };

/**
 * The FUNCTIONAL asset each runtime directory must supply. Checked by name
 * rather than "the directory exists": a traced directory that carries only
 * LICENSE files would pass an existence check and fail the first CID font.
 * Every name below is one PDF.js's own worker resolves at runtime
 * (`legacy/build/pdf.worker.mjs` names each of them).
 */
export const REQUIRED_RUNTIME_ASSETS = Object.freeze({
  pdfjs_assets_cmaps: Object.freeze(['cmaps/Adobe-Japan1-UCS2.bcmap']),
  pdfjs_assets_fonts: Object.freeze(['standard_fonts/FoxitSerif.pfb', 'standard_fonts/LiberationSans-Regular.ttf']),
  pdfjs_assets_wasm: Object.freeze(['wasm/openjpeg.wasm', 'wasm/qcms_bg.wasm', 'wasm/jbig2.wasm']),
});

const ASSET_DIRS = Object.freeze(['cmaps', 'standard_fonts', 'wasm']);


function safeError(err) {
  return String(err?.message ?? err ?? 'unknown failure')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

async function defaultAssetReadable(path) {
  await access(path, fsConstants.R_OK);
}

const DEFAULT_DEPS = Object.freeze({
  loadRuntime: loadPdfjsNodeRuntime,
  importPdfjs: () => import('pdfjs-dist/legacy/build/pdf.mjs'),
  assetReadable: defaultAssetReadable,
});

function notReady(stage, detail) {
  return Object.freeze({
    ready: false,
    engine: 'mozilla-pdfjs',
    runtime: 'node',
    reasonCode: 'EXTRACTION_UNAVAILABLE',
    stage,
    detail,
  });
}

/**
 * Prove, in THIS process, that the production PDF extraction substrate can
 * initialize — and when it cannot, name the STAGE that failed.
 *
 * The stages run in the order the extractor needs them, and the first failure
 * is the answer: a missing canvas binding would also make the PDF.js import
 * fail, so reporting the later stage would misattribute the cause.
 *
 *   canvas_binding → canvas_globals → pdfjs_module → pdfjs_assets_root
 *   → pdfjs_assets_cmaps → pdfjs_assets_fonts → pdfjs_assets_wasm
 *
 * It never opens customer bytes and never calls a provider. `detail` is a
 * sanitized mechanism message for logs; it may name filesystem paths and must
 * never be persisted on a refusal receipt — the receipt carries `stage` only.
 *
 * `deps` exists so every stage's failure can be exercised in a test without a
 * broken install; production callers pass nothing.
 */
export async function probePdfjsRuntimeReadiness(deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };

  try {
    await d.loadRuntime();
  } catch (err) {
    const stage = err instanceof PdfExtractionError && err.stage ? err.stage : 'canvas_binding';
    return notReady(stage, safeError(err));
  }

  let pdfjs;
  try {
    pdfjs = await d.importPdfjs();
  } catch (err) {
    return notReady('pdfjs_module', safeError(err));
  }
  if (typeof pdfjs?.getDocument !== 'function') {
    return notReady('pdfjs_module', 'pdfjs-dist getDocument export is unavailable');
  }

  let assets;
  try {
    assets = resolvePdfjsRuntimeAssets();
  } catch (err) {
    return notReady('pdfjs_assets_root', safeError(err));
  }

  const roots = Object.freeze({
    pdfjs_assets_cmaps: assets.cMapPath,
    pdfjs_assets_fonts: assets.standardFontDataPath,
    pdfjs_assets_wasm: assets.wasmPath,
  });
  for (const [stage, files] of Object.entries(REQUIRED_RUNTIME_ASSETS)) {
    const root = roots[stage];
    for (const rel of files) {
      const name = rel.slice(rel.indexOf('/') + 1);
      try {
        await d.assetReadable(resolve(root, name));
      } catch (err) {
        return notReady(stage, `pdfjs runtime asset missing: ${rel} (${safeError(err)})`);
      }
    }
  }

  return Object.freeze({
    ready: true,
    engine: 'mozilla-pdfjs',
    runtime: 'node',
    assets: [...ASSET_DIRS],
    stagesVerified: [...PDFJS_SUBSTRATE_STAGES],
  });
}

/**
 * The production form: throws the same `PdfExtractionError` the extractor
 * throws, with `reasonCode = EXTRACTION_UNAVAILABLE` and the failing `stage`,
 * so a caller that already maps extraction errors to refusals needs no second
 * branch. This is what `robust-prepare.mjs` awaits BEFORE extraction.
 */
export async function assertPdfjsRuntimeReady(deps = {}) {
  const report = await probePdfjsRuntimeReadiness(deps);
  if (!report.ready) {
    throw new PdfExtractionError(
      report.reasonCode,
      `Governed PDF extraction runtime is not ready at stage ${report.stage}: ${report.detail}`,
      { stage: report.stage },
    );
  }
  return report;
}
