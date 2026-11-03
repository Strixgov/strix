/**
 * Mandatory post-transform verification (spec §7). The transformer never
 * grades itself: this module hashes the candidate release text and then runs
 * TWO independent checks over it —
 *
 *  1. A full detector RESCAN of the sanitized text (an injectable detector,
 *     so a deployment can supply a second, independent engine; v0.1 defaults
 *     to a fresh instance of the same engine, which the spec permits).
 *
 *  2. A raw-value containment check: none of the ORIGINAL findings' values
 *     (or patient-name parts) may survive verbatim in the release text,
 *     except where the value starts in the middle of another word
 *     ("ann" inside "planning") — see `containsResidual`.
 *     This check is independent of the detector's seeds — a raw name whose
 *     "Patient:" label was tokenized away is invisible to a rescan (the
 *     label was its seed) but is caught here. That case is pinned by test;
 *     it is the reason this second check exists.
 *
 * The result carries its claim ceiling as a literal field:
 * `proves: 'NO_FINDINGS_BY_DETECTOR'` — a passed verification means the
 * configured detector and the original-value check found nothing, never
 * "contains no PHI".
 */
import { sha256Hex } from '../artifact/hash.mjs';
import { TOKEN_PREFIX } from '../detection/categories.mjs';

export const VERIFICATION_PROVES = 'NO_FINDINGS_BY_DETECTOR';

/**
 * The verification rules' own identity. It enters the policy pack's content
 * address, so changing what counts as a residual value makes an approved pack
 * APPROVED_STALE and needs a human re-approval, exactly as a detector change
 * does. 0.1.0 was the plain substring containment rule; 0.2.0 (2026-09-25)
 * stops counting a value that starts in the middle of another word; 0.3.0
 * (2026-09-25) stops counting a value found inside the transformer's own
 * tokens; 0.4.0 (2026-09-26) masks the exact output spans a synthetic
 * replacer reports it inserted, when (and only when) they are given.
 */
export const VERIFICATION_INFO = Object.freeze({ name: 'strix-release-verification', version: '0.4.0' });

// The transformer's own tokens, exactly: `[<category prefix>_<3+ digits>]`,
// lower-cased because the haystack is. A value that happens to be a category
// word ("patient") would otherwise be found inside `[PATIENT_001]` and refuse
// every document. Only this grammar is masked, so a real name cannot hide in
// it: the prefixes are a closed set of category words, never document text.
const TOKEN_RE = new RegExp(
  String.raw`\[(?:${Object.values(TOKEN_PREFIX).map((p) => p.toLowerCase()).join('|')})_[0-9]{3,}\]`,
  'g',
);
function maskTokens(lowered) {
  return lowered.replace(TOKEN_RE, ' ');
}

function valueNeedles(originalFindings) {
  const needles = new Set();
  for (const f of originalFindings ?? []) {
    if (typeof f.value !== 'string') continue;
    const v = f.value.trim();
    if (v.length >= 3) needles.add(v.toLowerCase());
    if (f.category === 'PATIENT_NAME') {
      for (const part of v.split(/\s+/)) {
        const clean = part.replace(/[.,]/g, '');
        if (clean.length >= 3) needles.add(clean.toLowerCase());
      }
    }
  }
  return needles;
}

// Mirrors the detector's propagation predicate: a value written in an
// uncased script (Han, Kana, Arabic, Hebrew, Thai, ...) is not separated from
// neighbouring words by spaces, so it is matched as a plain substring.
const UNCASED_VALUE = /^[\p{Lo}\p{M}\s\u00B7\u30FB]+$/u;
const STARTS_WITH_CASED_LETTER = /^[\p{L}\p{M}]/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;

/**
 * Does an original value survive in the (lower-cased) release text?
 *
 * Until 2026-09-25 this was a plain substring test, which refused any document
 * where a name part appeared INSIDE another word: "ann" in "planning", "lee"
 * in "fleet", "will" in "goodwill". Those are not the name, and each refusal
 * threw away a correct redaction.
 *
 * The rule now: for a value that starts with a letter in a cased script, an
 * occurrence counts unless the character immediately BEFORE it is a letter or
 * combining mark — i.e. unless the value starts in the middle of a word.
 * Nothing is required AFTER the occurrence, deliberately:
 *   - the detector propagates names only at whole-word edges, so an inflected
 *     form ("Ковальчука", "Vargas", "Franks") is left in the release text,
 *     and this check is the only thing that catches it;
 *   - a possessive, plural or glued suffix ("Frank's", "annlee@") still counts.
 * The cost, accepted as the fail-safe direction: a name that is the start of
 * an ordinary word ("Frank" / "frankly", "Will" / "willing") still refuses.
 *
 * Digits and underscores before an occurrence do NOT excuse it ("user_ann",
 * "12ann" still count), which is stricter than the detector's own word
 * boundary. Values that start with a digit or symbol, and values in uncased
 * scripts, stay plain substring matches.
 */
export function containsResidual(haystack, needle) {
  if (UNCASED_VALUE.test(needle) || !STARTS_WITH_CASED_LETTER.test(needle)) {
    return haystack.includes(needle);
  }
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    if (i === 0) return true;
    // The full preceding code point, so an astral-plane letter is not split.
    const unit = haystack.charCodeAt(i - 1);
    const prev = unit >= 0xdc00 && unit <= 0xdfff && i >= 2 ? haystack.slice(i - 2, i) : haystack[i - 1];
    if (!LETTER_OR_MARK.test(prev)) return true;
  }
  return false;
}

/**
 * @param {{ text: string, originalFindings: Array, detector: { scan(text) } }} input
 * @returns {Promise<{
 *   status: 'passed'|'failed',
 *   scannedHash: string,
 *   remainingProhibitedFindings: number,
 *   residualValueFindings: number,
 *   rescan: { detector, categories, findingsCount },
 *   proves: string,
 * }>}
 * Throws if the detector throws — the caller must treat that as DENY
 * (DETECTOR_UNAVAILABLE), never as a pass.
 */
/**
 * Blank the given spans (same length, so nothing else moves). Spans must be
 * in bounds, ordered and non-overlapping; anything else throws, which the
 * caller treats as a refusal — a malformed mask must never widen what is
 * hidden from the rescan.
 */
export function maskSpans(text, spans) {
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    if (!Number.isInteger(s?.start) || !Number.isInteger(s?.end) || s.start < cursor || s.end > text.length || s.end <= s.start) {
      throw new TypeError('verifySanitizedArtifact: maskedSpans must be in-bounds, ordered and non-overlapping');
    }
    out += text.slice(cursor, s.start) + ' '.repeat(s.end - s.start);
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

export async function verifySanitizedArtifact({ text: releaseText, originalFindings, detector, maskedSpans }) {
  if (typeof releaseText !== 'string') {
    throw new TypeError('verifySanitizedArtifact: text must be a string');
  }
  // The hash is always of the text that is released, never of the mask.
  const scannedHash = sha256Hex(releaseText);
  // Synthetic replacement inserts realistic-looking values; the rescan must
  // not count what the replacer itself generated. Only the reported spans
  // are masked, and the replacer refuses a generated value that occurs in
  // the source, so a real value cannot sit inside one.
  const text = maskedSpans === undefined ? releaseText : maskSpans(releaseText, maskedSpans);

  const rescan = await detector.scan(text);
  let remainingProhibitedFindings = rescan.findingsCount;
  let rescanCategories = rescan.categories;

  // Defense in depth against unicode-obfuscated survivors: when the release
  // candidate is not NFKC-stable, its normalized form is rescanned too and
  // the WORST count governs. The pipeline already refuses documents whose
  // normalization reveals findings pre-transform; this is the same rule at
  // the last gate before release, so the guarantee does not depend on the
  // transformer never emitting a normalizable identifier.
  const nfkcText = text.normalize('NFKC');
  if (nfkcText !== text) {
    const nfkcRescan = await detector.scan(nfkcText);
    remainingProhibitedFindings = Math.max(remainingProhibitedFindings, nfkcRescan.findingsCount);
    rescanCategories = [...new Set([...rescanCategories, ...nfkcRescan.categories])].sort();
  }

  // The containment check reads the UNMASKED release text, so it does not
  // depend on the replacer reporting its spans honestly: a transformer that
  // reported a span over a real value still cannot hide it here.
  const nfkcRelease = releaseText.normalize('NFKC');
  const haystacks = (nfkcRelease !== releaseText
    ? [releaseText.toLowerCase(), nfkcRelease.toLowerCase()]
    : [releaseText.toLowerCase()]).map(maskTokens);
  let residualValueFindings = 0;
  for (const needle of valueNeedles(originalFindings)) {
    if (haystacks.some((h) => containsResidual(h, needle))) residualValueFindings += 1;
  }

  const status =
    remainingProhibitedFindings === 0 && residualValueFindings === 0 ? 'passed' : 'failed';

  return {
    status,
    scannedHash,
    remainingProhibitedFindings,
    residualValueFindings,
    rescan: {
      detector: rescan.detector,
      categories: rescanCategories,
      findingsCount: remainingProhibitedFindings,
    },
    proves: VERIFICATION_PROVES,
  };
}
