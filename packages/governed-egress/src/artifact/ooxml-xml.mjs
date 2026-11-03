/**
 * A minimal, linear-time XML event scanner for OOXML parts (XLSX, PPTX).
 *
 * Why not a general XML parser: this boundary needs exactly elements,
 * attributes and text, and needs them to fail CLOSED. Three properties are
 * load-bearing and pinned by tests:
 *
 *  - LINEAR. Every step advances a cursor with `indexOf`; no regex runs over
 *    more than one tag's own text. The DOCX extractor paid for the opposite
 *    (a lazy quantifier was quadratic on unclosed tags — 13.5s at 1.8MB).
 *  - NO DTDs. `<!DOCTYPE` and `<!ENTITY` are refused outright. OOXML never
 *    needs them, and a DTD is how an XML document defines entities that
 *    expand exponentially (billion laughs) or name external files (XXE).
 *  - ONLY THE FIVE XML ENTITIES plus numeric references are decoded; any
 *    other `&name;` refuses rather than passing through undecoded, because an
 *    undecoded entity is a string the detector was never shown in its real form.
 *
 * Element names are reduced to their local part (`x:c` → `c`), because OOXML
 * producers legitimately bind the main namespace to a prefix.
 *
 * HARDENED 2026-09-24 after an adversarial review, and each rule is pinned:
 *
 *  - A tag ends at the first `>` OUTSIDE a quoted attribute value. XML allows
 *    a literal `>` inside an attribute, and Excel allows it in a sheet name,
 *    so `name="A>B" state="hidden"` used to end the tag early, silently drop
 *    `state`, and release a hidden sheet as visible.
 *  - Attributes are parsed by a linear state machine, not a regex. The old
 *    regex was quadratic on a long run of name characters with no `=`: a
 *    948-byte deck took 84 seconds. Anything that is not a well-formed
 *    `name="value"` list refuses, and a duplicated attribute refuses, because
 *    "the last one wins" is a choice another reader may make differently.
 *  - A close tag must match the open tag it closes.
 *  - A numeric character reference must name a character XML allows. A
 *    surrogate, NUL or other control, or a code point past U+10FFFF refuses
 *    rather than throwing a RangeError that surfaced as EXTRACTION_FAILED.
 */

export class OoxmlXmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OoxmlXmlError';
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML 1.0 `Char`: the only code points a character reference may name. */
function xmlCodePoint(cp) {
  const ok =
    cp === 0x9 || cp === 0xa || cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff);
  if (!ok) throw new OoxmlXmlError('character reference names a character XML does not allow');
  return cp;
}

export function decodeXmlText(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    const semi = s.indexOf(';', amp);
    if (semi === -1 || semi - amp > 12) throw new OoxmlXmlError('unterminated entity reference');
    const body = s.slice(amp + 1, semi);
    if (Object.prototype.hasOwnProperty.call(ENTITIES, body)) {
      out += ENTITIES[body];
    } else if (/^#x[0-9a-fA-F]{1,6}$/.test(body)) {
      out += String.fromCodePoint(xmlCodePoint(parseInt(body.slice(2), 16)));
    } else if (/^#[0-9]{1,7}$/.test(body)) {
      out += String.fromCodePoint(xmlCodePoint(parseInt(body.slice(1), 10)));
    } else {
      throw new OoxmlXmlError('unknown entity reference');
    }
    i = semi + 1;
  }
  return out;
}

function localName(qname) {
  const c = qname.indexOf(':');
  return c === -1 ? qname : qname.slice(c + 1);
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w:.\-]/;
const SPACE = /[ \t\r\n]/;

/** Linear attribute parser; refuses anything that is not name="value"... */
function parseAttrs(body) {
  const attrs = Object.create(null);
  const seen = new Set();
  const n = body.length;
  let i = 0;
  while (i < n) {
    while (i < n && SPACE.test(body[i])) i += 1;
    if (i >= n) break;
    if (!NAME_START.test(body[i])) throw new OoxmlXmlError('malformed attribute');
    const nameStart = i;
    while (i < n && NAME_CHAR.test(body[i])) i += 1;
    const name = body.slice(nameStart, i);
    while (i < n && SPACE.test(body[i])) i += 1;
    if (body[i] !== '=') throw new OoxmlXmlError('malformed attribute');
    i += 1;
    while (i < n && SPACE.test(body[i])) i += 1;
    const quote = body[i];
    if (quote !== '"' && quote !== "'") throw new OoxmlXmlError('malformed attribute');
    const end = body.indexOf(quote, i + 1);
    if (end === -1) throw new OoxmlXmlError('unterminated attribute value');
    if (seen.has(name)) throw new OoxmlXmlError('duplicate attribute');
    seen.add(name);
    const value = decodeXmlText(body.slice(i + 1, end));
    // Keep the qualified name (r:id must stay distinguishable from id) and
    // also index the local name for unprefixed lookups.
    attrs[name] = value;
    const ln = localName(name);
    if (!(ln in attrs)) attrs[ln] = value;
    i = end + 1;
    if (i < n && !SPACE.test(body[i])) throw new OoxmlXmlError('malformed attribute');
  }
  return attrs;
}

/** Index of the `>` that ends the tag opened at `lt`, skipping quoted values. */
function tagEnd(xml, lt) {
  let quote = null;
  for (let j = lt + 1; j < xml.length; j += 1) {
    const ch = xml[j];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return j;
    } else if (ch === '<') {
      throw new OoxmlXmlError('unterminated tag');
    }
  }
  return -1;
}

/**
 * Walk `xml`, calling `on(event)` for each element open/close and each text
 * run. Returns nothing; throws OoxmlXmlError on anything it cannot read.
 * Events: { type: 'open', name, attrs, selfClosing } | { type: 'close', name }
 *       | { type: 'text', text }
 */
export function scanXml(xml, on) {
  const n = xml.length;
  let i = 0;
  let depth = 0;
  const open = [];
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      if (xml.slice(i).trim().length > 0 && depth > 0) on({ type: 'text', text: decodeXmlText(xml.slice(i)) });
      break;
    }
    if (lt > i && depth > 0) on({ type: 'text', text: decodeXmlText(xml.slice(i, lt)) });

    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new OoxmlXmlError('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new OoxmlXmlError('unterminated comment');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new OoxmlXmlError('unterminated CDATA section');
      if (depth > 0) on({ type: 'text', text: xml.slice(lt + 9, end) });
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      // <!DOCTYPE ...> and <!ENTITY ...>: never needed by OOXML, and the
      // mechanism behind entity expansion and external-entity attacks.
      throw new OoxmlXmlError('document type declarations are not accepted');
    }
    const gt = tagEnd(xml, lt);
    if (gt === -1) throw new OoxmlXmlError('unterminated tag');
    const raw = xml.slice(lt + 1, gt);
    if (raw.startsWith('/')) {
      const qname = raw.slice(1).trim();
      if (open.length === 0) throw new OoxmlXmlError('unbalanced close tag');
      if (open.pop() !== qname) throw new OoxmlXmlError('close tag does not match its open tag');
      on({ type: 'close', name: localName(qname) });
      depth -= 1;
    } else {
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const sp = body.search(/[\s]/);
      const qname = sp === -1 ? body : body.slice(0, sp);
      if (qname.length === 0) throw new OoxmlXmlError('empty tag name');
      on({ type: 'open', name: localName(qname), attrs: sp === -1 ? Object.create(null) : parseAttrs(body.slice(sp)), selfClosing });
      if (!selfClosing) {
        depth += 1;
        open.push(qname);
      }
    }
    i = gt + 1;
  }
  if (depth !== 0) throw new OoxmlXmlError('unclosed element');
}
