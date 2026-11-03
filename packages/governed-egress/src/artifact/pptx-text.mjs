/**
 * PPTX extraction — the governed boundary for PowerPoint decks.
 *
 * WHAT IS SENT: the text of every slide in presentation order, one line per
 * paragraph under a `Slide N` heading, and every table on a slide linearized
 * through the shared table module (`Header: value` lines) — because a slide
 * table is a table, and its header row sits away from its values exactly as
 * in a spreadsheet. The linearized text is what is scanned, verified and
 * released.
 *
 * THE CONTROLS, AND WHY EACH EXISTS:
 *
 *  - HIDDEN CONTENT IS REFUSED (PPTX_HIDDEN_CONTENT): a hidden slide
 *    (`show="0"`) or a hidden shape (`hidden="1"`) would be released without
 *    the person releasing it ever having looked at it in a slideshow.
 *  - MACROS ARE REFUSED (PPTX_UNSUPPORTED_CONTENT): a `vbaProject.bin` part
 *    means a .pptm renamed .pptx.
 *  - SLIDE TABLES ARE HELD TO THE TABLE RULES (PPTX_HEADER_INVALID,
 *    PPTX_UNRECOGNIZED_NAME_COLUMN, PPTX_RAGGED_ROWS): a name column the
 *    detector cannot label refuses the deck, as it does a spreadsheet.
 *  - TWO-COLUMN TABLES GET ONE READING, CHOSEN STRUCTURALLY
 *    (`twoColumnReading`): key/value or header/data, and PPTX_AMBIGUOUS_TABLE
 *    when neither can be chosen without risking an unlabeled identifier.
 *  - A paragraph's runs are joined into one line and `<a:br/>` becomes a
 *    space, so a label and its value typed in different runs ("Patient:"
 *    bold, the name not) still sit together on one line for the detector.
 *
 * NOT SENT, BY DESIGN: speaker notes (often where the patient detail is — they
 * are the author's, not the audience's), comments, slide masters and layouts
 * (template text), charts and their embedded data workbooks, images and
 * media, and alt text. Omission is the safe direction for egress; it means
 * the model sees only what is written on the slides.
 *
 * Structure failures are PPTX_MALFORMED; bounds are ARTIFACT_TOO_LARGE; never
 * a partial result.
 */
import { hasMacros, openZipContainer, ZipContainerError } from './zip-container.mjs';
import { scanXml, OoxmlXmlError } from './ooxml-xml.mjs';
import { linearizeTable } from './table-linearize.mjs';

export const PPTX_MAX_SLIDES = 500;
export const PPTX_MAX_TEXT_CHARS = 2_000_000;
export const PPTX_MAX_TABLE_COLUMNS = 200;
export const PPTX_MAX_TABLE_ROWS = 5_000;

export class PptxExtractionError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'PptxExtractionError';
    this.reasonCode = reasonCode;
  }
}

const PPTX_CODE = Object.freeze({
  TABLE_HEADER_INVALID: 'PPTX_HEADER_INVALID',
  TABLE_UNRECOGNIZED_NAME_COLUMN: 'PPTX_UNRECOGNIZED_NAME_COLUMN',
  TABLE_RAGGED_ROWS: 'PPTX_RAGGED_ROWS',
  TABLE_NAME_VALUE_UNRECOGNIZED: 'PPTX_NAME_VALUE_UNRECOGNIZED',
  TABLE_AMBIGUOUS_LAYOUT: 'PPTX_AMBIGUOUS_TABLE',
});

function fail(code, message) {
  throw new PptxExtractionError(PPTX_CODE[code] ?? code, message);
}

function readXml(zip, name) {
  const bytes = zip.read(name);
  if (bytes === null) fail('PPTX_MALFORMED', 'a required presentation part is missing');
  return bytes.toString('utf8').replace(/^﻿/, '');
}

function scan(xml, on) {
  try {
    scanXml(xml, on);
  } catch (err) {
    if (err instanceof OoxmlXmlError) fail('PPTX_MALFORMED', `presentation XML is malformed: ${err.message}`);
    throw err;
  }
}

function resolveTarget(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${base}/${target}`.split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function slideParts(zip) {
  const pres = readXml(zip, 'ppt/presentation.xml');
  const rels = readXml(zip, 'ppt/_rels/presentation.xml.rels');
  const targets = new Map();
  scan(rels, (e) => {
    if (e.type === 'open' && e.name === 'Relationship') {
      targets.set(e.attrs.Id, { target: resolveTarget('ppt', e.attrs.Target ?? ''), type: String(e.attrs.Type ?? '') });
    }
  });
  // Only `p:sldIdLst` children are slides. A deck with sections also carries
  // `p14:sldId` entries inside an extension list; reading those as slides
  // refused every sectioned deck as malformed.
  const ids = [];
  let slideSize = null;
  let inList = false;
  scan(pres, (e) => {
    if (e.type === 'open' && e.name === 'sldIdLst') inList = !e.selfClosing;
    else if (e.type === 'close' && e.name === 'sldIdLst') inList = false;
    else if (e.type === 'open' && e.name === 'sldId' && inList) ids.push(e.attrs['r:id'] ?? e.attrs.id);
    else if (e.type === 'open' && e.name === 'sldSz') {
      const cx = Number(e.attrs.cx);
      const cy = Number(e.attrs.cy);
      if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) slideSize = { cx, cy };
    }
  });
  if (ids.length > PPTX_MAX_SLIDES) fail('ARTIFACT_TOO_LARGE', `more than ${PPTX_MAX_SLIDES} slides`);
  const parts = ids.map((rid) => {
    const rel = targets.get(rid);
    if (!rel || !/\/slide$/.test(rel.type)) fail('PPTX_MALFORMED', 'a slide has no slide relationship');
    // A slide relationship must point at a slide part. Pointing it at a notes
    // part would otherwise send speaker notes as if they were a slide.
    if (!/^ppt\/slides\/[^/]+\.xml$/i.test(rel.target)) fail('PPTX_MALFORMED', 'a slide relationship does not target a slide part');
    return rel.target;
  });
  return { parts, slideSize };
}

const truthy = (v) => v === '1' || v === 'true';

export { twoColumnReading } from './table-linearize.mjs';

/** One slide → its text lines and tables, in document order. */
function parseSlide(xml, slideSize) {
  const items = []; // { kind: 'line', text } | { kind: 'table', rows }
  let paragraph = null; // text being collected for the current paragraph
  let inText = false;
  let table = null; // { rows: string[][] }
  let row = null;
  let cellParagraphs = null;
  let cellIsContinuation = false;
  let sawRoot = false;
  // Content inside `mc:Fallback` is what an OLDER reader would show instead
  // of the `mc:Choice` content. PowerPoint shows the Choice, so the Fallback
  // is not what the person releasing the deck saw; it is skipped.
  let fallbackDepth = 0;
  // Top-level shapes (not inside a group, whose child coordinates are in the
  // group's own space) are checked for being off the slide or zero-sized.
  let groupDepth = 0;
  let shape = null; // { outside: boolean, hasText: boolean }

  const outsideSlide = (off, ext) => {
    if (!slideSize || !off || !ext) return false;
    if (ext.cx === 0 && ext.cy === 0) return true;
    return off.x >= slideSize.cx || off.y >= slideSize.cy || off.x + ext.cx <= 0 || off.y + ext.cy <= 0;
  };

  scan(xml, (e) => {
    if (!sawRoot && e.type === 'open') {
      sawRoot = true;
      if (e.name !== 'sld') fail('PPTX_MALFORMED', 'a slide part is not a slide');
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
      switch (e.name) {
        case 'sld': {
          const show = String(e.attrs.show ?? '').trim().toLowerCase();
          if (show === '0' || show === 'false') fail('PPTX_HIDDEN_CONTENT', 'the deck has a hidden slide');
          break;
        }
        case 'grpSp':
          if (!e.selfClosing) groupDepth += 1;
          break;
        case 'sp':
        case 'graphicFrame':
          if (groupDepth === 0 && !e.selfClosing) shape = { off: null, ext: null, hasText: false };
          break;
        case 'off':
          if (shape && !shape.off) shape.off = { x: Number(e.attrs.x), y: Number(e.attrs.y) };
          break;
        case 'ext':
          if (shape && !shape.ext && e.attrs.cx !== undefined) shape.ext = { cx: Number(e.attrs.cx), cy: Number(e.attrs.cy) };
          break;
        case 'cNvPr':
          if (truthy(e.attrs.hidden)) fail('PPTX_HIDDEN_CONTENT', 'a slide has a hidden shape');
          break;
        case 'tbl':
          if (table) fail('PPTX_MALFORMED', 'a table is nested in a table');
          table = { rows: [] };
          break;
        case 'tr':
          if (table) {
            row = [];
            if (table.rows.length >= PPTX_MAX_TABLE_ROWS) fail('ARTIFACT_TOO_LARGE', 'a slide table has too many rows');
          }
          break;
        case 'tc':
          if (row) {
            // A merge-continuation cell is covered by its neighbour and is
            // not displayed; any text it carries is refused below.
            cellIsContinuation = truthy(e.attrs.hMerge) || truthy(e.attrs.vMerge);
            cellParagraphs = [];
            if (e.selfClosing) {
              row.push('');
              cellParagraphs = null;
            }
          }
          break;
        case 'p':
          paragraph = '';
          break;
        case 'br':
          if (paragraph !== null) paragraph += ' ';
          break;
        case 't':
          inText = !e.selfClosing;
          break;
        default:
          break;
      }
    } else if (e.type === 'close') {
      switch (e.name) {
        case 't':
          inText = false;
          break;
        case 'p': {
          const text = (paragraph ?? '').replace(/\s+/g, ' ').trim();
          if (text && shape) shape.hasText = true;
          if (cellParagraphs) {
            if (text) cellParagraphs.push(text);
          } else if (text) {
            items.push({ kind: 'line', text });
          }
          paragraph = null;
          break;
        }
        case 'tc':
          if (row && cellParagraphs) {
            if (cellIsContinuation && cellParagraphs.length > 0) {
              fail('PPTX_HIDDEN_CONTENT', 'a merged-away table cell carries text that is not displayed');
            }
            row.push(cellIsContinuation ? '' : cellParagraphs.join(' '));
            if (row.length > PPTX_MAX_TABLE_COLUMNS) fail('ARTIFACT_TOO_LARGE', 'a slide table has too many columns');
          }
          cellParagraphs = null;
          break;
        case 'tr':
          if (table && row) table.rows.push(row);
          row = null;
          break;
        case 'tbl':
          if (table) items.push({ kind: 'table', rows: table.rows });
          table = null;
          break;
        case 'grpSp':
          groupDepth -= 1;
          break;
        case 'sp':
        case 'graphicFrame':
          if (groupDepth === 0 && shape) {
            if (shape.hasText && outsideSlide(shape.off, shape.ext)) {
              fail('PPTX_HIDDEN_CONTENT', 'a shape with text is off the slide or has no size');
            }
            shape = null;
          }
          break;
        default:
          break;
      }
    } else if (e.type === 'text' && inText && paragraph !== null) {
      paragraph += e.text;
    }
  });
  return items;
}

/**
 * Extract a deck's slide text.
 * @param {Buffer} bytes
 * @returns {string}
 */
export function extractPptxText(bytes) {
  try {
    const zip = openZipContainer(bytes);
    if (hasMacros(zip)) fail('PPTX_UNSUPPORTED_CONTENT', 'the presentation contains macros');
    const sections = [];
    let total = 0;
    const { parts, slideSize } = slideParts(zip);
    parts.forEach((part, index) => {
      const items = parseSlide(readXml(zip, part), slideSize);
      const out = [];
      for (const item of items) {
        if (item.kind === 'line') {
          out.push(item.text);
        } else {
          out.push(...linearizeTable(item.rows, fail, { rowLabel: 'Table row' }));
        }
      }
      if (out.length === 0) return;
      const section = [`Slide ${index + 1}`, ...out].join('\n');
      total += section.length;
      if (total > PPTX_MAX_TEXT_CHARS) fail('ARTIFACT_TOO_LARGE', 'the presentation text exceeds the bound');
      sections.push(section);
    });
    if (sections.length === 0) fail('EMPTY_ARTIFACT', 'no slide contains text');
    return sections.join('\n\n') + '\n';
  } catch (err) {
    if (err instanceof ZipContainerError) {
      throw new PptxExtractionError(err.reasonCode === 'ARTIFACT_TOO_LARGE' ? 'ARTIFACT_TOO_LARGE' : 'PPTX_MALFORMED', err.message);
    }
    throw err;
  }
}
