/**
 * The v0.1 sensitive-data detector — one deterministic pattern + context
 * engine behind the replaceable SensitiveDataDetector interface (spec §5).
 *
 * Honest scope, stated because over-reading a detector is how PHI leaks:
 * this engine finds LABELED identifiers (Patient:, DOB:, MRN:, SSN:, Member
 * ID:, Routing:, EIN:, …) on the label's line or the line after it,
 * pattern-shaped identifiers (SSN, phone, email, street address,
 * city/state/ZIP, dates, check-digit-valid payment card numbers and IBANs,
 * EIN-shaped tax IDs), unlabelled names that start with a common given name
 * (given-names.mjs), and every further occurrence of a detected name
 * including standalone name parts, and (0.4.0) names and accounts that a
 * nearby word marks as one: a title ("Dr. Varga"), an initial ("J. Okafor"),
 * a sign-off line, "the X family", and a digit run after a money-movement
 * phrase ("wire the refund to 000123456789"), and (0.6.0) ISO and two-digit-year
 * dates, PO boxes, and SSNs, chart numbers, member IDs and names that a word
 * in the same sentence marks as one (see contextIdentifiers), and (0.7.0) a
 * time of day that belongs to a date ("09/14/2026 07:42") or to a specimen
 * collection field ("Collection time: 0630") — see dateTimes; and (0.8.0)
 * provider identifiers are KEPT by default — see keepProviderIds. A "no findings"
 * result means NO FINDINGS BY THIS DETECTOR, never "contains no PHI" — the
 * verification module carries that ceiling as a literal field, and the
 * policy layer treats the detector as a replaceable input, not the product.
 *
 * Determinism matters here: the same text must always yield the same
 * findings, because verification re-runs detection and a nondeterministic
 * detector would turn the mandatory second scan into a coin flip.
 */
export const DETECTOR_INFO = Object.freeze({
  name: 'strix-pattern-phi',
  version: '0.8.0',
});

import { resolvePacks, packFindings, packInfo, providerLabelNames } from './packs.mjs';
import { GIVEN_NAME_SET } from './given-names.mjs';

/**
 * Name-rule construction (0.2.0).
 *
 * 0.1.0 wrote the whole rule under the `i` flag, so `[A-Z]` matched ANY
 * letter: the label was case-insensitive (right) and so was the value
 * (wrong). A lower-case value such as "stable after the transfusion" was
 * captured and "the" was then propagated across the document. Worse, the
 * value grammar was ASCII-only and given-name-first only, so
 * "DOE, JANE", "O'Brien-Smith, Mary Ann" and "José Núñez" were never
 * detected — and the second-pass verification re-runs this same detector,
 * so a release carrying them reported verification PASSED.
 *
 * The label is now spelled case-insensitively by character class, the value
 * is case-SENSITIVE and Unicode-aware, and three value shapes are accepted:
 *   1. surname-first:   "DOE, JANE", "O'Brien-Smith, Mary Ann"
 *   2. given-first:     "Jane Doe", "Mary Ann de la Cruz Smith" (2–6 words)
 *   3. all lower-case:  "jane doe" — 2–3 words, only when it is the whole
 *      rest of the line and contains no common word, so prose after a label
 *      is not read as a name.
 *
 * 0.3.0 adds, each for a gap a 360 review found:
 *   4. uncased scripts (Han, Hangul, Kana, Arabic, Hebrew, Thai, Devanagari,
 *      …): 1–4 words of \p{Lo} letters that are the whole rest of the line.
 *      Cyrillic and Greek are cased and were already covered by \p{Lu}.
 *   5. a single capitalized word ("Patient Name: Doe") under an explicit
 *      name label, when it is the whole rest of the line and not a common
 *      word. Not under "Patient" or "Insured", whose values are often a
 *      status ("Insured: Yes").
 *   6. the value on the NEXT line, for a label that ends its line
 *      ("Patient:" in one text box, the name in the next). Only the
 *      multi-word and uncased forms, and only when the whole line is the
 *      name and it contains no common word.
 */
function ci(word) {
  return [...word].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch === ' ' ? '[ \\t]+' : ch)).join('');
}

/**
 * Labels whose value is a person's name. The person-role labels were added
 * in 0.2.0: a guarantor, subscriber or insured party on a claim is a
 * person-level identifier, and a table column under one of these headers
 * used to pass straight through the linearizer undetected.
 */
export const NAME_LABELS = Object.freeze([
  'patient name',
  'patient',
  'full name',
  'member name',
  'name',
  'guarantor',
  'subscriber',
  'insured',
  'beneficiary',
  'guardian',
  'responsible party',
]);

const NAME_PARTICLES = ['de', 'la', 'del', 'della', 'di', 'da', 'du', 'van', 'von', 'der', 'den', 'le', 'bin', 'al', 'el'];
const PARTICLE = `(?:${NAME_PARTICLES.join('|')})`;
const CAP_WORD = "\\p{Lu}[\\p{L}\\p{M}'\u2019.\\-]*";
const LOW_WORD = "\\p{Ll}[\\p{L}\\p{M}'\u2019.\\-]*";
const NAME_PART = `(?:${PARTICLE}[ \\t]+)*${CAP_WORD}`;
const SURNAME_FIRST = `${CAP_WORD}(?:[ \\t]+${NAME_PART}){0,2},[ \\t]*${CAP_WORD}(?:[ \\t]+${NAME_PART}){0,3}`;
const GIVEN_FIRST = `${CAP_WORD}(?:[ \\t]+${NAME_PART}){1,5}`;
const LOWER_WHOLE_LINE = `${LOW_WORD}(?:[ \\t]+${LOW_WORD}){1,2}(?=[ \\t]*(?:\\n|$))`;
const UNCASED_WORD = '\\p{Lo}[\\p{Lo}\\p{M}\u00B7\u30FB]*';
const UNCASED_WHOLE_LINE = `${UNCASED_WORD}(?:[ \\t]+${UNCASED_WORD}){0,3}(?=[ \\t]*(?:\\n|$))`;
const END_OF_LINE = '(?=[ \\t]*(?:\\n|$))';
const NAME_LABEL_RE = NAME_LABELS.map(ci).join('|');
/** Labels whose value is only ever a name, so a single word is still one. */
const SINGLE_WORD_NAME_LABELS = NAME_LABELS.filter((l) => l !== 'patient' && l !== 'insured');
const SINGLE_WORD_LABEL_RE = SINGLE_WORD_NAME_LABELS.map(ci).join('|');
/**
 * A label that ends its line, then up to three blank lines (0.4.0; one in
 * 0.3.0), then the value line. Forms exported from layout tools often leave
 * several empty lines between a field label and its value. The value must
 * still be the whole line and contain no common word, so a heading followed
 * by prose further down is not read as a name.
 */
const NEXT_LINE = '[ \\t]*[:\\-]?[ \\t]*\\n(?:[ \\t]*\\n){0,3}[ \\t]*';

/**
 * Words that are never propagated as a name part and never accepted in the
 * lower-case form, so a mis-captured value cannot tokenize common prose.
 */
const COMMON_WORDS = new Set([
  'the', 'and', 'for', 'with', 'was', 'were', 'has', 'had', 'have', 'not', 'but', 'are', 'from', 'this', 'that',
  'after', 'before', 'see', 'per', 'via', 'patient', 'name', 'member', 'account', 'plan', 'claim', 'note', 'notes',
  'status', 'stable', 'pending', 'denied', 'approved', 'none', 'unknown', 'review', 'follow', 'up', 'mr', 'mrs', 'ms', 'dr',
  'self', 'spouse', 'child', 'parent', 'other', 'same', 'yes', 'no', 'n/a', 'na', 'tbd', 'redacted', 'withheld',
  'date', 'number', 'id', 'type', 'code', 'total', 'amount', 'balance', 'description', 'summary', 'details', 'information',
]);

/**
 * Capitalized words that follow a given name in ordinary prose or headings
 * and are not surnames ("Mary Hospital", "John Street", "Mary January").
 * Checked on the word after a given name in the unlabelled rule only.
 */
/** Field labels that may follow a labelled name on its line (0.8.0). */
const TRAILING_FIELD_LABEL_RE = /(?:[ \t]+(?:NPI|TIN|EIN|DOB|MRN|SSN|CLIA|DOS|ACCT|Acct|Member|Account|Sex|Age))+$/u;

const NOT_SURNAME = new Set([
  ...COMMON_WORDS,
  // 0.8.0: field labels that follow a name on the same line ("Dr. Saoirse
  // Adebayo-Klein   NPI 1999906612") are not part of the name.
  'npi', 'tin', 'ein', 'dob', 'mrn', 'ssn', 'clia', 'dos', 'acct',
  'street', 'avenue', 'road', 'drive', 'lane', 'boulevard', 'court', 'place', 'hospital', 'clinic', 'medical', 'center',
  'centre', 'health', 'healthcare', 'university', 'college', 'school', 'church', 'county', 'city', 'state', 'foundation',
  'group', 'inc', 'llc', 'corp', 'company', 'memorial', 'regional', 'general', 'st', 'saint', 'fund', 'trust',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'and', 'or', 'of', 'to', 'in', 'on', 'at',
]);

/**
 * Words that name a ROLE, never a person. A signal seed made only of these
 * (and NOT_SURNAME words) is rejected; the detector's own rules never used
 * them as names either.
 */
const ROLE_WORDS = new Set([
  'reviewer', 'caller', 'provider', 'physician', 'clinician', 'doctor', 'nurse', 'therapist', 'pharmacist', 'surgeon',
  'agent', 'representative', 'rep', 'claimant', 'beneficiary', 'subscriber', 'guarantor', 'insured', 'dependent',
  'adjuster', 'coordinator', 'manager', 'office', 'staff', 'team', 'department', 'billing', 'payer', 'insurer',
  'applicant', 'guardian', 'caregiver', 'resident', 'client', 'customer', 'user',
]);

/** Words that start a sentence and would otherwise read as "Surname, Given". */
const NOT_LEADING_SURNAME = new Set([
  ...NOT_SURNAME,
  'thanks', 'thank', 'dear', 'hello', 'hi', 'hey', 'please', 'sincerely', 'regards', 'best', 'cheers', 'also', 'however',
  'today', 'yesterday', 'tomorrow', 'then', 'next', 'first', 'last', 'finally', 'yes', 'okay', 'ok', 'well', 'so', 'now',
  'attn', 'attention', 'cc', 're', 'from', 'to', 'signed',
]);

// 0.7.0: a name label may also start mid-line after sentence or field
// punctuation ("NPI 1999905518. Patient: Bartholomew Ikeda.", "acc 4471 |
// Patient: …"), not only at the start of a line.
const PATIENT_NAME_RE = new RegExp(
  `(?:^|\\n|[.;|\u00B7\u2014][ \\t]+)[ \\t]*(?:${NAME_LABEL_RE})(?:[ \\t]*[:\\-][ \\t]*(${SURNAME_FIRST}|${GIVEN_FIRST}|${LOWER_WHOLE_LINE}|${UNCASED_WHOLE_LINE})` +
    `|${NEXT_LINE}((?:${SURNAME_FIRST}|${GIVEN_FIRST}|${UNCASED_WORD}(?:[ \\t]+${UNCASED_WORD}){0,3})${END_OF_LINE}|${LOWER_WHOLE_LINE}))`,
  'gu',
);

const SINGLE_WORD_NAME_RE = new RegExp(
  `(?:^|\\n)[ \\t]*(?:${SINGLE_WORD_LABEL_RE})[ \\t]*[:\\-][ \\t]*(${CAP_WORD})${END_OF_LINE}`,
  'gu',
);

function hasCommonWord(value) {
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((w) => COMMON_WORDS.has(w.replace(/[.,]/g, '').toLowerCase()));
}

function isPlausibleLowerCaseName(value) {
  const words = value.trim().split(/\s+/);
  return !words.some((w) => COMMON_WORDS.has(w.toLowerCase()));
}

/**
 * "Doe, Jane" and "Jane Doe" are the same person, so they must share an
 * entity key or the transformer would give them two different tokens.
 */
function nameEntityKey(value) {
  const comma = value.indexOf(',');
  const ordered = comma === -1 ? value : `${value.slice(comma + 1)} ${value.slice(0, comma)}`;
  return normalizeEntity(ordered);
}

// Label-anchored rules: the finding span covers the VALUE, keeping the label
// so a sanitized document still reads "MRN: [MRN_001]".
//
// SEP allows the value on the label's own line or, since 0.3.0, on the next
// line (at most one blank line between). A value reached across a line
// break must contain a digit: "MRN" as a heading followed by "Approved" is
// not an identifier.
const SEP = String.raw`[ \t]*[:#\-]?[ \t]*(?:\n[ \t]*(?:\n[ \t]*)?)?`;
const labeled = (labels, value, flags = 'gi') => new RegExp(String.raw`\b(?:${labels})` + SEP + `(${value})`, flags);
const ID_VALUE = String.raw`[A-Z0-9][A-Z0-9\-]{3,}`;
/** Groups separated by a space or hyphen, every group carrying a digit, so a following word is never absorbed. */
const DIGIT_GROUPS = String.raw`(?:[A-Z]{2}[0-9]{2}[ ]?)?[A-Z0-9]*[0-9][A-Z0-9]*(?:[ \-][A-Z0-9]*[0-9][A-Z0-9]*){0,8}`;
const NUM = String.raw`(?:[ \t]+(?:number|no\.?|#))?`;

const LABELED_RULES = [
  { category: 'PATIENT_NAME', re: PATIENT_NAME_RE, isPatientName: true },
  { category: 'PATIENT_NAME', re: SINGLE_WORD_NAME_RE, isPatientName: true },
  { category: 'DATE', re: labeled('DOB|date of birth', String.raw`[0-9]{1,4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{1,4}`) },
  { category: 'MRN', re: labeled(String.raw`MRN|medical record (?:number|no\.?)|record #`, ID_VALUE) },
  { category: 'SSN', re: labeled(String.raw`SSN|social security (?:number|no\.?)`, '[0-9]{3}-?[0-9]{2}-?[0-9]{4}') },
  { category: 'INSURANCE_ID', re: labeled(String.raw`member id|policy (?:number|no\.?)|insurance id|subscriber id|group (?:number|no\.?)`, ID_VALUE) },
  { category: 'OTHER_ID', re: labeled(String.raw`account (?:number|no\.?)|specimen id|accession (?:number|no\.?)`, ID_VALUE) },
  // 0.3.0: bank and tax identifiers.
  {
    category: 'FINANCIAL_ACCOUNT',
    re: labeled(
      String.raw`routing(?:[ \t]+transit)?${NUM}|ABA(?:[ \t]+routing)?${NUM}|RTN|bank[ \t]+account${NUM}|checking(?:[ \t]+account)?${NUM}|savings(?:[ \t]+account)?${NUM}|acct\.?${NUM}|IBAN|SWIFT(?:[ \t]+code)?|BIC`,
      DIGIT_GROUPS,
    ),
    minDigits: 4,
  },
  {
    category: 'TAX_ID',
    re: labeled(
      String.raw`EIN|FEIN|TIN|ITIN|tax[ \t]+id(?:entification)?${NUM}|taxpayer[ \t]+id(?:entification)?${NUM}|federal[ \t]+tax[ \t]+id${NUM}|employer[ \t]+identification[ \t]+number`,
      '[0-9]{2}-?[0-9]{7}|[0-9]{3}-?[0-9]{2}-?[0-9]{4}',
    ),
  },
];

/** Luhn check digit, for payment card numbers. */
function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** How card numbers are printed: 4-4-4-4 (and a 19-digit tail), Amex 4-6-5, Diners 4-6-4, 13-digit 4-4-5. */
const CARD_GROUPINGS = new Set(['4-4-4-4', '4-4-4-4-3', '4-6-5', '4-6-4', '4-4-5']);

function plausibleCardNumber(match) {
  const separators = new Set(match.replace(/[0-9]/g, ''));
  if (separators.size > 1) return false; // mixed spaces and hyphens: not a card as written
  const digits = match.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  // Written with separators, a card is grouped the way cards are printed;
  // "4 1 1 1 …" or a run of short groups is a list of numbers, not a card.
  if (separators.size === 1) {
    const groups = match.split(/[ \-]/).map((g) => g.length).join('-');
    if (!CARD_GROUPINGS.has(groups)) return false;
  }
  if (!/^[2-6]/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  return luhnValid(digits);
}

/** ISO 13616 mod-97 check. */
function plausibleIban(match) {
  const compact = match.replace(/ /g, '');
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

// Context-free pattern rules: the whole match is the finding.
const PATTERN_RULES = [
  { category: 'SSN', re: /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/g },
  { category: 'PHONE', re: /(?:\+1[\s.\-]?)?(?:\([0-9]{3}\)[\s.\-]?|[0-9]{3}[\s.\-])[0-9]{3}[\s.\-][0-9]{4}\b/g },
  { category: 'EMAIL', re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  // Street line: number + capitalized words + a street suffix.
  { category: 'ADDRESS', re: /\b[0-9]{1,6}[ \t]+[A-Z][A-Za-z]*(?:[ \t]+[A-Z][A-Za-z]*)*[ \t]+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Boulevard|Blvd\.?|Court|Ct\.?|Way|Place|Pl\.?|Terrace|Trail|Circle|Cir\.?)\b/g },
  // 0.6.0: a PO box ("PO Box 2291", "P.O. Box 88120", "Post Office Box 7").
  // "Box" alone ("check box 12") is not an address.
  { category: 'ADDRESS', re: /\b(?:P\.?[ \t]?O\.?|Post[ \t]+Office)[ \t]*Box[ \t]+[0-9]{1,6}\b/gi },
  // City, ST 12345[-6789] — geographic subdivision below state.
  { category: 'ADDRESS', re: /\b[A-Z][A-Za-z]+(?:[ \t][A-Z][A-Za-z]+)?,[ \t]*[A-Z]{2}[ \t]+[0-9]{5}(?:-[0-9]{4})?\b/g },
  // Numeric dates (all dates below year granularity are conservative PHI).
  { category: 'DATE', re: /\b(?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12][0-9]|3[01])[\/\-](?:19|20)[0-9]{2}\b/g },
  // 0.6.0: ISO-style dates, year first, one separator used twice
  // (2024-06-30, 2024/06/30). Month and day are range-checked, so a build id
  // such as "2024-13-45" is not a date.
  { category: 'DATE', re: /(?<![0-9\-\/.])(?:19|20)[0-9]{2}([\/\-.])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12][0-9]|3[01])(?![0-9\-\/.]?[0-9])/g },
  // 0.6.0: two-digit-year dates, slashes only (3/14/24). Hyphens are left out
  // because short hyphenated digit runs are too often codes. A fraction or a
  // score (1/2, 12/31) has two parts and does not match.
  { category: 'DATE', re: /(?<![0-9\/])(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12][0-9]|3[01])\/[0-9]{2}(?![0-9\/])/g },
  // Month-name dates: January 4, 2026 / Jan 4 2026.
  { category: 'DATE', re: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?[ \t]+[0-9]{1,2}(?:,)?[ \t]+(?:19|20)[0-9]{2}\b/g },
  // 0.3.0: a payment card number — 13–19 digits, one kind of separator at
  // most, a card-network leading digit, and a valid Luhn check digit.
  { category: 'PAYMENT_CARD', re: /(?<![0-9])[0-9](?:[ \-]?[0-9]){12,18}(?![0-9])/g, validate: plausibleCardNumber },
  // An IBAN with a valid mod-97 check, written compact or in groups of four.
  { category: 'FINANCIAL_ACCOUNT', re: /\b[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, validate: plausibleIban },
  // An EIN written in its own shape (NN-NNNNNNN) needs no label.
  { category: 'TAX_ID', re: /(?<![0-9\-])[0-9]{2}-[0-9]{7}(?![0-9\-])/g },
];

/**
 * Unlabelled names (0.3.0): a given name from the lexicon followed by a
 * capitalized surname ("Jane Doe", "JANE DOE", "Mary Ann de la Cruz"), or a
 * capitalized surname, a comma and a given name ("Doe, Jane"). Up to two
 * further capitalized words are taken into the surname, and trailing words
 * that are common words or place nouns are dropped, so "John Smith Hospital"
 * yields "John Smith".
 */
const NAME_WORD = "\\p{Lu}[\\p{L}\\p{M}'\u2019\\-]+";
const UNLABELLED_GIVEN_FIRST = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_])(${NAME_WORD})((?:[ \\t]+\\p{Lu}\\.)?(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_WORD}){1,3})(?![\\p{L}\\p{M}\\p{N}_])`,
  'gu',
);
const UNLABELLED_SURNAME_FIRST = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_])(${NAME_WORD}),[ \\t]*(${NAME_WORD})(?:[ \\t]+(\\p{Lu}\\.|${NAME_WORD}))?(?![\\p{L}\\p{M}\\p{N}_])`,
  'gu',
);

function isGivenName(word) {
  if (GIVEN_NAME_SET.has(word)) return true;
  // ALL-CAPS forms ("JANE DOE") are common in claims and forms.
  if (word.length > 1 && word === word.toUpperCase()) {
    const title = word[0] + word.slice(1).toLowerCase();
    return GIVEN_NAME_SET.has(title);
  }
  return false;
}

function unlabelledNames(text) {
  const out = [];
  UNLABELLED_GIVEN_FIRST.lastIndex = 0;
  let m;
  while ((m = UNLABELLED_GIVEN_FIRST.exec(text)) !== null) {
    const given = m[1];
    if (!isGivenName(given)) {
      // Not a given name: retry from the next word, so "Called Jane Doe" still finds "Jane Doe".
      UNLABELLED_GIVEN_FIRST.lastIndex = m.index + given.length;
      continue;
    }
    const rest = m[2];
    const words = rest.trim().split(/[ \t]+/);
    // Keep an initial and particles; drop trailing non-surname words.
    while (words.length > 0 && NOT_SURNAME.has(words[words.length - 1].replace(/\./g, '').toLowerCase())) words.pop();
    const surnames = words.filter((w) => !/^\p{Lu}\.$/u.test(w) && !NAME_PARTICLES.includes(w));
    if (surnames.length === 0 || NOT_SURNAME.has(surnames[0].toLowerCase())) {
      UNLABELLED_GIVEN_FIRST.lastIndex = m.index + given.length;
      continue;
    }
    const value = `${given} ${words.join(' ')}`;
    const actual = text.slice(m.index, m.index + m[0].length);
    // Rebuild the span from the original text (whitespace may be tabs or runs).
    let end = m.index + given.length;
    for (const w of words) end = actual.indexOf(w, end - m.index) + m.index + w.length;
    out.push({ start: m.index, end, value: text.slice(m.index, end), entityKey: normalizeEntity(value) });
    UNLABELLED_GIVEN_FIRST.lastIndex = end;
  }
  UNLABELLED_SURNAME_FIRST.lastIndex = 0;
  while ((m = UNLABELLED_SURNAME_FIRST.exec(text)) !== null) {
    const [whole, surname, given, extra] = m;
    if (!isGivenName(given) || NOT_LEADING_SURNAME.has(surname.toLowerCase())) {
      UNLABELLED_SURNAME_FIRST.lastIndex = m.index + surname.length;
      continue;
    }
    let value = whole;
    if (extra && !/^\p{Lu}\.$/u.test(extra) && NOT_SURNAME.has(extra.toLowerCase())) value = whole.slice(0, whole.lastIndexOf(extra)).trimEnd();
    out.push({ start: m.index, end: m.index + value.length, value, entityKey: nameEntityKey(value) });
  }
  return out;
}

/**
 * Context-marked names and accounts (0.4.0).
 *
 * Each rule reads a word next to the value that says what the value is, so
 * none of them needs the value itself to be on a list. They came out of an
 * offline recall experiment (experiments/jev-recall/) in which a hosted
 * judgment model caught these cases; the rules below are the deterministic,
 * in-boundary version of what it was reading.
 *
 *   TITLE      "Dr. Varga", "Ms. Jordan", "Nurse Pellworth", "Dr. Jane Doe"
 *   INITIAL    "J. Okafor", "A. Lindqvist"
 *   SIGN-OFF   "Regards,\nTamsin Oyelaran" — the name line after a closing
 *   FAMILY     "the Oyelaran family"
 *   ACCOUNT    a 6–17 digit run after a money-movement phrase ("wire the
 *              overpayment to …", "deposit the settlement into …",
 *              "reimburse the member via …", "routed to …")
 *
 * Deliberately NOT covered, because no rule can tell them apart from
 * ordinary text: a possessive surname ("Varga's bill" has the shape of
 * "Aetna's policy"), and an unlabelled name with no marker at all.
 *
 * A name found here is propagated like any other, so after "Dr. Lincoln"
 * every "Lincoln" in the document is tokenized — including "Lincoln Medical
 * Center". That is the documented over-redaction direction, not a defect.
 */
const TITLES = ['Dr', 'Mr', 'Mrs', 'Ms', 'Mx', 'Miss', 'Nurse', 'Prof', 'Professor', 'Doctor', 'Rev', 'Dean', 'Judge', 'Officer'];
const TITLE_NAME_RE = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_])(?:${TITLES.join('|')})\\.?[ \\t]+(${NAME_WORD}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_WORD}){0,2})(?![\\p{L}\\p{M}\\p{N}_])`,
  'gu',
);
const INITIAL_NAME_RE = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_.])(\\p{Lu}\\.[ \\t]+${NAME_WORD})(?![\\p{L}\\p{M}\\p{N}_])`,
  'gu',
);
const SIGN_OFFS = ['regards', 'best regards', 'kind regards', 'warm regards', 'warmest regards', 'sincerely', 'yours sincerely',
  'sincerely yours', 'respectfully', 'thanks', 'thank you', 'many thanks', 'best', 'cheers', 'yours truly', 'cordially'];
const SIGN_OFF_RE = new RegExp(
  `(?:^|\\n)[ \\t]*(?:${SIGN_OFFS.map(ci).join('|')})[ \\t]*[,!.]?[ \\t]*\\n(?:[ \\t]*\\n)?[ \\t]*(${NAME_WORD}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_WORD}){1,3})${END_OF_LINE}`,
  'gu',
);
const FAMILY_RE = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])[Tt]he[ \\t]+(${NAME_WORD})[ \\t]+(?:family|household)\\b`, 'gu');

/** Trim trailing non-surname words; refuse when nothing name-like remains. */
function nameValue(raw) {
  const words = raw.trim().split(/[ \t]+/);
  while (words.length > 0 && NOT_SURNAME.has(words[words.length - 1].replace(/\./g, '').toLowerCase())) words.pop();
  const named = words.filter((w) => !/^\p{Lu}\.$/u.test(w) && !NAME_PARTICLES.includes(w));
  if (named.length === 0 || named.some((w) => NOT_SURNAME.has(w.replace(/\./g, '').toLowerCase()))) return null;
  return words.join(' ');
}

/**
 * The leading `count` whitespace-separated words of `raw`, as they appear in
 * the text (spacing kept), and their offset inside `raw`.
 */
function leadingWords(raw, count) {
  const words = [...raw.matchAll(/[^ \t]+/g)].slice(0, count);
  if (words.length === 0) return { offset: 0, value: '' };
  const first = words[0].index;
  const last = words[words.length - 1];
  return { offset: first, value: raw.slice(first, last.index + last[0].length) };
}

function contextNames(text) {
  const out = [];
  for (const re of [TITLE_NAME_RE, INITIAL_NAME_RE, SIGN_OFF_RE, FAMILY_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const named = nameValue(m[1]);
      if (!named) continue;
      // The span is taken from the TEXT, not from the normalized words: with
      // several spaces between words ("Adebayo-Klein   NPI"), a span sized by
      // the joined value ended mid-word and left the rest unreplaced (0.8.0).
      const { offset, value } = leadingWords(m[1], named.split(' ').length);
      const start = m.index + m[0].lastIndexOf(m[1]) + offset;
      const providerTitle = re === TITLE_NAME_RE && /^(?:Dr|Doctor)\b/u.test(m[0]);
      out.push({ start, end: start + value.length, value, entityKey: normalizeEntity(value), ...(providerTitle ? { providerTitle: true } : {}) });
    }
  }
  return out;
}

// A money-movement verb, up to 40 characters of the same sentence, then
// "to", "into" or "via", then up to three filler words ("the member's
// account"), then the digit run. The digit run must stand alone: a longer
// number, a decimal amount or a date-like "2026-09-15" is not taken.
const MONEY_MOVE_RE = new RegExp(
  String.raw`\b(?:wir(?:e|ed|es|ing)|deposit(?:ed|ing|s)?|refund(?:ed|ing|s)?|reimburs(?:e|ed|es|ing)|remit(?:s|ted|ting)?|transfer(?:s|red|ring)?|rout(?:e|ed|es|ing)|send|sent|sending|ACH|payout|pay(?:ment)?s?)\b` +
    String.raw`[^.\n;]{0,40}?\b(?:to|into|via)[ \t]+(?:(?:the|their|his|her|its|member'?s?|patient'?s?|account|acct\.?|bank|checking|savings|number|no\.?|#)[ \t]+){0,3}` +
    String.raw`([0-9](?:[ \-]?[0-9]){5,16})(?![0-9.,\-]?[0-9])`,
  'gi',
);

function contextAccounts(text) {
  const out = [];
  MONEY_MOVE_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_MOVE_RE.exec(text)) !== null) {
    const value = m[1];
    const start = m.index + m[0].length - value.length;
    out.push({ category: 'FINANCIAL_ACCOUNT', start, end: start + value.length, value });
  }
  return out;
}

/**
 * Context-marked identifiers (0.6.0).
 *
 * Each rule needs a MARKER — a word in the same sentence that says what the
 * value is — because the value's shape alone is shared with harmless text:
 *
 *   SSN        a bare 9-digit run in a sentence that says "social", "SSN"
 *              or "SS#" ("gave social 987654325"). "Ticket 987654321" is
 *              not one.
 *   MRN        an ID of 6–12 digits (up to three leading letters) directly
 *              after "chart", "medical record" or "MR#" ("chart #A2291034").
 *              "Chart review" and "chart notes" carry no digits.
 *   MEMBER ID  1–4 capital letters then 6–12 digits in a sentence about a
 *              payer, plan, coverage, eligibility or a member
 *              ("Payer rejected XJH448120937"). Procedure codes such as
 *              CPT99214 have five digits and do not match.
 *   NAME       two or more capitalized words after a contact phrase
 *              ("spoke with", "left a voicemail for", "met with",
 *              "called"). Institutions and role words are dropped
 *              ("Mercy Hospital", "Billing Team"), and a single word is
 *              never enough ("called Aetna").
 *
 * Deliberately NOT covered: the same values with no marker at all. A
 * nine-digit number or an alphanumeric code on its own is not evidence of
 * anything, and guessing would tokenize order numbers and part codes.
 */
const SENTENCE_SPLIT = /[.;!?\n]+(?=\s|$)|\n/;
const SSN_MARKER = /\b(?:social(?:[ \t]+security)?|SSN|SS#)/i;
const BARE_NINE_DIGITS = /(?<![0-9\-])[0-9]{9}(?![0-9\-])/g;
const MRN_CONTEXT_RE = /\b(?:charts?|med(?:ical)?[ \t]+rec(?:ord)?s?|MR[ \t]*#)[ \t]*(?:#|no\.?|number)?[ \t]*:?[ \t]*([A-Za-z]{0,3}[0-9]{6,12})(?![A-Za-z0-9])/gi;
const PAYER_MARKER = /\b(?:payers?|insurers?|insurance|carriers?|coverage|covered|eligib\w*|members?|subscribers?|plans?|policy|benefits?)\b/i;
const MEMBER_ID_SHAPE = /(?<![A-Za-z0-9])[A-Z]{1,4}[0-9]{6,12}(?![A-Za-z0-9])/g;
const CONTACT_PHRASES = [
  'spoke with', 'spoke to', 'speaking with', 'talked with', 'talked to', 'talking with', 'met with', 'meeting with',
  'called', 'calling', 'emailed', 'texted', 'messaged', 'left a voicemail for', 'left voicemail for',
  'left a message for', 'left message for', 'on behalf of',
];
const CONTACT_NAME_RE = new RegExp(
  `(?<![\\p{L}])(?:${CONTACT_PHRASES.map(ci).join('|')})[ \\t]+(${NAME_WORD}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_WORD}){1,3})(?![\\p{L}\\p{M}\\p{N}_])`,
  'gu',
);

function sentences(text) {
  const out = [];
  let at = 0;
  for (const piece of text.split(SENTENCE_SPLIT)) {
    const start = text.indexOf(piece, at);
    out.push({ start, text: piece });
    at = start + piece.length;
  }
  return out;
}

function contactNames(text) {
  const out = [];
  CONTACT_NAME_RE.lastIndex = 0;
  let m;
  while ((m = CONTACT_NAME_RE.exec(text)) !== null) {
    const value = nameValue(m[1]);
    if (!value) continue;
    const words = value.split(/[ \t]+/).filter((w) => !NAME_PARTICLES.includes(w));
    if (words.length < 2) continue;
    if (words.some((w) => ROLE_WORDS.has(w.toLowerCase()))) continue;
    const start = m.index + m[0].lastIndexOf(m[1]);
    out.push({ start, end: start + value.length, value, entityKey: normalizeEntity(value) });
  }
  return out;
}

function contextIdentifiers(text) {
  const out = [];
  for (const s of sentences(text)) {
    if (SSN_MARKER.test(s.text)) {
      BARE_NINE_DIGITS.lastIndex = 0;
      let m;
      while ((m = BARE_NINE_DIGITS.exec(s.text)) !== null) {
        if (/^(\d)\1+$/.test(m[0])) continue;
        out.push({ category: 'SSN', start: s.start + m.index, end: s.start + m.index + 9, value: m[0] });
      }
    }
    if (PAYER_MARKER.test(s.text)) {
      MEMBER_ID_SHAPE.lastIndex = 0;
      let m;
      while ((m = MEMBER_ID_SHAPE.exec(s.text)) !== null) {
        out.push({ category: 'INSURANCE_ID', start: s.start + m.index, end: s.start + m.index + m[0].length, value: m[0] });
      }
    }
  }
  MRN_CONTEXT_RE.lastIndex = 0;
  let m;
  while ((m = MRN_CONTEXT_RE.exec(text)) !== null) {
    const start = m.index + m[0].length - m[1].length;
    out.push({ category: 'MRN', start, end: start + m[1].length, value: m[1] });
  }
  return out;
}

function normalizeEntity(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Greedy non-overlap resolution: sort by start ascending, longer first;
 * accept a finding only if it does not overlap an already-accepted span.
 * Deterministic tiebreak keeps verification reproducible.
 */
function resolveOverlaps(findings) {
  const sorted = [...findings].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.category.localeCompare(b.category));
  const accepted = [];
  let lastEnd = -1;
  for (const f of sorted) {
    if (f.start >= lastEnd) {
      accepted.push(f);
      lastEnd = f.end;
    }
  }
  return accepted;
}

/**
 * Categories a detection signal (a local model) may seed. Only the two the
 * recall experiment measured; any other category is refused, never guessed.
 */
export const SEEDABLE_CATEGORIES = Object.freeze(['PATIENT_NAME', 'FINANCIAL_ACCOUNT']);

/**
 * Decide whether one signal-proposed span is usable as a seed, and trim it.
 *
 * Returns `{ ok: true, seed }` with surrounding whitespace trimmed, or
 * `{ ok: false, reason }`. Throws on a structurally malformed seed (wrong
 * types, out-of-range offsets, unknown category): that is a broken signal,
 * which the pipeline refuses, never a seed to skip.
 *
 * A well-formed seed can still be rejected for its CONTENT, and that is the
 * only filtering: a name seed must contain a letter, an account seed must
 * carry at least six digits (the detector's own account shape floor).
 */
export function acceptSeed(text, seed) {
  if (!seed || typeof seed !== 'object') throw new TypeError('seed must be an object');
  const { category, start, end } = seed;
  if (!SEEDABLE_CATEGORIES.includes(category)) throw new TypeError(`seed category not seedable: ${String(category)}`);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || end <= start) {
    throw new TypeError('seed offsets out of range');
  }
  let s = start;
  let e = end;
  while (s < e && /\s/u.test(text[s])) s += 1;
  while (e > s && /\s/u.test(text[e - 1])) e -= 1;
  if (e <= s) return { ok: false, reason: 'EMPTY' };
  const value = text.slice(s, e);
  if (category === 'PATIENT_NAME') {
    if (!/\p{L}/u.test(value)) return { ok: false, reason: 'NO_LETTER' };
    // Measured, not assumed: run over whole documents, the model marks role
    // words ("patient", "member", "reviewer") as people. A name in a script
    // that has case carries a capital letter, and a seed made only of common
    // or role words is not a name. Uncased scripts (Han, Arabic, …) pass.
    // The cost, stated: a real name written all in lower case is not seeded.
    if (/[\p{Lu}\p{Ll}]/u.test(value) && !/\p{Lu}/u.test(value)) return { ok: false, reason: 'NO_CAPITAL' };
    const words = value.toLowerCase().split(/[\s,]+/).map((w) => w.replace(/[.'’]+$/u, '')).filter(Boolean);
    const known = (w) => NOT_SURNAME.has(w) || ROLE_WORDS.has(w);
    if (words.length > 0 && words.every((w) => known(w) || (w.endsWith('s') && known(w.slice(0, -1))))) {
      return { ok: false, reason: 'COMMON_WORD' };
    }
  }
  if (category === 'FINANCIAL_ACCOUNT' && (value.match(/[0-9]/g) ?? []).length < 6) return { ok: false, reason: 'TOO_FEW_DIGITS' };
  return { ok: true, seed: { category, start: s, end: e } };
}

/**
 * Widen each seeded finding to cover every finding it overlaps, to a fixpoint.
 * The greedy resolver drops an overlapping finding outright, so a seed that
 * partly overlaps a detector finding would otherwise leave the rest of that
 * finding untokenized. The union is always the stricter outcome.
 */
function widenSeeded(text, raw) {
  for (const f of raw) {
    if (!f.seeded) continue;
    let changed = true;
    while (changed) {
      changed = false;
      for (const o of raw) {
        if (o === f || o.end <= f.start || o.start >= f.end) continue;
        if (o.start < f.start || o.end > f.end) {
          f.start = Math.min(f.start, o.start);
          f.end = Math.max(f.end, o.end);
          changed = true;
        }
      }
    }
    f.value = text.slice(f.start, f.end);
  }
}

/**
 * Core synchronous scan. Exported for the verification module's reuse.
 *
 * `options.seeds` (since 0.5.0) are spans a detection signal proposed. Each is
 * validated with `acceptSeed`; an accepted seed ALWAYS becomes a finding, a
 * name seed joins a known name's entity or starts its own, and is propagated
 * like any other name. Seeds only ever add findings: without seeds the scan is
 * exactly the unseeded scan, and with seeds its findings cover it (pinned by
 * test). The verification rescan never passes seeds.
 */
/**
 * Provider identifiers are kept by default (0.8.0; operator decision Q1,
 * 2026-10-06). HIPAA Safe Harbor removes identifiers of the patient and the
 * patient's relatives, employers and household, not of the provider, and an
 * NPI is public in the federal registry. Before 0.8.0 the "Dr." title rule
 * (0.4.0) and the EIN shape rule (0.3.0) replaced providers as if they were
 * patients, and labelled them "PATIENT".
 *
 * Kept by default:
 *   - a person's name after "Dr."/"Doctor" or under a provider label
 *     ("Ordering provider:", "Referring physician"), wherever it recurs;
 *   - an EIN-shaped TIN ("99-1234567") under a TIN / tax ID label when the
 *     same line names a provider ("provider", "practice", "NPI", "group" ...).
 * Still replaced, always:
 *   - a TIN in SSN form (a sole practitioner's SSN is patient-grade data);
 *   - an EIN with no provider on its line ("EIN: 12-3456789");
 *   - a provider-looking name that also appears under a patient label or a
 *     patient-specific pack rule (the provider may be the patient);
 *   - anything a detection signal proposed (signals only add).
 * With the provider-ids pack on, every one of these is replaced instead, as
 * PROVIDER_ID. Nothing here removes a finding that pack would not restore,
 * so the pack still only adds coverage.
 */
const TIN_LABEL_BEFORE_RE = /\b(?:TIN|EIN|tax[ \t]*id(?:entification)?(?:[ \t]+(?:number|no\.?|#))?|taxpayer[ \t]+id(?:entification)?(?:[ \t]+(?:number|no\.?|#))?)[ \t]*[:#]?[ \t]*$/i;
const PROVIDER_LINE_RE = /\b(?:provider|physician|practice|clinician|billing|rendering|referring|ordering|attending|group|clinic|laborator(?:y|ies)|lab|NPI|CLIA)\b/i;

function keepProviderIds(text, raw, { providerIdsOn, providerNames, nameWords }) {
  const patientWords = new Set(raw.filter((f) => f.patientEvidence).flatMap((f) => nameWords(f.value)));
  const providerSets = providerNames
    .map((v) => nameWords(v))
    .filter((words) => words.length && !words.some((w) => patientWords.has(w)))
    .map((words) => new Set(words));
  const out = [];
  for (const f of raw) {
    let provider = false;
    if (f.category === 'PATIENT_NAME' && !f.seeded) {
      const words = nameWords(f.value);
      provider = words.length > 0 && providerSets.some((set) => words.every((w) => set.has(w)));
    } else if (f.category === 'TAX_ID' && !f.seeded && /^[0-9]{2}-[0-9]{7}$/.test(f.value)) {
      const lineStart = text.lastIndexOf('\n', f.start - 1) + 1;
      const lineEnd = text.indexOf('\n', f.end);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      provider = TIN_LABEL_BEFORE_RE.test(text.slice(lineStart, f.start)) && PROVIDER_LINE_RE.test(line);
    }
    if (!provider) out.push(f);
    else if (providerIdsOn) {
      const { entityKey, ...rest } = f;
      out.push({ ...rest, category: 'PROVIDER_ID' });
    }
  }
  return out;
}

/**
 * Times of day tied to a patient date (0.7.0).
 *
 * HIPAA Safe Harbor removes every element of a date related to the
 * individual except the year, and a timestamp is part of that date. 0.6.0
 * replaced "09/14/2026" and left " 07:42" in the released text. Now:
 *   1. a time directly after a detected date ("09/14/2026 07:42",
 *      "2026-08-30T14:05", "08/02/2026 at 11:20", "9/05/26, 9:05 AM")
 *      WIDENS that date's finding, so one token covers date and time;
 *   2. a time under a specimen-collection label with no date of its own
 *      ("Collection time: 0630", "collected 13:40") is a DATE finding.
 * A four-digit time without a colon ("0915") is read as a time only after a
 * collection label, or after a date that follows one, because a bare
 * four-digit run after a date is as often a code or a year.
 * Times anywhere else ("Lab hours 07:00-18:00", "pickup 16:30") are kept:
 * they describe the lab, not the patient.
 */
const COLON_TIME = String.raw`(?:[01]?[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?(?:[ \t]?[AaPp]\.?[Mm]\.?(?![\p{L}]))?(?![0-9:\-])`;
const HHMM_TIME = String.raw`(?:[01][0-9]|2[0-3])[0-5][0-9](?:[ \t]?(?:hrs|h)\b)?(?![0-9:\-\/.])`;
const AFTER_DATE = String.raw`(?:T|[ \t]*,[ \t]*(?:(?:at|@)[ \t]*)?|[ \t]*(?:at|@)[ \t]*|[ \t]+)`;
const COLLECTION_LABEL = String.raw`\b(?:[Cc]ollect(?:ed|ion)(?:[ \t]+[Tt]ime)?|COLLECT(?:ED|ION)(?:[ \t]+TIME)?|[Cc]oll\.?|[Dd]rawn|DRAWN|[Dd]raw[ \t]+[Tt]ime|[Rr]eceived|RECEIVED|[Rr]ec'?d)`;
const COLLECTION_BEFORE_RE = new RegExp(COLLECTION_LABEL + String.raw`[ \t]*[:#\-]?[ \t]*(?:(?:on|at)[ \t]+)?$`, 'u');
const TIME_AFTER_DATE_COLON_RE = new RegExp(AFTER_DATE + `(${COLON_TIME})`, 'uy');
const TIME_AFTER_DATE_HHMM_RE = new RegExp(String.raw`[ \t]+(${HHMM_TIME})`, 'uy');
const COLLECTION_TIME_RE = new RegExp(COLLECTION_LABEL + String.raw`[ \t]*[:#\-]?[ \t]*(?:(?:on|at)[ \t]+)?(` + COLON_TIME + '|' + HHMM_TIME + ')', 'gu');

function dateTimes(text, raw) {
  for (const f of raw) {
    if (f.category !== 'DATE') continue;
    TIME_AFTER_DATE_COLON_RE.lastIndex = f.end;
    let m = TIME_AFTER_DATE_COLON_RE.exec(text);
    if (!m) {
      const lineStart = text.lastIndexOf('\n', f.start - 1) + 1;
      if (COLLECTION_BEFORE_RE.test(text.slice(Math.max(lineStart, f.start - 40), f.start))) {
        TIME_AFTER_DATE_HHMM_RE.lastIndex = f.end;
        m = TIME_AFTER_DATE_HHMM_RE.exec(text);
      }
    }
    if (m) {
      f.end = m.index + m[0].length;
      f.value = text.slice(f.start, f.end);
    }
  }
  COLLECTION_TIME_RE.lastIndex = 0;
  let m;
  while ((m = COLLECTION_TIME_RE.exec(text)) !== null) {
    const start = m.index + m[0].lastIndexOf(m[1]);
    raw.push({ category: 'DATE', start, end: start + m[1].length, value: m[1] });
  }
}

export function scanText(text, options = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('scanText: text must be a string');
  }
  const seeds = options.seeds ?? [];
  if (!Array.isArray(seeds)) throw new TypeError('scanText: seeds must be an array');
  const accepted = [];
  for (const seed of seeds) {
    const r = acceptSeed(text, seed);
    if (r.ok) accepted.push(r.seed);
  }
  const raw = [];

  for (const rule of LABELED_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const nextLine = m[2] !== undefined;
      let value = nextLine ? m[2] : m[1];
      if (value === undefined) continue;
      const start = m.index + m[0].lastIndexOf(value);
      const crossedLine = nextLine || m[0].slice(0, start - m.index).trimStart().includes('\n');
      if (rule.isPatientName) {
        // 0.8.0: a field label after the name on the same line ("Marguerite
        // Oyelowo-Banks   DOB: …") is not part of the name. Without this the
        // token swallowed the label and the release read "[PATIENT_001]: …".
        const trimmed = value.replace(TRAILING_FIELD_LABEL_RE, '');
        if (trimmed !== value) value = trimmed;
        if (/^\p{Ll}/u.test(value) && !isPlausibleLowerCaseName(value)) continue;
        if ((crossedLine || !/\s/.test(value.trim())) && hasCommonWord(value)) continue;
      } else if (crossedLine && !/[0-9]/.test(value)) {
        continue;
      }
      if (rule.minDigits && (value.match(/[0-9]/g) ?? []).length < rule.minDigits) continue;
      raw.push({
        category: rule.category,
        start,
        end: start + value.length,
        value,
        ...(rule.isPatientName ? { entityKey: nameEntityKey(value), patientEvidence: true } : {}),
      });
    }
  }

  for (const rule of PATTERN_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (rule.validate && !rule.validate(m[0])) continue;
      raw.push({ category: rule.category, start: m.index, end: m.index + m[0].length, value: m[0] });
    }
  }

  for (const f of unlabelledNames(text)) raw.push({ category: 'PATIENT_NAME', ...f });
  // A context-marked name that is part of a name already found ("Mr.
  // Sampleton" after "Patient: Thomas Sampleton") is the SAME person, so it
  // joins that entity instead of minting its own key — otherwise one person
  // would receive two different tokens.
  const knownNames = raw.filter((f) => f.category === 'PATIENT_NAME' && f.entityKey);
  const nameWords = (v) => v.toLowerCase().split(/[\s,]+/).map((w) => w.replace(/\.$/, '')).filter((w) => w.length > 1 && !NAME_PARTICLES.includes(w));
  for (const f of [...contextNames(text), ...contactNames(text)]) {
    const words = nameWords(f.value);
    const owner = knownNames.find((k) => {
      const kw = new Set(nameWords(k.value));
      return words.length > 0 && words.every((w) => kw.has(w));
    });
    raw.push({ category: 'PATIENT_NAME', ...f, ...(owner ? { entityKey: owner.entityKey } : {}) });
  }
  raw.push(...contextAccounts(text));
  raw.push(...contextIdentifiers(text));

  // Detection packs (opt-in, add-only). A pack name joins a known name's
  // entity like a context name does, else starts its own.
  const packs = options.packs ?? [];
  const providerNames = [];
  for (const f of packFindings(text, packs)) {
    if (f.providerName) providerNames.push(f.value);
    if (f.isName) {
      const words = nameWords(f.value);
      const owner = raw.find((k) => k.category === 'PATIENT_NAME' && k.entityKey && words.length > 0
        && words.every((w) => new Set(nameWords(k.value)).has(w)));
      raw.push({ category: 'PATIENT_NAME', start: f.start, end: f.end, value: f.value, entityKey: owner ? owner.entityKey : nameEntityKey(f.value), patientEvidence: true });
    } else {
      raw.push({ category: f.category, start: f.start, end: f.end, value: f.value });
    }
  }

  // Signal seeds. A name seed inside a known name joins that entity, the same
  // rule as the context names above; any other name seed is its own entity.
  const knownAfterContext = raw.filter((f) => f.category === 'PATIENT_NAME' && f.entityKey);
  for (const seed of accepted) {
    const value = text.slice(seed.start, seed.end);
    let entityKey;
    if (seed.category === 'PATIENT_NAME') {
      const words = nameWords(value);
      const owner = knownAfterContext.find((k) => {
        const kw = new Set(nameWords(k.value));
        return words.length > 0 && words.every((w) => kw.has(w));
      });
      entityKey = owner ? owner.entityKey : nameEntityKey(value);
    }
    raw.push({ category: seed.category, start: seed.start, end: seed.end, value, seeded: true, ...(entityKey ? { entityKey } : {}) });
  }

  // Patient-name propagation: every further occurrence of a detected name —
  // full name AND standalone parts ("Mr. Sampleton") — maps to the SAME
  // entity so the transformer tokenizes consistently (spec §6). Parts under
  // three characters are skipped (initials); over-redaction of a rare
  // collision is accepted as the fail-safe direction and documented.
  const nameEntities = new Map();
  for (const f of raw) {
    if (f.category === 'PATIENT_NAME' && f.entityKey) {
      if (!nameEntities.has(f.entityKey)) nameEntities.set(f.entityKey, f.value);
    }
  }
  for (const [entityKey, fullName] of nameEntities) {
    const needles = new Set([fullName]);
    const comma = fullName.indexOf(',');
    if (comma !== -1) needles.add(`${fullName.slice(comma + 1).trim()} ${fullName.slice(0, comma).trim()}`);
    for (const part of fullName.split(/[\s,]+/)) {
      const clean = part.replace(/[.,]/g, '');
      if (clean.length >= 3 && !COMMON_WORDS.has(clean.toLowerCase()) && !NAME_PARTICLES.includes(clean.toLowerCase())) {
        needles.add(clean);
      }
    }
    for (const needle of needles) {
      // Unicode-aware boundaries: `\b` is ASCII-only, so "Núñez" would never
      // match itself at a word edge. A name in an uncased script (Han, Kana,
      // Arabic, …) is written without spaces around it, so it is matched
      // without letter boundaries — over-redaction is the safe direction.
      const uncased = /^[\p{Lo}\p{M}\s\u00B7\u30FB]+$/u.test(needle);
      const re = uncased
        ? new RegExp(escapeRegExp(needle), 'gu')
        : new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{M}\\p{N}_])`, 'giu');
      let m;
      while ((m = re.exec(text)) !== null) {
        raw.push({
          category: 'PATIENT_NAME',
          start: m.index,
          end: m.index + m[0].length,
          value: m[0],
          entityKey,
        });
      }
    }
  }

  dateTimes(text, raw);
  const kept = keepProviderIds(text, raw, {
    providerIdsOn: packs.some((p) => p.id === 'provider-ids'),
    providerNames: [...providerNames, ...providerLabelNames(text), ...raw.filter((f) => f.providerTitle).map((f) => f.value)],
    nameWords,
  });
  raw.length = 0;
  raw.push(...kept);
  widenSeeded(text, raw);
  // `seeded` and the provenance flags are internal: findings reach the
  // transformer and must carry the same shape whatever produced them.
  const findings = resolveOverlaps(raw).map(({ seeded, providerTitle, patientEvidence, ...f }) => f);
  const categories = [...new Set(findings.map((f) => f.category))].sort();
  return {
    detected: findings.length > 0,
    findingsCount: findings.length,
    categories,
    findings,
    detector: packs.length ? { ...DETECTOR_INFO, packs: packInfo(packs) } : { ...DETECTOR_INFO },
  };
}

/**
 * The SensitiveDataDetector interface implementation (spec §5):
 *   detector.scan(text) -> Promise<DetectionResult>
 */
export function createPatternDetector({ packs: packIds = [] } = {}) {
  // Packs are bound HERE, at construction, so every scan this detector makes
  // uses them, including the verification rescan, which passes no options.
  const packs = resolvePacks(packIds);
  return {
    info: packs.length ? { ...DETECTOR_INFO, packs: packInfo(packs) } : { ...DETECTOR_INFO },
    acceptsSeeds: true,
    async scan(text, options) {
      return scanText(text, { ...options, packs });
    },
  };
}
