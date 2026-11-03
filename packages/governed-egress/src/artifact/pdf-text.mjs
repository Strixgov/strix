/**
 * Minimal PDF text extraction for the governed-egress ingestion boundary.
 *
 * Scope (deliberate, v0.1): PDFs with EXTRACTABLE text — plain or
 * FlateDecode content streams whose text is drawn with Tj / ' / TJ using
 * literal `(...)` or `<hex>` strings and simple (single-byte) encodings.
 * Everything else FAILS CLOSED with a named reason: encrypted PDFs, PDFs
 * with no text operators (scanned/image PDFs needing OCR), and PDFs whose
 * extraction output is unreliable garbage (CID/multibyte fonts).
 *
 * Why best-effort extraction is safe here at all: the RELEASED artifact is
 * the EXTRACTED TEXT, never the original PDF bytes. The bytes this module
 * returns are exactly the bytes the detector scans and exactly the bytes a
 * release authorization can bind — so under-extraction can lose utility,
 * but it can never leak un-scanned content, because un-extracted content
 * never enters the release path at all.
 */
import { inflateSync } from 'node:zlib';
import { MAX_INFLATED_BYTES } from './limits.mjs';

export class PdfExtractionError extends Error {
  /**
   * @param {string} reasonCode
   * @param {string} message
   * @param {{ stage?: string | null }} [meta] — `stage` is a member of
   *   `PDF_EXTRACTION_STAGES` (see `pdf-extraction-stages.mjs`) naming the
   *   MECHANISM that refused, or null when the refusal is about the document's
   *   content rather than a stage of the machinery. It is content-free by
   *   construction and is the one field of this error a refusal receipt may
   *   carry.
   */
  constructor(reasonCode, message, meta = {}) {
    super(message);
    this.name = 'PdfExtractionError';
    this.reasonCode = reasonCode;
    this.stage = typeof meta?.stage === 'string' ? meta.stage : null;
    // A page count is content-free (an integer) and is carried ONLY on
    // OCR_REQUIRED so governed OCR can check page coverage against the
    // parser's own count rather than the OCR engine's claim. Never persisted.
    this.pageCount = Number.isInteger(meta?.pageCount) && meta.pageCount >= 0 ? meta.pageCount : null;
  }
}

const MAX_STREAMS = 512;

/** Decode a PDF literal string body (already between parens) to text. */
function decodePdfLiteral(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (next === 'n') { out += '\n'; i += 1; continue; }
    if (next === 'r') { out += '\r'; i += 1; continue; }
    if (next === 't') { out += '\t'; i += 1; continue; }
    if (next === 'b') { out += '\b'; i += 1; continue; }
    if (next === 'f') { out += '\f'; i += 1; continue; }
    if (next === '(' || next === ')' || next === '\\') { out += next; i += 1; continue; }
    if (next >= '0' && next <= '7') {
      let oct = '';
      let j = i + 1;
      while (j < body.length && oct.length < 3 && body[j] >= '0' && body[j] <= '7') {
        oct += body[j];
        j += 1;
      }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      i = j - 1;
      continue;
    }
    // Backslash before anything else: PDF says ignore the backslash.
    out += next;
    i += 1;
  }
  return out;
}

/** Decode a PDF hex string body (between < >) to text (single-byte). */
function decodePdfHex(body) {
  const clean = body.replace(/[^0-9a-fA-F]/g, '');
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  let out = '';
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Extract text drawn inside BT ... ET blocks of one decoded content stream.
 * Text-positioning operators (Td, TD, T*, ') emit line breaks so labeled
 * fields ("MRN: 99218472") keep their line structure for the detector.
 */
function extractTextOps(stream) {
  const parts = [];
  const btRe = /\bBT\b([\s\S]*?)\bET\b/g;
  let bt;
  while ((bt = btRe.exec(stream)) !== null) {
    const block = bt[1];
    // Tokenize: literal strings, hex strings, and operators of interest.
    const tokenRe = /\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|\[|\]|\bTJ\b|\bTj\b|\bTd\b|\bTD\b|\bT\*\b|'/g;
    let sawTextOnLine = false;
    let pending = [];
    let tok;
    while ((tok = tokenRe.exec(block)) !== null) {
      const t = tok[0];
      if (t.startsWith('(')) {
        pending.push(decodePdfLiteral(t.slice(1, -1)));
      } else if (t.startsWith('<')) {
        pending.push(decodePdfHex(t.slice(1, -1)));
      } else if (t === 'Tj' || t === 'TJ' || t === "'") {
        if (t === "'" || t === 'TJ') {
          // ' moves to next line first; TJ arrays we join as-is.
          if (t === "'" && sawTextOnLine) parts.push('\n');
        }
        if (pending.length > 0) {
          parts.push(pending.join(''));
          pending = [];
          sawTextOnLine = true;
        }
      } else if (t === 'Td' || t === 'TD' || t === 'T*') {
        pending = [];
        if (sawTextOnLine) {
          parts.push('\n');
          sawTextOnLine = false;
        }
      }
      // '[' and ']' delimit TJ arrays; the strings inside are already
      // collected into `pending`, so the brackets themselves are ignored.
    }
    if (sawTextOnLine) parts.push('\n');
  }
  return parts.join('');
}

/** Ratio of printable characters in a string (extraction-reliability guard). */
function printableRatio(text) {
  if (text.length === 0) return 0;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127) || code >= 160) {
      printable += 1;
    }
  }
  return printable / text.length;
}

/**
 * Extract text from a PDF buffer, failing closed on anything this module
 * cannot confidently read.
 *
 * @param {Buffer} buf
 * @returns {string} extracted text
 * @throws {PdfExtractionError} ENCRYPTED_ARTIFACT | UNSUPPORTED_ARTIFACT | EXTRACTION_UNRELIABLE | ARTIFACT_TOO_LARGE
 */
export function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  if (!raw.startsWith('%PDF-')) {
    throw new PdfExtractionError('UNSUPPORTED_ARTIFACT', 'not a PDF header');
  }
  if (/\/Encrypt\b/.test(raw)) {
    // An encrypted PDF cannot be inspected, so it can never be released.
    throw new PdfExtractionError('ENCRYPTED_ARTIFACT', 'PDF declares /Encrypt');
  }

  const pieces = [];
  const streamRe = /<<([\s\S]{0,2048}?)>>\s*stream\r?\n/g;
  let m;
  let streamCount = 0;
  // TOTAL inflated budget across every stream in the artifact — a per-stream
  // cap alone would let MAX_STREAMS bombs multiply it back into a DoS.
  let inflatedRemaining = MAX_INFLATED_BYTES;
  while ((m = streamRe.exec(raw)) !== null) {
    streamCount += 1;
    if (streamCount > MAX_STREAMS) {
      throw new PdfExtractionError('UNSUPPORTED_ARTIFACT', 'too many streams');
    }
    const dict = m[1];
    const dataStart = m.index + m[0].length;
    const end = raw.indexOf('endstream', dataStart);
    if (end === -1) continue;
    let data = raw.slice(dataStart, end).replace(/\r?\n$/, '');
    if (/\/Subtype\s*\/Image\b/.test(dict)) continue; // image XObject — not text
    if (/\/Filter/.test(dict)) {
      if (!/\/FlateDecode\b/.test(dict)) continue; // unsupported filter — skip; no-text fails closed below
      if (inflatedRemaining <= 0) {
        // Budget exactly spent by earlier streams: zlib refuses
        // maxOutputLength 0 (ERR_OUT_OF_RANGE), so refuse here by name.
        throw new PdfExtractionError(
          'ARTIFACT_TOO_LARGE',
          `streams inflate beyond the ${MAX_INFLATED_BYTES}-byte total extraction bound (decompression-bomb posture: refuse)`,
        );
      }
      try {
        const inflated = inflateSync(Buffer.from(data, 'latin1'), { maxOutputLength: inflatedRemaining });
        inflatedRemaining -= inflated.length;
        data = inflated.toString('latin1');
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
          // A stream that blows the whole remaining budget is a
          // decompression bomb, not an "undecodable stream" — adversarial
          // input fails the ARTIFACT closed by name, never a silent skip
          // (a skip would launder a bomb into a parsing shrug).
          throw new PdfExtractionError(
            'ARTIFACT_TOO_LARGE',
            `stream inflates beyond the ${MAX_INFLATED_BYTES}-byte total extraction bound (decompression-bomb posture: refuse)`,
          );
        }
        continue; // undecodable stream — cannot contribute text
      }
    }
    if (data.includes('BT')) {
      pieces.push(extractTextOps(data));
    }
  }

  const text = pieces.join('').replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) {
    throw new PdfExtractionError(
      'UNSUPPORTED_ARTIFACT',
      'no extractable text operators found (scanned/image PDFs require OCR, which is out of scope for v0.1)',
    );
  }
  if (printableRatio(text) < 0.85) {
    throw new PdfExtractionError(
      'EXTRACTION_UNRELIABLE',
      'extracted text is not confidently readable (likely CID/multibyte encoding)',
    );
  }
  return text;
}
