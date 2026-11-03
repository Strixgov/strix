/**
 * Governed OCR — the ONLY path by which an image-only PDF may become text
 * that enters sensitive-data inspection.
 *
 * WHY THIS IS A GOVERNED STEP AND NOT A PARSER FALLBACK. A text layer is read;
 * OCR is GUESSED. Detection downstream is label-seeded and can only tokenize
 * what it finds, so an OCR misread of an identifier ("Jane D0e", "MRN 1Z3456")
 * is not a cosmetic defect — it is an identifier the rescan cannot see and the
 * release would carry out. So this module does not "try harder". It extends
 * the existing fail-closed contract: `OCR_REQUIRED` stays the answer unless an
 * engine that meets every rule below produced text, and every way that engine
 * can fall short is its own named refusal.
 *
 * THE RULES, each checked before the text is trusted:
 *
 *   1. LOCALITY. The engine must declare `locality: 'local-in-process'`
 *      EXACTLY. OCR runs on the RAW, uninspected document — every identifier
 *      still in it. Handing it to a cloud OCR service would disclose the whole
 *      record to a third party BEFORE the control this product exists to be
 *      had run. That is refused before a single byte is handed over
 *      (`OCR_ENGINE_NOT_LOCAL`), however the engine is otherwise configured.
 *   2. COVERAGE. The engine must return exactly one result per page, numbered
 *      1..N, where N is PDF.js's own page count — never the engine's claim.
 *      A dropped page is a page nobody inspected (`OCR_INCOMPLETE`).
 *   3. CONFIDENCE. Every word must meet the word floor and every page the
 *      page-mean floor (`OCR_LOW_CONFIDENCE`). Floors are STRICTER-ONLY: a
 *      caller may raise them, never lower them below the built-in values.
 *   4. SHAPE. A malformed result, a non-finite confidence, or an engine that
 *      throws is `OCR_FAILED` — never read as "no text".
 *   5. CONTENT. OCR output passes the same glyph check a text layer does
 *      (`EXTRACTION_UNRELIABLE`), and a scan that yields nothing is
 *      `OCR_NO_TEXT` — a blank result is not a clean one.
 *
 * WHAT THIS DOES NOT PROVE, stated on the record: that the OCR text is what
 * the page says. `proves: 'OCR_ENGINE_MET_POLICY_ONLY'` rides every success.
 * Release still requires human approval (the capability is HIGH, CRITICAL in
 * production), and `textSource: 'ocr'` travels with the artifact so a
 * reviewer knows the text was machine-read.
 *
 * DORMANT BY DEFAULT: with no engine injected, nothing here runs and an
 * image-only PDF refuses `OCR_REQUIRED` exactly as before.
 */
import { PdfExtractionError } from './pdf-text.mjs';
import { sha256Hex } from './hash.mjs';

export const OCR_LOCALITY = 'local-in-process';

/** Built-in floors. A caller may only raise these (stricter-only). */
export const OCR_WORD_CONFIDENCE_FLOOR = 0.8;
export const OCR_PAGE_MEAN_CONFIDENCE_FLOOR = 0.9;
/** OCR is expensive and slow; its page ceiling is below the text-layer one. */
export const OCR_MAX_PAGES = 50;

export const OCR_PROVES = 'OCR_ENGINE_MET_POLICY_ONLY';

/** Every refusal this module can raise. Closed, so the console can translate each. */
export const OCR_REFUSAL_CODES = Object.freeze([
  'OCR_ENGINE_NOT_LOCAL',
  'OCR_FAILED',
  'OCR_INCOMPLETE',
  'OCR_LOW_CONFIDENCE',
  'OCR_NO_TEXT',
  'OCR_PAGE_LIMIT',
]);

function refuse(code, message, stage) {
  throw new PdfExtractionError(code, message, { stage });
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Validate an engine descriptor WITHOUT calling it. Returns the normalized
 * identity; throws a named refusal otherwise. Exported so an operator surface
 * can ask "would this engine be accepted?" without handing it a document.
 */
export function assertGovernedOcrEngine(engine) {
  if (!engine || typeof engine !== 'object' || typeof engine.recognize !== 'function') {
    refuse('OCR_FAILED', 'OCR engine is not a valid engine (no recognize function)', 'ocr_engine');
  }
  if (engine.locality !== OCR_LOCALITY) {
    refuse('OCR_ENGINE_NOT_LOCAL', `OCR engine must run ${OCR_LOCALITY}; source documents never leave the host before inspection`, 'ocr_engine');
  }
  const id = typeof engine.id === 'string' && ID_RE.test(engine.id) ? engine.id : null;
  const version = typeof engine.version === 'string' && ID_RE.test(engine.version) ? engine.version : null;
  if (!id || !version) refuse('OCR_FAILED', 'OCR engine must declare an id and version', 'ocr_engine');
  return { id, version };
}

function resolveFloors(thresholds) {
  const word = Number(thresholds?.wordConfidenceFloor);
  const page = Number(thresholds?.pageMeanConfidenceFloor);
  return {
    // Stricter-only: an absent, non-finite, or LOWER value keeps the built-in floor.
    word: Number.isFinite(word) && word > OCR_WORD_CONFIDENCE_FLOOR && word <= 1 ? word : OCR_WORD_CONFIDENCE_FLOOR,
    page: Number.isFinite(page) && page > OCR_PAGE_MEAN_CONFIDENCE_FLOOR && page <= 1 ? page : OCR_PAGE_MEAN_CONFIDENCE_FLOOR,
  };
}

function isValidConfidence(c) {
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1;
}

function pageText(words) {
  const lines = new Map();
  for (const w of words) {
    const line = Number.isInteger(w.line) && w.line >= 0 ? w.line : 0;
    if (!lines.has(line)) lines.set(line, []);
    lines.get(line).push(w.text);
  }
  return [...lines.keys()].sort((a, b) => a - b).map((k) => lines.get(k).join(' ')).join('\n');
}

function glyphsReliable(text) {
  for (const c of text) {
    if (c === '�') return false;
    const n = c.codePointAt(0);
    if (n < 32 && c !== '\n' && c !== '\r' && c !== '\t') return false;
  }
  return true;
}

/**
 * Run governed OCR over an image-only PDF.
 *
 * @param {Buffer} bytes — the original PDF bytes
 * @param {{ pageCount: number, engine: object, thresholds?: object }} options
 *   `pageCount` MUST come from PDF.js (the parser that classified the document
 *   OCR_REQUIRED), never from the engine.
 * @returns {Promise<{ text: string, report: object }>}
 * @throws {PdfExtractionError} one of OCR_REFUSAL_CODES or EXTRACTION_UNRELIABLE
 */
export async function governedOcrExtract(bytes, { pageCount, engine, thresholds } = {}) {
  const identity = assertGovernedOcrEngine(engine);
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    refuse('OCR_INCOMPLETE', 'the parser page count is unknown, so OCR coverage cannot be established', 'ocr_page_coverage');
  }
  if (pageCount > OCR_MAX_PAGES) {
    refuse('OCR_PAGE_LIMIT', `PDF has ${pageCount} pages; the OCR limit is ${OCR_MAX_PAGES}`, null);
  }
  const floors = resolveFloors(thresholds);

  let result;
  try {
    result = await engine.recognize({ bytes, pageCount });
  } catch (err) {
    const name = String(err?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
    refuse('OCR_FAILED', `OCR engine failed (${name})`, 'ocr_engine');
  }

  const pages = result?.pages;
  if (!Array.isArray(pages)) refuse('OCR_FAILED', 'OCR engine returned no page list', 'ocr_engine');
  if (pages.length !== pageCount) {
    refuse('OCR_INCOMPLETE', `OCR returned ${pages.length} page(s) for a ${pageCount}-page document`, 'ocr_page_coverage');
  }

  let minWord = 1;
  let minPageMean = 1;
  let wordCount = 0;
  const texts = [];
  for (let i = 0; i < pageCount; i += 1) {
    const page = pages[i];
    if (!page || page.pageNumber !== i + 1 || !Array.isArray(page.words)) {
      refuse('OCR_INCOMPLETE', `OCR result for page ${i + 1} is missing or out of order`, 'ocr_page_coverage');
    }
    let sum = 0;
    for (const w of page.words) {
      if (!w || typeof w.text !== 'string' || !isValidConfidence(w.confidence)) {
        refuse('OCR_FAILED', `OCR returned a malformed word on page ${i + 1}`, 'ocr_engine');
      }
      if (w.confidence < floors.word) {
        refuse('OCR_LOW_CONFIDENCE', `a word on page ${i + 1} was read below the ${floors.word} confidence floor`, 'ocr_confidence');
      }
      if (w.confidence < minWord) minWord = w.confidence;
      sum += w.confidence;
    }
    const words = page.words.filter((w) => w.text.trim());
    if (words.length) {
      const mean = sum / page.words.length;
      if (mean < floors.page) {
        refuse('OCR_LOW_CONFIDENCE', `page ${i + 1} was read below the ${floors.page} mean confidence floor`, 'ocr_confidence');
      }
      if (mean < minPageMean) minPageMean = mean;
      wordCount += words.length;
      texts.push(pageText(words));
    }
  }

  const text = texts.join('\n\n').trim();
  if (!text) refuse('OCR_NO_TEXT', 'OCR produced no text; a blank result is not a clean one', null);
  if (!glyphsReliable(text)) refuse('EXTRACTION_UNRELIABLE', 'OCR text contains undecodable or control glyphs', 'ocr_engine');

  return {
    text,
    report: {
      engine: 'governed-ocr',
      mode: OCR_LOCALITY,
      textSource: 'ocr',
      ocrEngine: identity,
      pageCount,
      wordCount,
      minWordConfidence: minWord,
      minPageMeanConfidence: minPageMean,
      floors: { word: floors.word, pageMean: floors.page },
      extractedTextHash: sha256Hex(text),
      proves: OCR_PROVES,
    },
  };
}
