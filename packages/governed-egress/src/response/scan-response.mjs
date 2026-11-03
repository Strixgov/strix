/**
 * Scan what comes BACK from the model, not only what goes out.
 *
 * The provider only ever saw tokenized text, so a clean release should
 * produce a clean answer. When it does not, the model introduced something
 * that looks like an identifier: a guessed name, an invented phone number,
 * a plausible SSN. The caller should know before they act on it or pass it
 * on.
 *
 * The scan runs over the answer exactly as the provider sent it (tokens and
 * all), BEFORE any re-identification: restored values would be found
 * trivially and prove nothing. Its NFKC form is scanned too and the worse
 * count governs, the verification rule applied to the return path.
 *
 * Two modes:
 *   - `flag` (default): the answer is returned, with the report beside it.
 *   - `withhold`: an answer with findings is not returned. A scan that could
 *     not run also withholds, because "we could not check" must not read as
 *     "clean" in the mode that asked for a guarantee.
 *
 * The report carries categories, counts, the detector's identity and the
 * answer's hash — never a value, a span, an offset, or a hash of a value.
 */
import { sha256Hex, prefixedHash } from '../artifact/hash.mjs';

export const RESPONSE_SCAN_PROVES = 'FINDINGS_BY_DETECTOR_ONLY';
export const RESPONSE_SCAN_MODES = Object.freeze(['flag', 'withhold']);

export class ResponseScanError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'ResponseScanError';
    this.reasonCode = reasonCode;
  }
}

/** Normalize `scanResponse: true | { onFindings }` into a mode, or null (off). */
export function responseScanMode(option) {
  if (option === undefined || option === null || option === false) return null;
  if (option === true) return 'flag';
  if (typeof option === 'object' && option.onFindings === undefined) return 'flag';
  if (typeof option === 'object' && RESPONSE_SCAN_MODES.includes(option.onFindings)) return option.onFindings;
  throw new ResponseScanError('SCAN_OPTION_MALFORMED', `scanResponse.onFindings must be one of ${RESPONSE_SCAN_MODES.join(', ')}`);
}

/**
 * @returns {Promise<{ status: 'clean'|'findings', findingsCount: number,
 *   categories: string[], responseHash: string, detector: object|null, proves: string }>}
 */
const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Blank whole-word, case-sensitive occurrences of values this release itself
 * generated (synthetic replacement). The model repeating "Avery
 * Quillfeather" is the release working, not a finding. Only exact generated
 * values are blanked; anything else the model wrote is scanned.
 */
function maskGenerated(text, generated) {
  const values = (generated ?? []).filter((v) => typeof v === 'string' && v.length >= 3);
  if (values.length === 0) return text;
  const re = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:${values.sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\p{L}\p{N}])`,
    'gu',
  );
  return text.replace(re, (m) => ' '.repeat(m.length));
}

export async function scanModelResponse({ responseText: answer, detector, generatedValues }) {
  if (typeof answer !== 'string') throw new ResponseScanError('RESPONSE_MALFORMED', 'responseText must be a string');
  if (!detector || typeof detector.scan !== 'function') throw new ResponseScanError('DETECTOR_UNAVAILABLE', 'no detector');
  const responseText = maskGenerated(answer, generatedValues);
  const first = await detector.scan(responseText);
  let findingsCount = first.findingsCount;
  let categories = [...first.categories];
  const nfkc = responseText.normalize('NFKC');
  if (nfkc !== responseText) {
    const second = await detector.scan(nfkc);
    findingsCount = Math.max(findingsCount, second.findingsCount);
    categories = [...new Set([...categories, ...second.categories])];
  }
  if (!Number.isInteger(findingsCount) || findingsCount < 0) {
    throw new ResponseScanError('DETECTOR_MALFORMED', 'detector returned an unusable count');
  }
  return Object.freeze({
    status: findingsCount === 0 ? 'clean' : 'findings',
    findingsCount,
    categories: Object.freeze(categories.sort()),
    // The hash names the answer as the provider sent it, never the mask.
    responseHash: prefixedHash(sha256Hex(answer)),
    detector: first.detector ?? detector.info ?? null,
    proves: RESPONSE_SCAN_PROVES,
  });
}

/** The evidence entry: categories, counts and hashes only. */
export function responseScanEvidenceEntry(report, { actor = null, mode, withheld, releasedArtifactHash = null } = {}) {
  return {
    type: 'egress_response_scanned',
    actor,
    releasedArtifactHash,
    responseHash: report.responseHash ?? null,
    status: report.status,
    findingsCount: report.findingsCount ?? null,
    categories: report.categories ?? [],
    detector: report.detector ?? null,
    mode,
    withheld,
    proves: RESPONSE_SCAN_PROVES,
  };
}
