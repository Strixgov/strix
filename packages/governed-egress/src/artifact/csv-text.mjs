/**
 * CSV extraction — the first spreadsheet-shaped format, and the reason it
 * needs its own extractor rather than riding the plain-text path.
 *
 * THE LOAD-BEARING CONTROL IS THE SHAPE OF THE EXTRACTED TEXT. The detector
 * is label-seeded: it finds `Patient: Jane Doe`, `MRN: A12345`, `DOB: …`
 * because a label sits next to its value. In a CSV the label lives in the
 * HEADER row and the value sits columns and lines away, so raw CSV text
 * defeats exactly the rules that catch names and record numbers —
 *
 *     Patient Name,MRN            ← labels, nowhere near the values
 *     Jane Doe,A12345             ← neither value is detected
 *
 * (proven by test, not argued). So this extractor LINEARIZES: every data row
 * becomes a block of `Header: value` lines, which puts each label back beside
 * its value. The extracted text is the released artifact, so the model
 * receives the same linearized form the detector and the second-pass
 * verifier scanned — nothing is scanned in one shape and sent in another.
 *
 * FAIL CLOSED, NEVER PARTIAL. Every structural doubt is a named refusal, and
 * none of them emits a truncated or best-effort result, because a partially
 * parsed CSV would release unscanned-in-part content:
 *
 *   CSV_MALFORMED                 an unterminated quote, or a stray quote
 *                                 inside an unquoted field
 *   CSV_RAGGED_ROWS               a row whose field count differs from the
 *                                 header's (a shifted row puts values under
 *                                 the wrong label, so the linearized text
 *                                 would lie about what a value is)
 *   CSV_HEADER_INVALID            no header, an empty header cell, or a
 *                                 duplicate header (a label must name one
 *                                 column unambiguously)
 *   CSV_UNRECOGNIZED_NAME_COLUMN  a header naming a person-name field the
 *                                 detector has no label rule for ("First
 *                                 Name", "Guarantor Name"). Its values would
 *                                 pass the scan untouched, so the whole file
 *                                 is refused rather than released with a
 *                                 column of names in it
 *   ARTIFACT_TOO_LARGE            more rows, columns or cell characters than
 *                                 the bounds below — refused, never truncated
 *
 * THE DETECTOR'S CEILING STILL APPLIES, AND IT HAS CSV-SHAPED CASES. The name
 * rule needs at least two Capitalized words after the label, so a `Name`
 * column holding `jane doe` (lower-case) or `DOE, JANE` (last-comma-first)
 * is not caught — the same limit it has in a text file, now more likely
 * because exports favour those shapes. The name-column refusal above cannot
 * close this: the header IS one the detector labels; the VALUE is what it
 * misses. Stated here so the linearization is not read as a completeness
 * claim; the second pass reports NO_FINDINGS_BY_DETECTOR, never "no PHI".
 *
 * WHAT THIS DOES NOT DO. It does not evaluate formulas, infer types, or
 * interpret a leading `=`/`+`/`-`/`@` (the output is text for a model, never
 * a spreadsheet). And the ceiling is the detector's, unchanged: a clean scan
 * of the linearized text means NO_FINDINGS_BY_DETECTOR, not "no PHI".
 */

import { linearizeRows, validateHeader } from './table-linearize.mjs';

export const CSV_MAX_ROWS = 20_000;
export const CSV_MAX_COLUMNS = 200;
export const CSV_MAX_CELL_CHARS = 32_768;

/** Shared table codes mapped onto this format's public codes. */
const CSV_CODE = Object.freeze({
  TABLE_HEADER_INVALID: 'CSV_HEADER_INVALID',
  TABLE_UNRECOGNIZED_NAME_COLUMN: 'CSV_UNRECOGNIZED_NAME_COLUMN',
  TABLE_RAGGED_ROWS: 'CSV_RAGGED_ROWS',
  TABLE_NAME_VALUE_UNRECOGNIZED: 'CSV_NAME_VALUE_UNRECOGNIZED',
  TABLE_AMBIGUOUS_LAYOUT: 'CSV_AMBIGUOUS_LAYOUT',
});

function fail(code, message) {
  throw new CsvExtractionError(CSV_CODE[code] ?? code, message);
}

export class CsvExtractionError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'CsvExtractionError';
    this.reasonCode = reasonCode;
  }
}

/**
 * Strict RFC 4180 tokenizer. Accepts CRLF or LF row endings, quoted fields
 * with `""` escapes and embedded newlines. Anything else ambiguous refuses.
 * Returns rows as arrays of strings; a trailing newline does not add a row.
 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false; // inside a quoted field
  let fieldWasQuoted = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    if (field.length > CSV_MAX_CELL_CHARS) {
      throw new CsvExtractionError('ARTIFACT_TOO_LARGE', `a cell exceeds ${CSV_MAX_CELL_CHARS} characters`);
    }
    row.push(field);
    if (row.length > CSV_MAX_COLUMNS) {
      throw new CsvExtractionError('ARTIFACT_TOO_LARGE', `a row exceeds ${CSV_MAX_COLUMNS} columns`);
    }
    field = '';
    fieldWasQuoted = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    // Header + data rows; the bound is on DATA rows.
    if (rows.length > CSV_MAX_ROWS + 1) {
      throw new CsvExtractionError('ARTIFACT_TOO_LARGE', `more than ${CSV_MAX_ROWS} data rows`);
    }
  };

  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        const next = text[i];
        if (i < n && next !== ',' && next !== '\n' && next !== '\r') {
          throw new CsvExtractionError('CSV_MALFORMED', 'characters follow a closing quote');
        }
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (field.length > 0 || fieldWasQuoted) {
        throw new CsvExtractionError('CSV_MALFORMED', 'a quote appears inside an unquoted field');
      }
      quoted = true;
      fieldWasQuoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      pushRow();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (quoted) throw new CsvExtractionError('CSV_MALFORMED', 'a quoted field is never closed');
  // Final row unless the text ended exactly on a row terminator.
  if (field.length > 0 || row.length > 0 || fieldWasQuoted) pushRow();
  return rows;
}

/**
 * Parse, validate and linearize one CSV document.
 * @param {string} text  decoded UTF-8 text (BOM already stripped)
 * @returns {string} the linearized text that is scanned AND released
 */
export function extractCsvText(text) {
  if (typeof text !== 'string') throw new CsvExtractionError('CSV_MALFORMED', 'csv text must be a string');
  const rows = parseCsvRows(text);
  // A row that is a single empty field is a blank line; blank lines carry nothing.
  const nonBlank = rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (nonBlank.length === 0) throw new CsvExtractionError('EMPTY_ARTIFACT', 'csv has no rows');

  const [rawHeader, ...data] = nonBlank;
  const header = validateHeader(rawHeader, fail);
  if (data.length === 0) throw new CsvExtractionError('EMPTY_ARTIFACT', 'csv has a header and no data rows');
  const blocks = linearizeRows({ header, rows: data, fail, strictWidth: true });
  return blocks.join('\n\n') + '\n';
}
