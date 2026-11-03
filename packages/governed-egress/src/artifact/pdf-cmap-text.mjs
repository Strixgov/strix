import { inflateSync } from 'node:zlib';
import { MAX_INFLATED_BYTES } from './limits.mjs';

// Narrow, fail-closed fallback for modern PDFs whose text is encoded with
// CID fonts. It only accepts fonts that publish an embedded ToUnicode CMap;
// it never guesses glyph identity from character codes.

function streamObjects(raw) {
  const out = new Map();
  // The dictionary span must not cross an `endobj`. With a bare `[\s\S]{0,8192}?`
  // the lazy capture walks straight past one object's `endobj` into the NEXT
  // object's `>> stream`, so a stream is filed under the preceding object's
  // number: in `1 0 obj <</Type/Font ... >> endobj  2 0 obj <</Length n>> stream`,
  // object 2's ToUnicode CMap was recorded as object 1's stream and `objects.get(2)`
  // came back undefined. Every CID font whose ToUnicode stream is preceded by a
  // non-stream object then failed the lookup, `fontToCmap` stayed empty, and the
  // recovery returned null — refusing EXTRACTION_UNRELIABLE on a PDF that publishes
  // a complete, unambiguous mapping. Fail-closed, so nothing unsafe shipped, but the
  // refusal was the parser's own bug rather than a property of the document.
  const re = /(\d+)\s+(\d+)\s+obj\s*<<((?:(?!endobj)[\s\S]){0,8192}?)>>\s*stream\r?\n/g;
  let m;
  let remaining = MAX_INFLATED_BYTES;
  while ((m = re.exec(raw)) !== null) {
    const end = raw.indexOf('endstream', re.lastIndex);
    if (end < 0) continue;
    const dict = m[3];
    let data = raw.slice(re.lastIndex, end).replace(/\r?\n$/, '');
    if (/\/Filter/.test(dict)) {
      if (!/\/FlateDecode\b/.test(dict) || remaining <= 0) continue;
      try {
        const inflated = inflateSync(Buffer.from(data, 'latin1'), { maxOutputLength: remaining });
        remaining -= inflated.length;
        data = inflated.toString('latin1');
      } catch { continue; }
    }
    out.set(Number(m[1]), { dict, data });
  }
  return out;
}

function unicodeFromHex(hex) {
  const clean = hex.replace(/\s/g, '');
  if (!clean || clean.length % 4 !== 0) return null;
  let s = '';
  for (let i = 0; i < clean.length; i += 4) {
    const unit = Number.parseInt(clean.slice(i, i + 4), 16);
    if (!Number.isFinite(unit)) return null;
    s += String.fromCharCode(unit);
  }
  return s;
}

// `bfchar` and `bfrange` are different operators with different arities, and
// each may only be read inside its own section. Scanning the WHOLE CMap with
// both patterns is what broke this: the three-token range regex happily
// consumes a bfchar PAIR plus the first token of the next pair, so
// `<0001> <0048>` followed by `<0002>` reads as lo=0001 hi=0048 dst=0002 — a
// 72-entry range that then OVERWRITES the single-glyph mappings the bfchar
// pass had just recorded correctly. `Hi` decoded as U+0002 U+0003.
//
// That failure does not fail closed. Every emitted glyph still resolves, so
// the "we never guess" check is satisfied and extraction returns text — the
// wrong text, for a document that stated its mapping exactly. Sectioning is
// therefore the correctness fix, not a tidy-up.
function sections(text, operator) {
  const out = [];
  const re = new RegExp(`begin${operator}([\\s\\S]*?)end${operator}`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function parseCMap(text) {
  const map = new Map();
  let m;
  for (const section of sections(text, 'bfchar')) {
    const charRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((m = charRe.exec(section)) !== null) {
      const value = unicodeFromHex(m[2]);
      if (value !== null) map.set(m[1].toUpperCase(), value);
    }
  }
  for (const section of sections(text, 'bfrange')) {
    const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((m = rangeRe.exec(section)) !== null) {
      const lo = Number.parseInt(m[1], 16);
      const hi = Number.parseInt(m[2], 16);
      const dst = Number.parseInt(m[3], 16);
      const width = m[1].length;
      if (hi < lo || hi - lo > 4096) continue;
      for (let cp = lo; cp <= hi; cp += 1) {
        const key = cp.toString(16).toUpperCase().padStart(width, '0');
        map.set(key, String.fromCodePoint(dst + cp - lo));
      }
    }
  }
  return map;
}

function decodeCid(hex, cmap) {
  const clean = hex.replace(/\s/g, '').toUpperCase();
  if (!clean) return '';
  const widths = [...new Set([...cmap.keys()].map(k => k.length))].sort((a, b) => b - a);
  let out = '';
  for (let i = 0; i < clean.length;) {
    let matched = false;
    for (const width of widths) {
      const key = clean.slice(i, i + width);
      if (key.length === width && cmap.has(key)) {
        out += cmap.get(key);
        i += width;
        matched = true;
        break;
      }
    }
    if (!matched) return null; // never guess an unmapped glyph
  }
  return out;
}

export function extractPdfTextWithToUnicode(buf) {
  const raw = buf.toString('latin1');
  const objects = streamObjects(raw);
  const cmaps = new Map();
  const fontToCmap = new Map();

  const objRe = /(\d+)\s+(\d+)\s+obj\s*([\s\S]*?)endobj/g;
  let m;
  while ((m = objRe.exec(raw)) !== null) {
    const body = m[3];
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(body);
    if (!tu) continue;
    const cmapObj = objects.get(Number(tu[1]));
    if (!cmapObj) continue;
    const cmap = parseCMap(cmapObj.data);
    if (cmap.size) cmaps.set(Number(m[1]), cmap);
  }

  // Resource dictionaries bind names used by Tf to font object references.
  const fontRefRe = /\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g;
  while ((m = fontRefRe.exec(raw)) !== null) {
    const cmap = cmaps.get(Number(m[2]));
    if (cmap) fontToCmap.set(m[1], cmap);
  }
  if (!fontToCmap.size) return null;

  const pieces = [];
  for (const { dict, data } of objects.values()) {
    if (/\/Subtype\s*\/Image\b/.test(dict) || !data.includes('BT')) continue;
    const btRe = /\bBT\b([\s\S]*?)\bET\b/g;
    let bt;
    while ((bt = btRe.exec(data)) !== null) {
      const block = bt[1];
      const tokenRe = /\/([A-Za-z0-9_.+-]+)\s+[0-9.]+\s+Tf|<([0-9A-Fa-f\s]+)>|\bTj\b|\bTJ\b|\bTd\b|\bTD\b|\bT\*\b/g;
      let active = null;
      let pending = [];
      let tok;
      while ((tok = tokenRe.exec(block)) !== null) {
        if (tok[1]) { active = fontToCmap.get(tok[1]) ?? null; continue; }
        if (tok[2] !== undefined) {
          if (!active) { pending = []; continue; }
          const decoded = decodeCid(tok[2], active);
          if (decoded === null) return null;
          pending.push(decoded);
          continue;
        }
        const op = tok[0];
        if (op === 'Tj' || op === 'TJ') {
          if (pending.length) pieces.push(pending.join(''));
          pending = [];
        } else if ((op === 'Td' || op === 'TD' || op === 'T*') && pieces.length) {
          pieces.push('\n');
        }
      }
    }
  }
  const text = pieces.join('').replace(/\r\n?/g, '\n').trim();
  return text || null;
}
