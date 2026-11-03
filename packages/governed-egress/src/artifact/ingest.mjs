/** Local ingestion — canonicalizes caller bytes before governed scanning. */
import { sha256Hex } from './hash.mjs';
import { extractProductionPdfText, PdfExtractionError } from './pdf-production-text.mjs';
import { extractDocxText, DocxExtractionError } from './docx-text.mjs';
import { extractCsvText, CsvExtractionError } from './csv-text.mjs';
import { extractXlsxText, XlsxExtractionError } from './xlsx-text.mjs';
import { extractPptxText, PptxExtractionError } from './pptx-text.mjs';
import { openZipContainer, ooxmlKind, ZipContainerError } from './zip-container.mjs';
import { isDetectorFieldLabel, isUnlabelableNameHeader } from './table-linearize.mjs';

/**
 * Characters that render as nothing (or reorder what renders) but split a
 * word for the detector: `Jane\u200BDoe` shows as "JaneDoe" and matches no
 * name rule. They are removed from EVERY extracted text before it is scanned,
 * so what is scanned is what is released — and what is released is what the
 * reader of the original saw. Remaining control characters become spaces.
 */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function normalizeExtractedText(text) {
  return text.replace(INVISIBLE, '').replace(CONTROL, ' ');
}

/**
 * Undeclared text that is plainly a table with identifier labels in its
 * first line is REFUSED rather than sent un-linearized. Raw CSV keeps its
 * labels in the header row, away from the values, so the label-seeded
 * detector finds nothing (proven: `Patient Name,MRN\nJane Doe,A12345` has
 * zero findings as plain text). This only ever refuses — it never picks an
 * extractor from content — so the "CSV must be declared" rule stands.
 */
function looksLikeUndeclaredTable(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 50);
  if (lines.length < 2) return false;
  for (const delim of [',', '\t', ';', '|']) {
    const cells = lines[0].split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (cells.length < 2 || cells.some((c) => c.length > 60)) continue;
    const width = lines[0].split(delim).length;
    const alike = lines.slice(1).filter((l) => l.split(delim).length === width).length;
    if (alike === 0) continue;
    if (cells.some((c) => isDetectorFieldLabel(c) || isUnlabelableNameHeader(c))) return true;
  }
  return false;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** The OOXML document kind each OOXML MIME type declares. */
const OOXML_KIND_FOR_MIME = Object.freeze({ [DOCX_MIME]: 'docx', [XLSX_MIME]: 'xlsx', [PPTX_MIME]: 'pptx' });

export const SUPPORTED_MIME_TYPES = Object.freeze([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/**
 * CSV must be DECLARED. Bytes that sniff as text are plain text unless the
 * caller says CSV, because the two are extracted differently (a CSV is
 * linearized into `Header: value` lines — csv-text.mjs) and guessing which
 * one a text file "really" is would let the choice of extractor depend on
 * content heuristics rather than on what the customer selected.
 */
const CSV_MIME_TYPES = new Set(['text/csv', 'application/csv']);

/**
 * A `.csv` filename declares CSV too, for bytes that sniff as text — and the
 * extension WINS over a generic text declaration. Both halves are the
 * fail-safe direction, and both came from how browsers actually label CSVs:
 *
 *  - a missing MIME type (common on mobile) would otherwise send a CSV down
 *    the plain-text path un-linearized, where the label-seeded detector
 *    cannot see its names and record numbers — the exact leak this format
 *    needs its own extractor to prevent;
 *  - Windows with Excel installed labels `.csv` as application/vnd.ms-excel,
 *    which would otherwise be refused as an unsupported spreadsheet.
 *
 * A real XLS is an OLE binary, sniffs as non-text, and is still refused, so
 * accepting that one MIME type here cannot admit a legacy spreadsheet.
 */
const CSV_COMPATIBLE_DECLARATIONS = new Set([undefined, '', 'text/plain', 'application/vnd.ms-excel']);

function isCsvSource(source, family) {
  if (family !== 'text') return false;
  if (CSV_MIME_TYPES.has(source.mimeType)) return true;
  const name = typeof source.filename === 'string' ? source.filename.trim().toLowerCase() : '';
  return name.endsWith('.csv') && CSV_COMPATIBLE_DECLARATIONS.has(source.mimeType);
}

export { MAX_ARTIFACT_BYTES } from './limits.mjs';
import { MAX_ARTIFACT_BYTES } from './limits.mjs';

function refusal(reasonCode, detail, originalHash) {
  return { ok: false, reasonCode, detail, ...(originalHash ? { originalHash } : {}) };
}

function sniff(buf) {
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return 'zip';
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return null;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  if (sample.length > 0 && control / sample.length > 0.02) return null;
  return 'text';
}

const FAMILY_FOR_MIME = Object.freeze({
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'zip',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'zip',
  'text/plain': 'text',
  'text/csv': 'text',
  'application/csv': 'text',
});

export function ingestArtifact(source) {
  if (source === null || typeof source !== 'object') return refusal('UNSUPPORTED_ARTIFACT', 'source must be an object');

  const result = ingestRaw(source);
  return result.ok ? { ...result, text: normalizeExtractedText(result.text) } : result;
}

function ingestRaw(source) {
  if (typeof source.text === 'string') {
    if (source.text.trim().length === 0) return refusal('EMPTY_ARTIFACT', 'pasted text is empty');
    const bytes = Buffer.from(source.text, 'utf8');
    if (bytes.length > MAX_ARTIFACT_BYTES) return refusal('ARTIFACT_TOO_LARGE', `exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    const originalHash = sha256Hex(bytes);
    // Pasted text may DECLARE itself CSV, and is then linearized exactly as an
    // uploaded CSV is. Any other declaration than plain text is refused.
    if (CSV_MIME_TYPES.has(source.mimeType)) {
      try {
        return { ok: true, text: extractCsvText(source.text), mimeType: 'text/csv', sizeBytes: bytes.length, originalHash };
      } catch (err) {
        if (err instanceof CsvExtractionError) return refusal(err.reasonCode, err.message, originalHash);
        return refusal('EXTRACTION_FAILED', 'CSV extraction failed', originalHash);
      }
    }
    if (source.mimeType !== undefined && source.mimeType !== 'text/plain') {
      return refusal('UNSUPPORTED_ARTIFACT', 'pasted text may be declared text/plain or text/csv only', originalHash);
    }
    const text = source.text.replace(/\r\n?/g, '\n');
    if (looksLikeUndeclaredTable(text)) {
      return refusal('TABULAR_TEXT_UNDECLARED', 'the text is a table with identifier labels in its first line; declare it as CSV', originalHash);
    }
    return { ok: true, text, mimeType: 'text/plain', sizeBytes: bytes.length, originalHash };
  }

  const bytes = source.bytes;
  if (!Buffer.isBuffer(bytes)) return refusal('UNSUPPORTED_ARTIFACT', 'source must carry `text` or `bytes`');
  if (bytes.length === 0) return refusal('EMPTY_ARTIFACT', 'artifact is zero bytes');
  if (bytes.length > MAX_ARTIFACT_BYTES) return refusal('ARTIFACT_TOO_LARGE', `exceeds ${MAX_ARTIFACT_BYTES} bytes`);

  // Hash the exact uploaded bytes before any parsing. Even an extraction
  // refusal can therefore be tied to the precise customer-selected file.
  const originalHash = sha256Hex(bytes);
  const family = sniff(bytes);
  if (family === null) return refusal('UNSUPPORTED_ARTIFACT', 'unrecognized or binary content', originalHash);

  const csv = isCsvSource(source, family);
  if (source.mimeType !== undefined && !csv) {
    // Own-property lookup: an inherited key ("constructor") names no family.
    const declaredFamily = Object.prototype.hasOwnProperty.call(FAMILY_FOR_MIME, source.mimeType)
      ? FAMILY_FOR_MIME[source.mimeType]
      : undefined;
    if (declaredFamily === undefined) return refusal('UNSUPPORTED_ARTIFACT', `declared mimeType ${source.mimeType} is not supported`, originalHash);
    if (declaredFamily !== family) return refusal('MIME_MISMATCH', `declared ${source.mimeType} but bytes sniff as ${family}`, originalHash);
  }

  try {
    if (family === 'pdf') {
      const text = extractProductionPdfText(bytes);
      return { ok: true, text, mimeType: 'application/pdf', sizeBytes: bytes.length, originalHash };
    }
    if (family === 'zip') {
      // Which OOXML document this is comes from the container's own parts,
      // never from the declared type alone: a workbook declared as DOCX (or
      // the reverse) is refused as a mismatch rather than handed to the
      // wrong extractor, which would read some parts and silently skip others.
      const kind = ooxmlKind(openZipContainer(bytes).names);
      if (kind === null) return refusal('UNSUPPORTED_ARTIFACT', 'not a supported Office document', originalHash);
      const declaredKind = Object.prototype.hasOwnProperty.call(OOXML_KIND_FOR_MIME, source.mimeType)
        ? OOXML_KIND_FOR_MIME[source.mimeType]
        : null;
      if (source.mimeType !== undefined && declaredKind !== kind) {
        return refusal('MIME_MISMATCH', `declared ${source.mimeType} but the container holds ${kind}`, originalHash);
      }
      if (kind === 'xlsx') {
        const text = extractXlsxText(bytes);
        return { ok: true, text, mimeType: XLSX_MIME, sizeBytes: bytes.length, originalHash };
      }
      if (kind === 'pptx') {
        const text = extractPptxText(bytes);
        return { ok: true, text, mimeType: PPTX_MIME, sizeBytes: bytes.length, originalHash };
      }
      if (kind !== 'docx') return refusal('UNSUPPORTED_ARTIFACT', `${kind} is not supported`, originalHash);
      const text = extractDocxText(bytes);
      return { ok: true, text, mimeType: DOCX_MIME, sizeBytes: bytes.length, originalHash };
    }
    const decoded = bytes.toString('utf8').replace(/^\uFEFF/, '');
    if (csv) {
      // Line endings are handled inside the CSV parser (CRLF is legal there
      // and a CR inside a quoted field is content), so the raw decode is passed.
      const text = extractCsvText(decoded);
      return { ok: true, text, mimeType: 'text/csv', sizeBytes: bytes.length, originalHash };
    }
    const text = decoded.replace(/\r\n?/g, '\n');
    if (text.trim().length === 0) return refusal('EMPTY_ARTIFACT', 'text artifact is empty', originalHash);
    if (looksLikeUndeclaredTable(text)) {
      return refusal('TABULAR_TEXT_UNDECLARED', 'the file is a table with identifier labels in its first line; upload it as .csv', originalHash);
    }
    return { ok: true, text, mimeType: 'text/plain', sizeBytes: bytes.length, originalHash };
  } catch (err) {
    if (
      err instanceof PdfExtractionError ||
      err instanceof DocxExtractionError ||
      err instanceof CsvExtractionError ||
      err instanceof XlsxExtractionError ||
      err instanceof PptxExtractionError ||
      err instanceof ZipContainerError
    ) {
      return refusal(err.reasonCode, err.message, originalHash);
    }
    return refusal('EXTRACTION_FAILED', `extraction threw: ${err?.message ?? 'unknown error'}`, originalHash);
  }
}
