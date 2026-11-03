import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PdfExtractionError } from './pdf-text.mjs';
import { MAX_ARTIFACT_BYTES } from './limits.mjs';

const MAX_PAGES = 250;
const MAX_EXTRACTED_TEXT_BYTES = 16 * 1024 * 1024;

function refuse(code, message, stage = null, pageCount = null) { throw new PdfExtractionError(code, message, { stage, pageCount }); }

/**
 * A substrate refusal: the MACHINERY is missing, not the document. Every one
 * carries a `stage` from `PDFJS_SUBSTRATE_STAGES` so the refusal receipt can
 * say which of canvas / PDF.js / CMaps / fonts / WASM was absent without
 * carrying the parser's free-text message (which may name filesystem paths).
 */
function unavailable(stage, message) { refuse('EXTRACTION_UNAVAILABLE', message, stage); }

function normalizePage(items) {
  const out = [];
  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue;
    const s = item.str.replace(/\u0000/g, '');
    if (s) out.push(s);
    out.push(item.hasEOL ? '\n' : ' ');
  }
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function qualityCheck(text, pageCount = null) {
  if (!text.trim()) refuse('OCR_REQUIRED', 'PDF contains no safely extractable text layer; OCR is required', null, pageCount);
  const chars = [...text];
  const replacement = chars.filter((c) => c === '\uFFFD').length;
  const controls = chars.filter((c) => { const n = c.codePointAt(0); return n < 32 && c !== '\n' && c !== '\r' && c !== '\t'; }).length;
  if (replacement || controls) refuse('EXTRACTION_UNRELIABLE', 'PDF text contains undecodable or control glyphs');
  if (Buffer.byteLength(text, 'utf8') > MAX_EXTRACTED_TEXT_BYTES) refuse('EXTRACTED_TEXT_TOO_LARGE', `extracted PDF text exceeds ${MAX_EXTRACTED_TEXT_BYTES} bytes`);
}

/**
 * PDF.js's legacy parser can open and extract text without a canvas backend.
 * Rendering needs DOM canvas objects; governed egress never renders source
 * pages, so a native module and process-wide DOM globals add a deployment
 * dependency without improving the inspected text.
 */
export async function loadPdfjsNodeRuntime() {
  try {
    // In Node, PDF.js deliberately uses its in-process "fake worker". Its
    // loader performs a runtime import of pdf.worker.mjs that Vercel does not
    // automatically trace. Loading the worker through this literal import
    // makes it part of the server function, then gives PDF.js the already
    // loaded handler without a second filesystem-dependent import.
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    if (typeof worker?.WorkerMessageHandler !== 'function') {
      unavailable('pdfjs_module', 'production PDF parser unavailable: pdf.worker.mjs lacks WorkerMessageHandler');
    }
    globalThis.pdfjsWorker = worker;
    return { installed: ['pdfjs_worker'] };
  } catch (err) {
    if (err instanceof PdfExtractionError) throw err;
    unavailable('pdfjs_module', 'production PDF parser unavailable: pdf.worker.mjs could not be loaded');
  }
}

async function importPdfjsAfterNodeRuntime() {
  try {
    return await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (err) {
    unavailable('pdfjs_module', `production PDF parser unavailable: pdfjs-dist could not be loaded (${err?.message ?? 'import failed'})`);
  }
}



const PDFJS_REQUIRED_RUNTIME_ASSETS = Object.freeze([
  'cmaps/Adobe-Japan1-UCS2.bcmap',
  'standard_fonts/FoxitSerif.pfb',
  'standard_fonts/LiberationSans-Regular.ttf',
  'wasm/openjpeg.wasm',
  'wasm/qcms_bg.wasm',
  'wasm/jbig2.wasm',
]);

function assetsFromRoot(root) {
  const cMapPath = resolve(root, 'cmaps');
  const standardFontDataPath = resolve(root, 'standard_fonts');
  const wasmPath = resolve(root, 'wasm');
  const url = (path) => `${pathToFileURL(path).href}/`;
  return Object.freeze({
    root,
    cMapPath,
    standardFontDataPath,
    wasmPath,
    cMapUrl: url(cMapPath),
    standardFontDataUrl: url(standardFontDataPath),
    wasmUrl: url(wasmPath),
  });
}

function hasCompletePdfjsRuntimeAssets(root) {
  return PDFJS_REQUIRED_RUNTIME_ASSETS.every((asset) => existsSync(resolve(root, asset)));
}

export function resolvePdfjsRuntimeAssets({ deploymentRoot = process.cwd() } = {}) {
  // Vercel bundles workspace source, so import.meta.resolve can no longer
  // reliably identify pdfjs-dist's package root at runtime. The build copies
  // these non-JS parser resources into a fixed console-local directory and
  // output tracing carries that directory into each server function.
  const deployedRoot = resolve(deploymentRoot, '.pdfjs-runtime');
  if (hasCompletePdfjsRuntimeAssets(deployedRoot)) return assetsFromRoot(deployedRoot);

  // Local development and package-level tests do not run the console build;
  // preserve direct package discovery there while failing closed if it is
  // incomplete.
  try {
    const entryUrl = import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    // fileURLToPath, not URL.pathname: on Windows the pathname is /C:/…, which
    // resolves to a path that does not exist and the parser reads as absent.
    const root = resolve(dirname(fileURLToPath(entryUrl)), '../..');
    if (!hasCompletePdfjsRuntimeAssets(root)) throw new Error('the local pdfjs-dist runtime assets are incomplete');
    return assetsFromRoot(root);
  } catch (err) {
    unavailable('pdfjs_assets_root', `production PDF parser assets unavailable (${err?.message ?? 'resolve failed'})`);
  }
}

/**
 * @param {'document_open'|'page_open'|'page_text'} stage — closed document stage
 * @param {string} label — human label carrying the page number for the message only
 */
function safeStageFailure(stage, label, err) {
  if (err instanceof PdfExtractionError) throw err;
  const name = String(err?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
  refuse('EXTRACTION_FAILED', `PDF ${label} failed (${name})`, stage);
}

function documentOptions(data, assets = {}) {
  return {
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    useWorkerFetch: false,
    stopAtErrors: false,
    ...assets,
  };
}

function isPasswordError(err) {
  return /Password/i.test(String(err?.name ?? '')) || /password/i.test(String(err?.message ?? ''));
}

/**
 * Open using the complete deployed runtime first. If that fails for a
 * non-password reason, retry the same PDF.js parser in text-only mode. Text
 * extraction does not render pages, so it does not require CMaps, standard
 * fonts, or WASM files; omitting those optional file URLs isolates production
 * parser startup from Vercel's filesystem packaging.
 *
 * @returns {Promise<{ doc: object, task: { destroy?: () => Promise<void> } }>}
 */
export async function openPdfjsDocumentForText(pdfjs, buf, assets) {
  const attempts = [
    documentOptions(Uint8Array.from(buf), assets),
    { ...documentOptions(Uint8Array.from(buf)), useWasm: false },
  ];
  let lastError;

  for (let index = 0; index < attempts.length; index += 1) {
    let task;
    try {
      task = pdfjs.getDocument(attempts[index]);
      const doc = await task.promise;
      return { doc, task };
    } catch (err) {
      try { await task?.destroy?.(); } catch {}
      if (isPasswordError(err) || index === attempts.length - 1) throw err;
      lastError = err;
    }
  }

  throw lastError;
}

export async function extractPdfTextWithPdfJs(buf) {
  if (!Buffer.isBuffer(buf)) refuse('INVALID_ARTIFACT', 'PDF input must be bytes');
  if (buf.length > MAX_ARTIFACT_BYTES) refuse('ARTIFACT_TOO_LARGE', `exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') refuse('UNSUPPORTED_ARTIFACT', 'not a PDF byte stream');

  await loadPdfjsNodeRuntime();
  const pdfjs = await importPdfjsAfterNodeRuntime();
  const assets = resolvePdfjsRuntimeAssets();

  if (typeof pdfjs?.getDocument !== 'function') unavailable('pdfjs_module', 'production PDF parser unavailable: pdfjs-dist getDocument export is missing');

  let doc;
  let task;
  try {
    ({ doc, task } = await openPdfjsDocumentForText(pdfjs, buf, assets));
  } catch (err) {
    if (isPasswordError(err)) refuse('ENCRYPTED_PDF', 'encrypted/password-protected PDFs are refused');
    safeStageFailure('document_open', 'document-open', err);
  }

  try {
    if (doc.numPages > MAX_PAGES) refuse('PDF_PAGE_LIMIT', `PDF has ${doc.numPages} pages; limit is ${MAX_PAGES}`);
    const pages = [];
    let totalBytes = 0;
    for (let n = 1; n <= doc.numPages; n += 1) {
      let page;
      try { page = await doc.getPage(n); }
      catch (err) { safeStageFailure('page_open', `page-${n}-open`, err); }
      try {
        const content = await page.getTextContent({ disableNormalization: false, includeMarkedContent: false });
        const text = normalizePage(content.items);
        if (text) { pages.push(text); totalBytes += Buffer.byteLength(text, 'utf8') + 2; }
        if (totalBytes > MAX_EXTRACTED_TEXT_BYTES) refuse('EXTRACTED_TEXT_TOO_LARGE', `extracted PDF text exceeds ${MAX_EXTRACTED_TEXT_BYTES} bytes`);
      } catch (err) { safeStageFailure('page_text', `page-${n}-text`, err); }
      finally { try { page?.cleanup(); } catch {} }
    }
    const text = pages.join('\n\n').trim();
    qualityCheck(text, doc.numPages);
    return text;
  } finally { try { await task?.destroy?.(); } catch {} }
}
