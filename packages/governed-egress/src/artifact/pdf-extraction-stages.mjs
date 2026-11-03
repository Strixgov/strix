/**
 * The closed vocabulary of PDF extraction STAGES.
 *
 * WHY THIS FILE EXISTS. On 2026-09-16 the frozen PCR specimen refused with
 * `EXTRACTION_UNAVAILABLE` and nothing on any surface — response, log line,
 * refusal receipt, evidence entry — said WHICH substrate was missing. Four
 * different failures (the native canvas binding, the canvas globals PDF.js
 * reads at import, the PDF.js module itself, and its three runtime asset
 * directories) all collapsed into one code with a free-text `detail` that the
 * console route dropped before answering. The readiness probe that could have
 * named the stage existed and was referenced only by its own test.
 *
 * A stage is a CONTENT-FREE identifier of the mechanism that failed. It names
 * a library, a global, a directory — never a document, a filename, a page's
 * text, or a parser exception message. That is what makes it safe to carry on
 * the refusal receipt, which by design carries no free text (see
 * `evidence/refusal-receipt.mjs`), and safe to log at INFO.
 *
 * The set is CLOSED and the receipt builder refuses any value outside it, so a
 * future caller cannot smuggle prose into the `stage` slot.
 */

/** Substrate stages: the runtime the extractor needs BEFORE it opens a document. */
export const PDFJS_SUBSTRATE_STAGES = Object.freeze([
  /** `import('@napi-rs/canvas')` failed — native binding absent or unloadable. */
  'canvas_binding',
  /** canvas loaded but did not provide DOMMatrix/Path2D/ImageData. */
  'canvas_globals',
  /** `import('pdfjs-dist/legacy/build/pdf.mjs')` failed or lacks getDocument. */
  'pdfjs_module',
  /** pdfjs-dist package root could not be resolved for its asset directories. */
  'pdfjs_assets_root',
  /** `cmaps/` directory (built-in CMaps) missing from the deployed function. */
  'pdfjs_assets_cmaps',
  /** `standard_fonts/` directory missing from the deployed function. */
  'pdfjs_assets_fonts',
  /** `wasm/` directory (OpenJPEG / JBIG2 / QCMS decoders) missing. */
  'pdfjs_assets_wasm',
]);

/** Document stages: the extractor ran and failed while reading THIS document. */
export const PDF_DOCUMENT_STAGES = Object.freeze([
  'document_open',
  'page_open',
  'page_text',
]);

/**
 * Governed OCR stages (see `governed-ocr.mjs`): the OCR engine ran and fell
 * short of policy on this document. Mechanism names only — never a word the
 * engine read.
 */
export const OCR_STAGES = Object.freeze([
  'ocr_engine',
  'ocr_page_coverage',
  'ocr_confidence',
]);

export const PDF_EXTRACTION_STAGES = Object.freeze([
  ...PDFJS_SUBSTRATE_STAGES,
  ...PDF_DOCUMENT_STAGES,
  ...OCR_STAGES,
]);

const STAGE_SET = new Set(PDF_EXTRACTION_STAGES);

export function isPdfExtractionStage(value) {
  return typeof value === 'string' && STAGE_SET.has(value);
}

/**
 * Operator-facing meaning per stage. Mechanism only; no document content can
 * appear here because the table is static.
 */
export const PDF_EXTRACTION_STAGE_MEANING = Object.freeze({
  canvas_binding: 'the native @napi-rs/canvas binding could not be loaded in the deployed function',
  canvas_globals: '@napi-rs/canvas loaded but did not provide the DOMMatrix/Path2D/ImageData globals PDF.js requires',
  pdfjs_module: 'the pdfjs-dist module could not be imported or does not expose getDocument',
  pdfjs_assets_root: 'the pdfjs-dist package root could not be resolved, so no runtime asset directory is addressable',
  pdfjs_assets_cmaps: 'the pdfjs-dist cmaps/ directory is not present in the deployed function',
  pdfjs_assets_fonts: 'the pdfjs-dist standard_fonts/ directory is not present in the deployed function',
  pdfjs_assets_wasm: 'the pdfjs-dist wasm/ directory is not present in the deployed function',
  document_open: 'PDF.js could not open this document',
  page_open: 'PDF.js could not open a page of this document',
  page_text: 'PDF.js could not read the text content of a page of this document',
  ocr_engine: 'the governed OCR engine failed, returned a malformed result, or is not permitted to run on this host',
  ocr_page_coverage: 'governed OCR did not return exactly one result per page of this document',
  ocr_confidence: 'governed OCR read part of this document below the confidence floor',
});
