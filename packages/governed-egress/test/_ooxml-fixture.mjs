/**
 * Test-only builder for OOXML containers (XLSX/PPTX). Writes a real ZIP —
 * local headers, central directory, EOCD — with DEFLATE by default, so the
 * reader under test sees the shape a real Office file has. Not a general
 * ZIP writer: no ZIP64, no encryption.
 */
import { deflateRawSync } from 'node:zlib';

export function buildZip(entries, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, eocd]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Build a workbook. Each sheet: { name, rows: (string|number|{v,s,t,f})[][],
 * state?, rowAttrs?: {[rowIndex]: string}, cols?: string, formatPr?: string }.
 * Strings become shared strings; numbers are numeric cells; an object gives
 * full control of a cell.
 */
export function buildXlsx(sheets, { numFmts = [], cellXfs = [0], date1904 = false, extraParts = [] } = {}) {
  const shared = [];
  const sharedIndex = new Map();
  const sst = (s) => {
    if (!sharedIndex.has(s)) {
      sharedIndex.set(s, shared.length);
      shared.push(s);
    }
    return sharedIndex.get(s);
  };
  const parts = [];
  const sheetEls = [];
  const rels = [];
  sheets.forEach((sheet, i) => {
    const rid = `rId${i + 1}`;
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${sheet.kind ?? 'worksheet'}" Target="worksheets/sheet${i + 1}.xml"/>`);
    sheetEls.push(`<sheet name="${esc(sheet.name)}" sheetId="${i + 1}" r:id="${rid}"${sheet.state ? ` state="${sheet.state}"` : ''}/>`);
    const rowXml = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((cell, c) => {
            if (cell === null || cell === undefined) return '';
            const ref = `${colName(c)}${r + 1}`;
            if (typeof cell === 'string') return `<c r="${ref}" t="s"><v>${sst(cell)}</v></c>`;
            if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
            const s = cell.s !== undefined ? ` s="${cell.s}"` : '';
            const t = cell.t ? ` t="${cell.t}"` : '';
            const f = cell.f !== undefined ? `<f>${esc(cell.f)}</f>` : '';
            const v = cell.v !== undefined ? `<v>${esc(cell.v)}</v>` : '';
            const is = cell.is !== undefined ? `<is><t>${esc(cell.is)}</t></is>` : '';
            return `<c r="${ref}"${s}${t}>${f}${v}${is}</c>`;
          })
          .join('');
        const attrs = sheet.rowAttrs?.[r] ? ` ${sheet.rowAttrs[r]}` : '';
        return `<row r="${r + 1}"${attrs}>${cells}</row>`;
      })
      .join('');
    parts.push([
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheet.formatPr ?? ''}${sheet.cols ?? ''}<sheetData>${rowXml}</sheetData></worksheet>`,
    ]);
  });
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheetEls.join('')}</sheets></workbook>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="${numFmts.length}">${numFmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('')}</numFmts><cellXfs count="${cellXfs.length}">${cellXfs.map((id) => `<xf numFmtId="${id}"/>`).join('')}</cellXfs></styleSheet>`;
  const sstXml = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}">${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  return buildZip([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', `<Relationships>${rels.join('')}</Relationships>`],
    ['xl/styles.xml', styles],
    ['xl/sharedStrings.xml', sstXml],
    ...parts,
    ...extraParts,
  ]);
}

/**
 * Build a deck. Each slide: { paragraphs?: string[] | string[][] (runs),
 * table?: string[][], show?: '0', hiddenShape?: boolean }.
 */
export function buildPptx(slides, { extraParts = [], notes = [] } = {}) {
  const rels = [];
  const ids = [];
  const parts = [];
  slides.forEach((slide, i) => {
    const rid = `rId${i + 10}`;
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`);
    ids.push(`<p:sldId id="${256 + i}" r:id="${rid}"/>`);
    const paras = (slide.paragraphs ?? [])
      .map((p) => {
        const runs = Array.isArray(p) ? p : [p];
        return `<a:p>${runs.map((r) => (r === '\n' ? '<a:br/>' : `<a:r><a:t>${esc(r)}</a:t></a:r>`)).join('')}</a:p>`;
      })
      .join('');
    const sp = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"${slide.hiddenShape ? ' hidden="1"' : ''}/></p:nvSpPr><p:txBody>${paras}</p:txBody></p:sp>`;
    const tbl = slide.table
      ? `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${slide.table
          .map((row) => `<a:tr>${row.map((c) => `<a:tc><a:txBody><a:p><a:r><a:t>${esc(c)}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`)
          .join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
      : '';
    parts.push([
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"${slide.show ? ` show="${slide.show}"` : ''}><p:cSld><p:spTree>${sp}${tbl}</p:spTree></p:cSld></p:sld>`,
    ]);
  });
  const notesParts = notes.map((text, i) => [`ppt/notesSlides/notesSlide${i + 1}.xml`, `<p:notes><a:p><a:r><a:t>${esc(text)}</a:t></a:r></a:p></p:notes>`]);
  return buildZip([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/presentation.xml', `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', `<Relationships>${rels.join('')}</Relationships>`],
    ...parts,
    ...notesParts,
    ...extraParts,
  ]);
}
