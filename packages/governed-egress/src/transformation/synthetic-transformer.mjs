/**
 * Synthetic same-type replacement: the model reads "Avery Quillfeather,
 * 555-555-0101" instead of "[PATIENT_001], [PHONE_001]". Some answers read
 * better that way; nothing about the release guarantee changes.
 *
 * Only categories with a value space that is fictional BY DEFINITION are
 * replaced synthetically:
 *   - PATIENT_NAME: a fixed list of invented names (100 distinct);
 *   - PHONE: 555-555-0100…0199, the NANP range reserved for fiction;
 *   - EMAIL: person.NNN@example.invalid (`.invalid` is reserved, RFC 2606).
 * Every other category keeps its token, because a realistic-looking MRN,
 * SSN, card or address could be somebody's. Past the list's capacity, the
 * entity also keeps its token. Both limits are honest fallbacks, never a
 * guess.
 *
 * A generated value that already appears ANYWHERE in the source (any case)
 * is not used — that entity keeps its token. Otherwise the release
 * verification, which masks generated spans, could not tell the two apart.
 *
 * Output is deterministic: the n-th entity of a category always gets the
 * n-th value, so the same document releases the same bytes.
 */
import { createReplacingTransformer } from './tokenizing-transformer.mjs';

export const SYNTHETIC_ENGINE = Object.freeze({ name: 'strix-synthetic-replacer', version: '0.1.0' });
export const SYNTHETIC_CATEGORIES = Object.freeze(['PATIENT_NAME', 'PHONE', 'EMAIL']);

const FIRST = Object.freeze(['Avery', 'Rowan', 'Emery', 'Quinn', 'Sasha', 'Tobin', 'Marlo', 'Linden', 'Oriel', 'Perrin']);
const LAST = Object.freeze([
  'Quillfeather', 'Ambercroft', 'Brightwater', 'Fenwick', 'Harrowgate',
  'Larkspur', 'Moorcastle', 'Thistledown', 'Wrenfield', 'Ashgrove',
]);
const CAPACITY = 100;

function generate(category, n) {
  if (n < 1 || n > CAPACITY) return null;
  const i = n - 1;
  switch (category) {
    case 'PATIENT_NAME':
      return `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`;
    case 'PHONE':
      return `555-555-01${String(i).padStart(2, '0')}`;
    case 'EMAIL':
      return `person.${String(n).padStart(3, '0')}@example.invalid`;
    default:
      return null;
  }
}

/** The n-th synthetic value for a category, or null (keep the token). */
export function syntheticValueFor(category, n, sourceLower = '') {
  const value = generate(category, n);
  if (value === null) return null;
  const lower = value.toLowerCase();
  if (sourceLower.includes(lower)) return null;
  // Name parts too: "Avery" alone in the source would read as the same person.
  if (category === 'PATIENT_NAME' && lower.split(' ').some((part) => new RegExp(`\\b${part}\\b`).test(sourceLower))) {
    return null;
  }
  return value;
}

export function createSyntheticTransformer() {
  return createReplacingTransformer({ engine: SYNTHETIC_ENGINE, replacementFor: syntheticValueFor });
}
