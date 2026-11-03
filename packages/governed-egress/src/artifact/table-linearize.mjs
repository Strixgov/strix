/**
 * Table linearization — shared by every tabular format (CSV, XLSX, PPTX).
 *
 * The detector is label-seeded: it catches `Patient: Jane Doe` because the
 * label sits next to the value. A table keeps its labels in a header row,
 * away from the values, so every tabular extractor must put each label back
 * beside its value before anything is scanned. One module owns that rule so
 * the formats cannot disagree about which headers are acceptable or what
 * shape the released text takes.
 *
 * Refusals are raised through the caller's `fail(code, message)`, so each
 * format keeps its own error class while sharing one set of codes:
 *
 *   TABLE_HEADER_INVALID           empty, duplicate, or data-shaped header
 *   TABLE_UNRECOGNIZED_NAME_COLUMN a person column the detector cannot label
 *   TABLE_NAME_VALUE_UNRECOGNIZED  a value under a name label that the
 *                                  detector does not read as a whole name
 *   TABLE_AMBIGUOUS_LAYOUT         a data cell is itself a field label, so
 *                                  the table is not header-over-data and a
 *                                  header reading would mis-pair labels
 *   TABLE_RAGGED_ROWS              a row with a value under no header, or (when
 *                                  `strictWidth`) a row of the wrong width
 *
 * Callers map these onto their format's public codes (CSV_*, XLSX_*, PPTX_*).
 *
 * WHY the name-value rule exists (2026-09-24 review). The second-pass
 * verification re-runs the same detector, so a value the detector cannot
 * read is released with verification PASSED. Under a column the detector
 * itself treats as a name ("Patient", "Guarantor"), every non-empty value is
 * a person's name by construction; if the detector does not recognize the
 * WHOLE value as one, that is proof the detector would miss it, and the only
 * safe answer is to refuse. This fails closed on shapes the grammar does not
 * cover (a single-word name, an unusual script) instead of releasing them.
 */
import { NAME_LABELS, scanText } from '../detection/pattern-detector.mjs';

const DETECTOR_NAME_LABELS = new Set(NAME_LABELS);

/**
 * Words that make a header a PERSON column. A header containing one, that is
 * not exactly a detector name label, and that does not name an identifier
 * field ("Patient ID", "Member ID"), is refused: its values are people the
 * detector has no label for ("First Name", "Patient (Last, First)", "Client").
 */
const PERSON_WORD = /\b(?:name|names|first|last|surname|given|middle|maiden|patient|client|resident|spouse|parent|guarantor|subscriber|insured|beneficiary|guardian|dependent|dependant)\b/;
const IDENTIFIER_WORD = /\b(?:id|ids|number|no|num|#|mrn|dob|date|birth|account|status|type|phone|email|address|zip|code|plan|group|policy|count|total|amount|balance)\b/;

/** Lower-cased, separators as spaces, trailing label punctuation dropped. */
export function labelKey(h) {
  return normalizeHeader(h).toLowerCase().replace(/[_.]+/g, ' ').replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isDetectorNameLabel(header) {
  return DETECTOR_NAME_LABELS.has(labelKey(header));
}

/**
 * Separators are normalized to spaces BEFORE the word test: `_` is a regex
 * word character, so a bare `\bname\b` never matches `name_of_insured`.
 */
export function isUnlabelableNameHeader(header) {
  const key = labelKey(header).replace(/[()[\],/]+/g, ' ');
  if (DETECTOR_NAME_LABELS.has(labelKey(header))) return false;
  return PERSON_WORD.test(key) && !IDENTIFIER_WORD.test(key);
}

/**
 * Field labels the detector's LABELED rules recognize when written
 * `Label: value`. Used where a table's structure is ambiguous (a two-column
 * slide table can be key/value or header/data) to decide which reading puts
 * identifier labels beside their values. A test renders every entry as
 * `Label: <sample>` through the real detector, so this set cannot claim a
 * label the detector does not actually catch.
 */
export const DETECTOR_FIELD_LABELS = Object.freeze([
  ...NAME_LABELS,
  'dob',
  'date of birth',
  'mrn',
  'medical record number',
  'ssn',
  'social security number',
  'member id',
  'policy number',
  'insurance id',
  'subscriber id',
  'group number',
  'account number',
  'specimen id',
  'accession number',
  // Detector 0.3.0 — financial and tax identifiers.
  'routing number',
  'aba',
  'bank account',
  'bank account number',
  'checking account',
  'savings account',
  'acct',
  'iban',
  'ein',
  'tin',
  'tax id',
  'taxpayer id',
]);

export function isDetectorFieldLabel(cell) {
  return DETECTOR_FIELD_LABELS.includes(labelKey(cell));
}

/**
 * Role words are plausible DATA ("Role: Patient", "Party: Guarantor"), so a
 * data cell holding one says nothing about the table's shape. Every other
 * field label ("MRN", "DOB", "Patient Name") appearing as data means the
 * labels are in the body, not the header row.
 */
const ROLE_ONLY_LABELS = new Set(['patient', 'guarantor', 'subscriber', 'insured', 'beneficiary', 'guardian', 'responsible party']);

function isLayoutLabel(cell) {
  const key = labelKey(cell);
  return DETECTOR_FIELD_LABELS.includes(key) && !ROLE_ONLY_LABELS.has(key);
}

/**
 * Trim, collapse whitespace, and drop trailing label punctuation. A header
 * written `Patient:` would otherwise be emitted as `Patient:: Jane Doe`, and
 * the detector's rules allow exactly one separator — the value would pass
 * the scan unlabelled.
 */
export function normalizeHeader(h) {
  return String(h).trim().replace(/\s+/g, ' ').replace(/[\s:：\-–—]+$/u, '');
}

/**
 * The label as it is written into the released text. A header that IS a
 * detector field label is written with its separators as spaces
 * ("patient_name" → "patient name"), because the detector's label rules
 * match words, not `_` or `.`, and a recognized label emitted in a form the
 * detector cannot read would leave its value unlabelled.
 */
export function emittedLabel(h) {
  const n = normalizeHeader(h);
  return isDetectorFieldLabel(n) ? n.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim() : n;
}

/**
 * A header that looks like DATA rather than a label: a run of five or more
 * digits, or anything the detector flags on its own (a date, a phone number,
 * an email address). A headerless roster would otherwise make its
 * first record the labels ("A12345: B99999"), and a label is never scanned
 * as a value.
 */
function looksLikeData(h) {
  // Five digits, not four: "FY2026" and "Q3 2025" are ordinary labels.
  return /[0-9]{5,}/.test(h) || scanText(h).findings.length > 0;
}

/**
 * Validate a header row and return the normalized labels.
 * @param {string[]} rawHeader
 * @param {(code: string, message: string) => never} fail
 */
export function validateHeader(rawHeader, fail) {
  const header = rawHeader.map(emittedLabel);
  if (header.length === 0 || header.some((h) => h.length === 0)) {
    fail('TABLE_HEADER_INVALID', 'a header cell is empty');
  }
  const seen = new Set();
  for (const h of header) {
    const key = labelKey(h);
    if (seen.has(key)) fail('TABLE_HEADER_INVALID', 'a header is duplicated');
    seen.add(key);
  }
  for (const h of header) {
    if (looksLikeData(h)) fail('TABLE_HEADER_INVALID', 'a header cell looks like data, not a label');
  }
  for (const h of header) {
    if (isUnlabelableNameHeader(h)) {
      fail('TABLE_UNRECOGNIZED_NAME_COLUMN', 'a column names a person field the detector cannot label');
    }
  }
  return header;
}

function oneLine(value) {
  // Collapse embedded line breaks so each value stays on its label's line.
  return String(value ?? '').replace(/\r\n?|\n/g, ' ').trim();
}

/**
 * Emit `Label: value`, refusing a name value the detector would not read.
 * The check renders the exact line that will be released and scans it, so it
 * cannot disagree with what the pipeline scans afterwards.
 */
function labelledLine(label, value, fail) {
  const line = `${label}: ${value}`;
  if (value !== '' && isDetectorNameLabel(label)) {
    const found = scanText(line).findings.some((f) => f.category === 'PATIENT_NAME' && f.value === value);
    if (!found) {
      fail('TABLE_NAME_VALUE_UNRECOGNIZED', 'a value in a name column is not recognized as a whole name by the detector');
    }
  }
  return line;
}

/**
 * Linearize data rows under a validated header.
 *
 * @param {{
 *   header: string[],
 *   rows: string[][],
 *   fail: (code: string, message: string) => never,
 *   strictWidth: boolean,   // CSV: every row must match the header exactly.
 *                           // XLSX: trailing empty cells are simply absent.
 *   rowLabel?: string,      // prefix for each block, default "Row"
 * }} input
 * @returns {string[]} one block per data row
 */
export function linearizeRows({ header, rows, fail, strictWidth, rowLabel = 'Row' }) {
  const blocks = [];
  rows.forEach((r, index) => {
    const tooWide = r.length > header.length && r.slice(header.length).some((v) => v.trim() !== '');
    if ((strictWidth && r.length !== header.length) || tooWide) {
      // The row number is structure, not content; values are never named.
      fail('TABLE_RAGGED_ROWS', `data row ${index + 1} has ${r.length} fields; the header has ${header.length}`);
    }
    if (r.some((v) => oneLine(v) !== '' && isLayoutLabel(v))) {
      fail('TABLE_AMBIGUOUS_LAYOUT', `data row ${index + 1} contains a field label, so the table is not header-over-data`);
    }
    const lines = [`${rowLabel} ${index + 1}`];
    header.forEach((h, col) => {
      lines.push(labelledLine(h, oneLine(r[col]), fail));
    });
    blocks.push(lines.join('\n'));
  });
  return blocks;
}

/**
 * Linearize key/value pairs (a slide table read as `key | value`). Keys get
 * the same normalization and the same name-value rule as table headers.
 * @param {string[][]} pairs
 * @param {(code: string, message: string) => never} fail
 * @returns {string[]}
 */
export function linearizeKeyValue(pairs, fail) {
  return pairs.map((r) => labelledLine(emittedLabel(r[0] ?? ''), oneLine(r[1]), fail));
}

/**
 * Which reading a two-column table gets (a slide or document table). Exactly
 * ONE is emitted — emitting both puts each value in two label contexts, one
 * of which leaves it unlabeled, and the second-pass residual check then
 * (correctly) refuses the release. So the choice is made structurally, and
 * refused when it cannot be:
 *
 *   keyvalue   every key in column 1 is a field label the detector knows
 *              (`Patient | Jane Doe`, `MRN | A12345`)
 *   header     both row-1 cells are field labels (`Patient Name | MRN`), or
 *              no detector label appears in any key position at all (a
 *              `Claim | Status` table: nothing identifying can be mis-paired)
 *   unlabelable a person-name key the detector cannot label, refused by name
 *   ambiguous  anything else — a known label mixed with ordinary keys, where
 *              the wrong reading would leave a name or an ID with no label
 */
export function twoColumnReading(rows) {
  const keys = rows.map((r) => r[0] ?? '');
  if (keys.some((k) => isUnlabelableNameHeader(k.trim()))) return 'unlabelable';
  if (keys.every((k) => isDetectorFieldLabel(k))) return 'keyvalue';
  const [c0 = '', c1 = ''] = rows[0] ?? [];
  if (isDetectorFieldLabel(c0) && isDetectorFieldLabel(c1)) return 'header';
  if (!keys.some((k) => isDetectorFieldLabel(k)) && !isDetectorFieldLabel(c1)) return 'header';
  return 'ambiguous';
}

/**
 * Linearize one free-standing table (a slide table, a document table) whose
 * header position is not known in advance. Returns the lines to emit.
 * @param {string[][]} rawRows
 * @param {(code: string, message: string) => never} fail
 * @param {{ rowLabel?: string }} [options]
 * @returns {string[]}
 */
export function linearizeTable(rawRows, fail, { rowLabel = 'Table row' } = {}) {
  const rows = rawRows.filter((r) => r.some((v) => String(v).trim() !== ''));
  if (rows.length === 0) return [];
  if (rows.every((r) => r.length <= 2)) {
    const reading = twoColumnReading(rows);
    if (reading === 'unlabelable') {
      fail('TABLE_UNRECOGNIZED_NAME_COLUMN', 'a table row names a person-name field the detector cannot label');
    }
    if (reading === 'ambiguous') fail('TABLE_AMBIGUOUS_LAYOUT', 'a two-column table cannot be read unambiguously');
    if (reading === 'keyvalue') return linearizeKeyValue(rows, fail);
  }
  if (rows.length === 1) {
    // A one-row table has no header/data split. Joined as-is it would read
    // "Patient | Jane Doe | MRN | A12345", which no label rule matches, so a
    // row that holds any field label is refused.
    const cells = rows[0].map((c) => String(c).trim());
    if (cells.some((c) => isUnlabelableNameHeader(c))) {
      fail('TABLE_UNRECOGNIZED_NAME_COLUMN', 'a table row names a person field the detector cannot label');
    }
    if (cells.some((c) => isDetectorFieldLabel(c))) {
      fail('TABLE_AMBIGUOUS_LAYOUT', 'a one-row table holds a field label and cannot be read unambiguously');
    }
    return [cells.join(' | ')];
  }
  const [rawHeader, ...data] = rows;
  const header = validateHeader(rawHeader, fail);
  return linearizeRows({ header, rows: data, fail, strictWidth: false, rowLabel });
}
