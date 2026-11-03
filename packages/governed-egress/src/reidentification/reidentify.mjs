/**
 * Response re-identification: put the original values back into a model's
 * answer, for the caller who already holds them.
 *
 * WHERE THE KEY LIVES. The pipeline tokenizes a document and hands the
 * caller a re-identification key (token → original value) alongside the
 * release, OUTSIDE `artifact`. Nothing in this package stores it: not the
 * evidence log, not a receipt, not the kernel. Whoever holds the key already
 * held the document, so restoring values for them discloses nothing new. The
 * provider never sees the key.
 *
 * WHAT THIS MODULE REFUSES:
 *   - a key for a different release. The key carries the hash of the release
 *     text it was minted for, and the caller must name the release the answer
 *     came from; a mismatch throws. One document's names can never be poured
 *     into another document's answer.
 *   - a malformed key: unknown version, duplicate tokens, a token that is not
 *     the tokenizer's own grammar, a non-string value.
 *
 * WHAT IT DOES NOT DO:
 *   - guess. Only an exact token (`[PATIENT_001]`) is restored. A token the
 *     key does not contain (a model inventing `[PATIENT_009]`), or a mangled
 *     one (`PATIENT_001`, `[Patient 001]`), is left exactly as written and
 *     COUNTED, so a reader can see the answer references something that could
 *     not be restored. Restoring a near miss would risk putting one person's
 *     name where the model meant another.
 *
 * The report carries counts and the release hash only — never a value, a
 * token, or a digest of a value (a hash of a name is guessable).
 */
import { sha256Hex, prefixedHash } from '../artifact/hash.mjs';
import { TOKEN_PREFIX } from '../detection/categories.mjs';

export const REIDENTIFICATION_KEY_VERSION = 1;
/**
 * Version 2 keys come from synthetic replacement: an entry is `kind: 'token'`
 * (the token grammar, restored as in v1) or `kind: 'synthetic'` (a generated
 * value such as "Avery Quillfeather", restored where it appears as a whole
 * word, case-sensitively). A key never mixes versions' rules.
 */
export const REIDENTIFICATION_KEY_VERSION_SYNTHETIC = 2;
export const REIDENTIFICATION_PROVES = 'EXACT_TOKENS_RESTORED_ONLY';

const PREFIXES = Object.values(TOKEN_PREFIX);
const TOKEN_GRAMMAR = new RegExp(String.raw`^\[(?:${PREFIXES.join('|')})_[0-9]{3,}\]$`);
const ANY_TOKEN = new RegExp(String.raw`\[(?:${PREFIXES.join('|')})_[0-9]{3,}\]`, 'g');
// Shapes a model may produce when it rewrites a token: missing brackets,
// changed case, a space for the underscore. Counted, never restored.
const NEAR_MISS = new RegExp(String.raw`\[?(?:${PREFIXES.join('|')})[ _-]?[0-9]{3,}\]?`, 'gi');

export class ReidentificationError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'ReidentificationError';
    this.reasonCode = reasonCode;
  }
}

/**
 * Build the caller-held key from a transformer result and the release text.
 * Returns null when nothing was tokenized (a clear document needs no key).
 */
export function buildReidentificationKey(transformed, releaseText) {
  const entries = transformed?.restore ?? [];
  if (entries.length === 0) return null;
  const synthetic = entries.some((e) => e.kind === 'synthetic');
  return Object.freeze({
    keyVersion: synthetic ? REIDENTIFICATION_KEY_VERSION_SYNTHETIC : REIDENTIFICATION_KEY_VERSION,
    releaseHash: prefixedHash(sha256Hex(releaseText)),
    entries: Object.freeze(
      entries.map((e) =>
        Object.freeze(
          synthetic
            ? { token: e.token, category: e.category, value: e.value, kind: e.kind === 'synthetic' ? 'synthetic' : 'token' }
            : { token: e.token, category: e.category, value: e.value },
        ),
      ),
    ),
  });
}

function validateKey(key) {
  if (!key || typeof key !== 'object') throw new ReidentificationError('KEY_MALFORMED', 'key must be an object');
  const v2 = key.keyVersion === REIDENTIFICATION_KEY_VERSION_SYNTHETIC;
  if (key.keyVersion !== REIDENTIFICATION_KEY_VERSION && !v2) {
    throw new ReidentificationError('KEY_MALFORMED', `unsupported keyVersion ${String(key.keyVersion)}`);
  }
  if (typeof key.releaseHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(key.releaseHash)) {
    throw new ReidentificationError('KEY_MALFORMED', 'key.releaseHash must be sha256:<64 hex>');
  }
  if (!Array.isArray(key.entries) || key.entries.length === 0) {
    throw new ReidentificationError('KEY_MALFORMED', 'key.entries must be a non-empty array');
  }
  const map = new Map();
  const synthetic = new Map();
  for (const e of key.entries) {
    const isSynthetic = v2 && e?.kind === 'synthetic';
    if (v2 && e?.kind !== 'synthetic' && e?.kind !== 'token') {
      throw new ReidentificationError('KEY_MALFORMED', 'a v2 key entry must declare kind token or synthetic');
    }
    if (isSynthetic) {
      // A generated value: non-empty, and never shaped like a token.
      if (typeof e.token !== 'string' || e.token.trim().length < 3 || TOKEN_GRAMMAR.test(e.token)) {
        throw new ReidentificationError('KEY_MALFORMED', 'a synthetic key entry must be a generated value');
      }
    } else if (!e || typeof e.token !== 'string' || !TOKEN_GRAMMAR.test(e.token)) {
      throw new ReidentificationError('KEY_MALFORMED', 'a key entry token is not a pipeline token');
    }
    if (typeof e.value !== 'string' || e.value.length === 0) {
      throw new ReidentificationError('KEY_MALFORMED', 'a key entry value must be a non-empty string');
    }
    if (map.has(e.token) || synthetic.has(e.token)) throw new ReidentificationError('KEY_MALFORMED', 'duplicate token in key');
    (isSynthetic ? synthetic : map).set(e.token, e.value);
  }
  return { map, synthetic };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-sensitive occurrences of generated values, longest first. */
function syntheticPattern(synthetic) {
  if (synthetic.size === 0) return null;
  const alternatives = [...synthetic.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  return new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${alternatives.join('|')})(?![\p{L}\p{N}])`, 'gu');
}

/** The generated values a v2 key carries, for masking a response scan. */
export function syntheticSurfaces(key) {
  if (!key || key.keyVersion !== REIDENTIFICATION_KEY_VERSION_SYNTHETIC || !Array.isArray(key.entries)) return [];
  return key.entries.filter((e) => e?.kind === 'synthetic' && typeof e.token === 'string').map((e) => e.token);
}

/**
 * @param {{ responseText: string, key: object, releasedArtifactHash: string }} input
 *   `releasedArtifactHash` is the hash of the text actually released (the gate
 *   reports it, prefixed `sha256:`). It must equal the key's `releaseHash`.
 * @returns {{ text: string, report: {
 *   releaseHash: string, restoredOccurrences: number, restoredTokens: number,
 *   unknownTokens: number, nearMissTokens: number, proves: string } }}
 */
export function reidentifyResponse({ responseText, key, releasedArtifactHash }) {
  if (typeof responseText !== 'string') throw new ReidentificationError('RESPONSE_MALFORMED', 'responseText must be a string');
  const { map, synthetic } = validateKey(key);
  if (releasedArtifactHash !== key.releaseHash) {
    throw new ReidentificationError('KEY_RELEASE_MISMATCH', 'the key was minted for a different release');
  }
  let restoredOccurrences = 0;
  let unknownTokens = 0;
  const restored = new Set();
  // One pass over the ORIGINAL response for both kinds, so a restored value
  // is never re-read as something else to restore.
  const synth = syntheticPattern(synthetic);
  const combined = synth
    ? new RegExp(`${ANY_TOKEN.source}|${synth.source}`, 'gu')
    : ANY_TOKEN;
  const text = responseText.replace(combined, (match) => {
    const value = map.get(match) ?? synthetic.get(match);
    if (value === undefined) {
      unknownTokens += 1;
      return match;
    }
    restoredOccurrences += 1;
    restored.add(match);
    return value;
  });
  // Near misses are counted on the ORIGINAL response, minus exact tokens.
  const nearMissTokens = (responseText.replace(ANY_TOKEN, ' ').match(NEAR_MISS) ?? []).length;
  return {
    text,
    report: Object.freeze({
      releaseHash: key.releaseHash,
      restoredOccurrences,
      restoredTokens: restored.size,
      unknownTokens,
      nearMissTokens,
      proves: REIDENTIFICATION_PROVES,
    }),
  };
}

/** The evidence entry for a re-identification: counts and the release hash only. */
export function reidentificationEvidenceEntry(report, { actor = null } = {}) {
  return {
    type: 'egress_reidentified',
    actor,
    releasedArtifactHash: report.releaseHash,
    restoredOccurrences: report.restoredOccurrences,
    restoredTokens: report.restoredTokens,
    unknownTokens: report.unknownTokens,
    nearMissTokens: report.nearMissTokens,
    proves: report.proves,
  };
}
