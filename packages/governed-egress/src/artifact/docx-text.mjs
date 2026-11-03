/**
 * DOCX extraction — the governed boundary for Word documents.
 *
 * WHAT IS SENT: the text of every body paragraph in document order, one line
 * per paragraph (a tab stays a tab, a break becomes a newline), and every
 * table linearized through the shared table module — because a Word table is
 * a table, and its header row sits away from its values exactly as in a
 * spreadsheet. The linearized text is what is scanned, verified and released.
 *
 * REBUILT 2026-09-24 on the shared OOXML container and scanner, after an
 * adversarial review found the original hand-rolled reader:
 *  - returned PARTIAL text when a tag or a ZIP entry was cut short (it
 *    stopped at the first unterminated tag and returned what it had),
 *  - passed hidden text (`w:vanish`) through to the release,
 *  - accepted a DOCTYPE and passed undeclared entities through undecoded,
 *  - read only the `w:` prefix, and
 *  - released tables as run-together cell text, labels away from values.
 * Each is now a named refusal or a structural rule, pinned by tests.
 *
 * THE CONTROLS:
 *  - HIDDEN TEXT IS REFUSED (DOCX_HIDDEN_CONTENT): `w:vanish` on a run, or in
 *    any style in `word/styles.xml`, hides text on screen that would still
 *    be released.
 *  - MACROS ARE REFUSED (DOCX_UNSUPPORTED_CONTENT): a .docm renamed .docx.
 *  - TABLES ARE HELD TO THE TABLE RULES (DOCX_HEADER_INVALID,
 *    DOCX_UNRECOGNIZED_NAME_COLUMN, DOCX_NAME_VALUE_UNRECOGNIZED,
 *    DOCX_RAGGED_ROWS, DOCX_AMBIGUOUS_TABLE).
 *  - `mc:Fallback` content is skipped: it is what an older reader would show
 *    instead of the `mc:Choice` content Word displays.
 *
 * NOT SENT, BY DESIGN: headers and footers, footnotes, comments, deleted
 * tracked-change text (`w:delText`), field codes (`w:instrText`), and
 * images. Omission is the safe direction for egress.
 *
 * Structure failures are DOCX_MALFORMED; bounds are ARTIFACT_TOO_LARGE; the
 * two historical outcomes (no `word/document.xml`, no text at all) keep their
 * UNSUPPORTED_ARTIFACT code. Never a partial result.
 */
import { hasMacros, openZipContainer, ZipContainerError } from './zip-container.mjs';
import { scanXml, OoxmlXmlError } from './ooxml-xml.mjs';
import { linearizeTable } from './table-linearize.mjs';

export const DOCX_MAX_TEXT_CHARS = 4_000_000;
export const DOCX_MAX_TABLE_CELLS = 200_000;

export class DocxExtractionError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'DocxExtractionError';
    this.reasonCode = reasonCode;
  }
}

const DOCX_CODE = Object.freeze({
  TABLE_HEADER_INVALID: 'DOCX_HEADER_INVALID',
  TABLE_UNRECOGNIZED_NAME_COLUMN: 'DOCX_UNRECOGNIZED_NAME_COLUMN',
  TABLE_RAGGED_ROWS: 'DOCX_RAGGED_ROWS',
  TABLE_NAME_VALUE_UNRECOGNIZED: 'DOCX_NAME_VALUE_UNRECOGNIZED',
  TABLE_AMBIGUOUS_LAYOUT: 'DOCX_AMBIGUOUS_TABLE',
});

function fail(code, message) {
  throw new DocxExtractionError(DOCX_CODE[code] ?? code, message);
}

function scan(xml, on) {
  try {
    scanXml(xml, on);
  } catch (err) {
    if (err instanceof OoxmlXmlError) fail('DOCX_MALFORMED', `document XML is malformed: ${err.message}`);
    throw err;
  }
}

const off = (v) => v === '0' || v === 'false' || v === 'off';

/** `w:vanish` present and not switched off. */
function isVanish(e) {
  return (e.name === 'vanish' || e.name === 'specVanish') && !off(String(e.attrs.val ?? '').trim().toLowerCase());
}

function assertNoHiddenStyles(zip) {
  const bytes = zip.read('word/styles.xml');
  if (bytes === null) return;
  scan(bytes.toString('utf8').replace(/^﻿/, ''), (e) => {
    if (e.type === 'open' && isVanish(e)) fail('DOCX_HIDDEN_CONTENT', 'a document style hides text');
  });
}

/**
 * Walk document.xml into an ordered list of items: { kind: 'line', text } or
 * { kind: 'table', rows }. A paragraph inside a table cell belongs to the
 * cell; a table nested in a paragraph (not valid Word, but seen) leaves the
 * surrounding paragraph's text intact.
 */
function parseDocument(xml) {
  const items = [];
  const paragraphs = []; // stack of { text, inCell }
  const tables = []; // stack of { rows, row, cell }
  let inText = false;
  // `w:tab` and `w:br` are text only inside a run: inside paragraph
  // properties `w:tab` is a tab-STOP definition, not a character.
  let runDepth = 0;
  let fallbackDepth = 0;
  let cells = 0;
  let sawRoot = false;

  const current = () => paragraphs[paragraphs.length - 1] ?? null;
  const table = () => tables[tables.length - 1] ?? null;

  scan(xml, (e) => {
    if (!sawRoot && e.type === 'open') {
      sawRoot = true;
      if (e.name !== 'document') fail('DOCX_MALFORMED', 'the main part is not a Word document');
    }
    if (e.type === 'open' && e.name === 'Fallback' && !e.selfClosing) {
      fallbackDepth += 1;
      return;
    }
    if (e.type === 'close' && e.name === 'Fallback') {
      fallbackDepth -= 1;
      return;
    }
    if (fallbackDepth > 0) return;

    if (e.type === 'open') {
      if (isVanish(e)) fail('DOCX_HIDDEN_CONTENT', 'the document has hidden text');
      switch (e.name) {
        case 'p': {
          const t = table();
          const para = { text: '', inCell: Boolean(t && t.cell) };
          if (e.selfClosing) finishParagraph(para);
          else paragraphs.push(para);
          break;
        }
        case 'r':
          if (!e.selfClosing) runDepth += 1;
          break;
        case 't':
          inText = !e.selfClosing && runDepth > 0;
          break;
        case 'tab':
          if (runDepth > 0 && current()) current().text += '\t';
          break;
        case 'br':
        case 'cr':
          if (runDepth > 0 && current()) current().text += '\n';
          break;
        case 'tbl':
          if (tables.length > 0) fail('DOCX_MALFORMED', 'a table is nested in a table');
          tables.push({ rows: [], row: null, cell: null });
          break;
        case 'tr':
          if (table()) table().row = [];
          break;
        case 'tc': {
          const t = table();
          if (t && t.row) {
            t.cell = [];
            if (e.selfClosing) {
              t.row.push('');
              t.cell = null;
            }
            cells += 1;
            if (cells > DOCX_MAX_TABLE_CELLS) fail('ARTIFACT_TOO_LARGE', 'the document has too many table cells');
          }
          break;
        }
        default:
          break;
      }
    } else if (e.type === 'close') {
      switch (e.name) {
        case 't':
          inText = false;
          break;
        case 'r':
          runDepth -= 1;
          break;
        case 'p': {
          const para = paragraphs.pop();
          if (para) finishParagraph(para);
          break;
        }
        case 'tc': {
          const t = table();
          if (t && t.row && t.cell) t.row.push(t.cell.join(' '));
          if (t) t.cell = null;
          break;
        }
        case 'tr': {
          const t = table();
          if (t && t.row) t.rows.push(t.row);
          if (t) t.row = null;
          break;
        }
        case 'tbl': {
          const t = tables.pop();
          if (t) items.push({ kind: 'table', rows: t.rows });
          break;
        }
        default:
          break;
      }
    } else if (e.type === 'text' && inText && current()) {
      current().text += e.text;
    }
  });

  function finishParagraph(para) {
    const t = table();
    if (para.inCell && t && t.cell) {
      const text = para.text.replace(/\s+/g, ' ').trim();
      if (text) t.cell.push(text);
    } else {
      items.push({ kind: 'line', text: para.text });
    }
  }

  return items;
}

/**
 * Extract a Word document's body text.
 * @param {Buffer} buf
 * @returns {string}
 * @throws {DocxExtractionError}
 */
export function extractDocxText(buf) {
  try {
    const zip = openZipContainer(buf);
    const xmlBuf = zip.read('word/document.xml');
    if (xmlBuf === null) {
      throw new DocxExtractionError('UNSUPPORTED_ARTIFACT', 'ZIP has no word/document.xml (not a DOCX)');
    }
    if (hasMacros(zip)) fail('DOCX_UNSUPPORTED_CONTENT', 'the document contains macros');
    assertNoHiddenStyles(zip);
    const items = parseDocument(xmlBuf.toString('utf8').replace(/^﻿/, ''));
    const lines = [];
    for (const item of items) {
      if (item.kind === 'line') lines.push(item.text);
      else lines.push(...linearizeTable(item.rows, fail, { rowLabel: 'Table row' }));
    }
    const text = lines.join('\n').trim();
    if (text.length > DOCX_MAX_TEXT_CHARS) fail('ARTIFACT_TOO_LARGE', 'the document text exceeds the bound');
    if (text.length === 0) {
      throw new DocxExtractionError('UNSUPPORTED_ARTIFACT', 'DOCX contains no extractable text');
    }
    return text;
  } catch (err) {
    if (err instanceof ZipContainerError) {
      throw new DocxExtractionError(err.reasonCode === 'ARTIFACT_TOO_LARGE' ? 'ARTIFACT_TOO_LARGE' : 'UNSUPPORTED_ARTIFACT', err.message);
    }
    throw err;
  }
}
