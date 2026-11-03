/**
 * XLSX extraction — the governed boundary for Excel workbooks.
 *
 * A workbook is a table like a CSV, so it is LINEARIZED the same way and
 * through the same module (table-linearize.mjs): every data row becomes
 * `Header: value` lines, because the detector is label-seeded and a header
 * row far from its values hides exactly the identifiers the label rules
 * catch. The linearized text is what is scanned, verified and released.
 *
 * WHAT MAKES XLSX DIFFERENT FROM CSV, AND THE CONTROL FOR EACH:
 *
 *  - DATES ARE NUMBERS. Excel stores 01/02/1980 as the serial 29222 and
 *    shows it as a date only because of the cell's STYLE. Sent raw, a date of
 *    birth becomes `DOB: 29222`, which no date rule matches. Every numeric
 *    cell whose number format is a date is converted back to MM/DD/YYYY
 *    (honouring the workbook's 1904 flag and Excel's 1900 leap-year bug), and
 *    `t="d"` ISO dates are rewritten the same way, so the detector sees the
 *    date it would see in a text file.
 *  - DIGIT TEMPLATES. An SSN or phone stored as a number with a format such
 *    as `000-00-0000` is shown with dashes and stored without them; the
 *    pattern rules need the separators. Pure digit templates (0, # and
 *    literal separators) are applied. Anything richer is left as the raw
 *    number — stated as a limit, not a claim.
 *  - HIDDEN CONTENT IS REFUSED (XLSX_HIDDEN_CONTENT). A hidden or
 *    very-hidden sheet, a hidden row or column, or a sheet whose rows are
 *    hidden by default would be released without the person releasing it
 *    ever having seen it. The approver reviews what is sent; content they
 *    cannot see is refused rather than sent or silently dropped.
 *  - FORMULAS SEND THEIR CACHED VALUE, NEVER THE FORMULA. The value is what
 *    the person saw. A formula cell with no cached value cannot be evaluated
 *    here and is refused (XLSX_FORMULA_UNCACHED) rather than sent empty.
 *  - MACROS AND UNKNOWN SHEET TYPES ARE REFUSED (XLSX_UNSUPPORTED_CONTENT):
 *    a `vbaProject.bin` part (an .xlsm renamed .xlsx), or a sheet type other
 *    than a worksheet or chart sheet.
 *
 * NOT SENT, BY DESIGN: sheet names (a tab can be named after a patient and
 * no label rule covers it — sheets are numbered instead), comments and notes, headers and footers, charts,
 * drawings and text boxes, pivot caches, embedded objects, defined names.
 * Omission is the safe direction for egress — nothing unscanned leaves — but
 * it means the model sees only cell values.
 *
 * Structure failures (malformed XML, a missing part, a duplicate cell) are
 * XLSX_MALFORMED; bounds are ARTIFACT_TOO_LARGE; never a partial result.
 */
import { hasMacros, openZipContainer, ZipContainerError } from './zip-container.mjs';
import { scanXml, OoxmlXmlError } from './ooxml-xml.mjs';
import { linearizeRows, validateHeader } from './table-linearize.mjs';

export const XLSX_MAX_SHEETS = 50;
export const XLSX_MAX_ROWS_PER_SHEET = 20_000;
export const XLSX_MAX_COLUMNS = 200;
export const XLSX_MAX_CELL_CHARS = 32_768;
export const XLSX_MAX_SHARED_STRINGS = 500_000;

export class XlsxExtractionError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'XlsxExtractionError';
    this.reasonCode = reasonCode;
  }
}

const XLSX_CODE = Object.freeze({
  TABLE_HEADER_INVALID: 'XLSX_HEADER_INVALID',
  TABLE_UNRECOGNIZED_NAME_COLUMN: 'XLSX_UNRECOGNIZED_NAME_COLUMN',
  TABLE_RAGGED_ROWS: 'XLSX_RAGGED_ROWS',
  TABLE_NAME_VALUE_UNRECOGNIZED: 'XLSX_NAME_VALUE_UNRECOGNIZED',
  TABLE_AMBIGUOUS_LAYOUT: 'XLSX_AMBIGUOUS_LAYOUT',
});

function fail(code, message) {
  throw new XlsxExtractionError(XLSX_CODE[code] ?? code, message);
}

function readXml(zip, name, { required }) {
  const bytes = zip.read(name);
  if (bytes === null) {
    // The part name comes from the file's own relationships and could be
    // anything, so it is never echoed into the refusal.
    if (required) fail('XLSX_MALFORMED', 'a required workbook part is missing');
    return null;
  }
  return bytes.toString('utf8').replace(/^﻿/, '');
}

function scan(xml, on) {
  try {
    scanXml(xml, on);
  } catch (err) {
    if (err instanceof OoxmlXmlError) fail('XLSX_MALFORMED', `workbook XML is malformed: ${err.message}`);
    throw err;
  }
}

// ── Number formats ────────────────────────────────────────────────────────

const BUILTIN_DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
// 18–21 and 45–47 are time-only; a time alone is not a calendar date.
const BUILTIN_TIME_ONLY_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);

/** Strip the parts of a format code that are not date/time tokens. */
function formatTokens(code) {
  return code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/_./g, '')
    .replace(/\*./g, '');
}

/**
 * Split a format code into sections on `;` outside quotes and brackets, and
 * reduce each to { condition, template } where the template has its escapes
 * (`\-`) and quoted literals (`"-"`) resolved to plain characters.
 */
export function parseFormatSections(code) {
  const sections = [];
  let current = '';
  let condition = null;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      if (end === -1) return null;
      current += code.slice(i + 1, end);
      i = end;
    } else if (ch === '\\') {
      current += code[i + 1] ?? '';
      i += 1;
    } else if (ch === '[') {
      const end = code.indexOf(']', i + 1);
      if (end === -1) return null;
      const inner = code.slice(i + 1, end);
      const m = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(inner);
      if (m) condition = { op: m[1], num: Number(m[2]) };
      else current += `[${inner}]`;
      i = end;
    } else if (ch === ';') {
      sections.push({ condition, template: current });
      current = '';
      condition = null;
    } else {
      current += ch;
    }
  }
  sections.push({ condition, template: current });
  return sections;
}

const DIGIT_TEMPLATE = /^[0#\-() ]+$/;

/** 'date' | 'digits' | 'hides' | null for one format code. */
export function classifyFormatCode(code) {
  const raw = code.split(';');
  // Elapsed-time tokens ([h]:mm, [mm]:ss) are durations, not calendar dates.
  if (/\[(?:h+|m+|s+)\]/i.test(raw[0])) return null;
  const t = formatTokens(raw[0]);
  if (/[dy]/i.test(t)) return 'date';
  // `m` alone (no h/s) is month; beside h or s it is minutes.
  if (/m/i.test(t) && !/[hs]/i.test(t)) return 'date';
  const sections = parseFormatSections(code);
  if (!sections) return null;
  // `;;;` (every section empty) displays nothing at all: a value under it is
  // content the person releasing the workbook never saw.
  if (sections.length > 1 && sections.every((sct) => sct.template.trim() === '')) return 'hides';
  // Every non-empty section must be a pure digit template. No `.` among the
  // separators: `0.00` is a decimal format, and applying it as a template
  // would turn the integer 5 into 0.05.
  const used = sections.filter((sct) => sct.template !== '');
  if (
    used.length > 0 &&
    used.every((sct) => DIGIT_TEMPLATE.test(sct.template) && /[0#]/.test(sct.template)) &&
    used.some((sct) => /[-() ]/.test(sct.template))
  ) {
    return 'digits';
  }
  return null;
}

function conditionHolds(cond, n) {
  switch (cond.op) {
    case '<': return n < cond.num;
    case '<=': return n <= cond.num;
    case '>': return n > cond.num;
    case '>=': return n >= cond.num;
    case '=': return n === cond.num;
    case '<>': return n !== cond.num;
    default: return false;
  }
}

/**
 * Apply a (possibly conditional, multi-section) digit format to a whole,
 * non-negative number. Excel's built-in Phone Number format is
 * `[<=9999999]###-####;(###) ###-####`: the first section is chosen for a
 * seven-digit number and the second for a ten-digit one.
 */
export function applyDigitFormat(code, value) {
  if (!/^\d+$/.test(value)) return value;
  const sections = parseFormatSections(code);
  if (!sections) return value;
  const n = Number(value);
  let chosen;
  if (sections.some((sct) => sct.condition)) {
    chosen = sections.find((sct) => sct.condition && conditionHolds(sct.condition, n)) ?? sections.find((sct) => !sct.condition);
  } else {
    chosen = sections[0];
  }
  if (!chosen || chosen.template === '') return value;
  return applyDigitTemplate(chosen.template, value);
}

function parseStyles(xml) {
  const custom = new Map();
  const xfFormats = [];
  if (xml === null) return { dateStyles: new Set(), digitStyles: new Map(), hidingStyles: new Set() };
  let inCellXfs = false;
  scan(xml, (e) => {
    if (e.type === 'open' && e.name === 'numFmt') custom.set(Number(e.attrs.numFmtId), e.attrs.formatCode ?? '');
    if (e.type === 'open' && e.name === 'cellXfs') inCellXfs = !e.selfClosing;
    if (e.type === 'close' && e.name === 'cellXfs') inCellXfs = false;
    if (inCellXfs && e.type === 'open' && e.name === 'xf') xfFormats.push(Number(e.attrs.numFmtId ?? 0));
  });
  const dateStyles = new Set();
  const digitStyles = new Map();
  const hidingStyles = new Set();
  xfFormats.forEach((id, index) => {
    if (custom.has(id)) {
      const kind = classifyFormatCode(custom.get(id));
      if (kind === 'date') dateStyles.add(index);
      if (kind === 'digits') digitStyles.set(index, custom.get(id));
      if (kind === 'hides') hidingStyles.add(index);
    } else if (BUILTIN_DATE_FORMAT_IDS.has(id) && !BUILTIN_TIME_ONLY_IDS.has(id)) {
      dateStyles.add(index);
    }
  });
  return { dateStyles, digitStyles, hidingStyles };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Excel serial → MM/DD/YYYY. Returns null for a non-date value. */
export function serialToDate(serial, date1904) {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const whole = Math.floor(serial);
  let ms;
  if (date1904) {
    ms = Date.UTC(1904, 0, 1) + whole * 86_400_000;
  } else {
    // Excel counts a fictitious 1900-02-29 (serial 60). Serials after it are
    // one day ahead of the real calendar.
    const adjusted = whole > 60 ? whole - 1 : whole;
    ms = Date.UTC(1899, 11, 31) + adjusted * 86_400_000;
  }
  const d = new Date(ms);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

/**
 * Apply a pure digit template (`000-00-0000`, `(###) ###-####`) to a whole
 * number. Digits fill the slots from the right; an unfilled `0` slot shows a
 * zero and an unfilled `#` slot shows nothing, as Excel does.
 */
export function applyDigitTemplate(template, value) {
  if (!/^-?\d+$/.test(value) || value.startsWith('-')) return value;
  const slots = (template.match(/[0#]/g) ?? []).length;
  if (value.length > slots) return value;
  let k = value.length - 1;
  let out = '';
  for (let i = template.length - 1; i >= 0; i -= 1) {
    const ch = template[i];
    if (ch === '0' || ch === '#') {
      out = (k >= 0 ? value[k] : ch === '0' ? '0' : '') + out;
      k -= 1;
    } else {
      out = ch + out;
    }
  }
  return out;
}

function isoToDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : value;
}

// ── Workbook structure ────────────────────────────────────────────────────


function resolveTarget(target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `xl/${target}`.split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function parseWorkbook(zip) {
  const workbook = readXml(zip, 'xl/workbook.xml', { required: true });
  const rels = readXml(zip, 'xl/_rels/workbook.xml.rels', { required: true });
  const targets = new Map();
  scan(rels, (e) => {
    if (e.type === 'open' && e.name === 'Relationship') {
      targets.set(e.attrs.Id, { target: resolveTarget(e.attrs.Target ?? ''), type: String(e.attrs.Type ?? '') });
    }
  });
  let date1904 = false;
  const sheets = [];
  scan(workbook, (e) => {
    if (e.type !== 'open') return;
    if (e.name === 'workbookPr') date1904 = e.attrs.date1904 === '1' || e.attrs.date1904 === 'true';
    if (e.name === 'sheet') {
      sheets.push({ name: e.attrs.name ?? '', state: e.attrs.state ?? 'visible', rid: e.attrs['r:id'] ?? e.attrs.id });
    }
  });
  // Styles and shared strings are found the way Excel finds them: through
  // the workbook's relationships. A workbook whose styles part is not at the
  // conventional path used to be read with NO date styles, so a date of
  // birth went out as a bare serial number the date rules cannot see.
  const partOfType = (suffix, fallback) => {
    const found = [...targets.values()].filter((r) => r.type.endsWith(suffix));
    if (found.length > 1) fail('XLSX_MALFORMED', 'the workbook declares a part twice');
    return found.length === 1 ? found[0].target : fallback;
  };
  const stylesPart = partOfType('/styles', 'xl/styles.xml');
  const sharedStringsPart = partOfType('/sharedStrings', 'xl/sharedStrings.xml');
  if (sheets.length === 0) fail('XLSX_MALFORMED', 'workbook lists no sheets');
  if (sheets.length > XLSX_MAX_SHEETS) fail('ARTIFACT_TOO_LARGE', `more than ${XLSX_MAX_SHEETS} sheets`);
  return {
    date1904,
    stylesPart,
    sharedStringsPart,
    sheets: sheets.map((s) => {
      if (s.state !== 'visible') fail('XLSX_HIDDEN_CONTENT', 'the workbook has a hidden sheet');
      const rel = targets.get(s.rid);
      if (!rel) fail('XLSX_MALFORMED', 'a sheet has no relationship target');
      let kind;
      if (/\/worksheet$/.test(rel.type)) kind = 'worksheet';
      else if (/\/chartsheet$/.test(rel.type)) kind = 'chartsheet';
      else fail('XLSX_UNSUPPORTED_CONTENT', 'the workbook has a sheet type other than a worksheet');
      return { name: s.name, part: rel.target, kind };
    }),
  };
}

function parseSharedStrings(xml) {
  const strings = [];
  if (xml === null) return strings;
  let current = null;
  let inText = false;
  let phonetic = 0;
  scan(xml, (e) => {
    if (e.type === 'open' && e.name === 'si') current = '';
    else if (e.type === 'close' && e.name === 'si') {
      strings.push(current ?? '');
      if (strings.length > XLSX_MAX_SHARED_STRINGS) fail('ARTIFACT_TOO_LARGE', 'too many shared strings');
      current = null;
    } else if (e.type === 'open' && e.name === 'rPh') {
      if (!e.selfClosing) phonetic += 1;
    } else if (e.type === 'close' && e.name === 'rPh') phonetic -= 1;
    else if (e.type === 'open' && e.name === 't') inText = !e.selfClosing;
    else if (e.type === 'close' && e.name === 't') inText = false;
    else if (e.type === 'text' && inText && current !== null && phonetic === 0) current += e.text;
  });
  return strings;
}

/** "BC12" → { col: 54, row: 12 } (0-based column). */
function parseRef(ref) {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(ref ?? '');
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

function parseWorksheet(xml, ctx) {
  const rows = new Map(); // row number → Map(col → value)
  let rowNum = 0;
  let cell = null; // { col, type, style, value, inline, hasFormula }
  let colCursor = 0;
  let textTarget = null; // 'v' | 't'
  let inlinePhonetic = 0;
  const record = () => {
    if (!cell) return;
    let value;
    if (cell.value === null && cell.type !== 'inlineStr') {
      // Checked first: `Number(null)` is 0, so a shared-string cell with no
      // <v> would otherwise silently read string 0.
      if (cell.hasFormula) fail('XLSX_FORMULA_UNCACHED', 'a formula cell has no cached value');
      if (cell.type === 's') fail('XLSX_MALFORMED', 'a shared-string cell has no index');
      value = '';
    } else if (cell.type === 's') {
      const idx = Number(cell.value);
      if (!Number.isInteger(idx) || idx < 0 || idx >= ctx.strings.length) fail('XLSX_MALFORMED', 'a cell references a missing shared string');
      value = ctx.strings[idx];
    } else if (cell.type === 'inlineStr') {
      value = cell.inline;
    } else if (cell.type === 'b') {
      value = cell.value === '1' ? 'TRUE' : 'FALSE';
    } else if (cell.type === 'd') {
      value = isoToDate(cell.value);
    } else if (cell.type === 'str' || cell.type === 'e') {
      value = cell.value;
    } else {
      const n = Number(cell.value);
      if (ctx.styles.dateStyles.has(cell.style)) value = serialToDate(n, ctx.date1904) ?? cell.value;
      else if (ctx.styles.digitStyles.has(cell.style)) value = applyDigitFormat(ctx.styles.digitStyles.get(cell.style), cell.value);
      else value = cell.value;
    }
    if (value !== '' && ctx.styles.hidingStyles.has(cell.style)) {
      fail('XLSX_HIDDEN_CONTENT', 'a cell value is hidden by its number format');
    }
    if (value.length > XLSX_MAX_CELL_CHARS) fail('ARTIFACT_TOO_LARGE', `a cell exceeds ${XLSX_MAX_CELL_CHARS} characters`);
    const row = rows.get(rowNum) ?? new Map();
    if (row.has(cell.col)) fail('XLSX_MALFORMED', 'two cells share one reference');
    if (value !== '') row.set(cell.col, value);
    rows.set(rowNum, row);
    cell = null;
  };

  scan(xml, (e) => {
    if (e.type === 'open') {
      switch (e.name) {
        case 'sheetFormatPr':
          if (e.attrs.zeroHeight === '1' || e.attrs.zeroHeight === 'true') fail('XLSX_HIDDEN_CONTENT', 'rows are hidden by default');
          break;
        case 'col':
          if (e.attrs.hidden === '1' || e.attrs.hidden === 'true') fail('XLSX_HIDDEN_CONTENT', 'the sheet has a hidden column');
          // A zero-width column is hidden in everything but name.
          if (e.attrs.width !== undefined && Number(e.attrs.width) === 0) fail('XLSX_HIDDEN_CONTENT', 'the sheet has a zero-width column');
          break;
        case 'row': {
          if (e.attrs.hidden === '1' || e.attrs.hidden === 'true') fail('XLSX_HIDDEN_CONTENT', 'the sheet has a hidden row');
          if (e.attrs.ht !== undefined && Number(e.attrs.ht) === 0) fail('XLSX_HIDDEN_CONTENT', 'the sheet has a zero-height row');
          rowNum = e.attrs.r ? Number(e.attrs.r) : rowNum + 1;
          if (!Number.isInteger(rowNum) || rowNum < 1) fail('XLSX_MALFORMED', 'a row has an invalid number');
          colCursor = 0;
          if (rows.size >= XLSX_MAX_ROWS_PER_SHEET + 1 && !rows.has(rowNum)) fail('ARTIFACT_TOO_LARGE', `more than ${XLSX_MAX_ROWS_PER_SHEET} rows`);
          break;
        }
        case 'c': {
          const ref = e.attrs.r ? parseRef(e.attrs.r) : { col: colCursor, row: rowNum };
          if (!ref) fail('XLSX_MALFORMED', 'a cell has an invalid reference');
          // A cell whose reference names another row is placed differently by
          // different readers; refuse rather than pick one.
          if (ref.row !== rowNum) fail('XLSX_MALFORMED', 'a cell reference does not match its row');
          if (ref.col >= XLSX_MAX_COLUMNS) fail('ARTIFACT_TOO_LARGE', `a row exceeds ${XLSX_MAX_COLUMNS} columns`);
          colCursor = ref.col + 1;
          cell = { col: ref.col, type: e.attrs.t ?? 'n', style: Number(e.attrs.s ?? 0), value: null, inline: '', hasFormula: false };
          if (e.selfClosing) record();
          break;
        }
        case 'f':
          if (cell) cell.hasFormula = true;
          break;
        case 'v':
          textTarget = e.selfClosing ? null : 'v';
          if (cell && !e.selfClosing) cell.value = '';
          break;
        case 't':
          if (cell && cell.type === 'inlineStr' && inlinePhonetic === 0) textTarget = e.selfClosing ? null : 't';
          break;
        case 'rPh':
          // Phonetic guide text is excluded, as it is for shared strings.
          if (!e.selfClosing) inlinePhonetic += 1;
          break;
        default:
          break;
      }
    } else if (e.type === 'close') {
      if (e.name === 'c') record();
      else if (e.name === 'v' || e.name === 't') textTarget = null;
      else if (e.name === 'rPh') inlinePhonetic -= 1;
    } else if (e.type === 'text' && cell) {
      if (textTarget === 'v') cell.value += e.text;
      else if (textTarget === 't') cell.inline += e.text;
    }
  });

  // Dense row arrays in sheet order, empty rows dropped.
  const ordered = [...rows.keys()].sort((a, b) => a - b).map((r) => rows.get(r)).filter((m) => m.size > 0);
  return ordered.map((m) => {
    const width = Math.max(...m.keys()) + 1;
    return Array.from({ length: width }, (_, i) => m.get(i) ?? '');
  });
}

/**
 * Extract and linearize a workbook.
 * @param {Buffer} bytes
 * @returns {string}
 */
export function extractXlsxText(bytes) {
  let zip;
  try {
    zip = openZipContainer(bytes);
    if (hasMacros(zip)) fail('XLSX_UNSUPPORTED_CONTENT', 'the workbook contains macros');
    const { date1904, sheets, stylesPart, sharedStringsPart } = parseWorkbook(zip);
    const styles = parseStyles(readXml(zip, stylesPart, { required: false }));
    const strings = parseSharedStrings(readXml(zip, sharedStringsPart, { required: false }));

    const sections = [];
    let ordinal = 0;
    for (const sheet of sheets) {
      if (sheet.kind === 'chartsheet') continue; // a chart holds no cell data of its own
      const xml = readXml(zip, sheet.part, { required: true });
      const rows = parseWorksheet(xml, { strings, styles, date1904 });
      if (rows.length === 0) continue;
      const [rawHeader, ...data] = rows;
      const header = validateHeader(rawHeader, fail);
      if (data.length === 0) continue;
      const blocks = linearizeRows({ header, rows: data, fail, strictWidth: false });
      // The sheet's NAME is not sent. A tab can be named after a patient, and
      // a name on a `Sheet:` line has no label the detector recognizes — so
      // it is replaced by its position rather than scanned and hoped for.
      ordinal += 1;
      sections.push([`Sheet ${ordinal}`, ...blocks].join('\n\n'));
    }
    if (sections.length === 0) fail('EMPTY_ARTIFACT', 'the workbook has no data rows');
    return sections.join('\n\n') + '\n';
  } catch (err) {
    if (err instanceof ZipContainerError) {
      throw new XlsxExtractionError(err.reasonCode === 'ARTIFACT_TOO_LARGE' ? 'ARTIFACT_TOO_LARGE' : 'XLSX_MALFORMED', err.message);
    }
    throw err;
  }
}
