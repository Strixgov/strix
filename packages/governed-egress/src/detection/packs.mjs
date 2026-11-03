/**
 * Lab revenue-cycle detection packs (Phase 1: lab-requisition, eob-835;
 * Phase 2: denial-appeal, provider-ids).
 * Plan: docs/strategy/specs/lab-rcm-detection-packs-plan-v1.md.
 *
 * A pack is an OPT-IN, versioned, content-addressed set of extra rules for
 * one document family. It can only ADD findings; it never removes one the
 * base detector made. Rules were tuned against accuracy/lab-packs/corpus-dev.mjs
 * only; the held-out split was committed and hashed before any rule here
 * existed (accuracy/lab-packs/HASHES.md).
 *
 * Every rule is label- or segment-anchored on purpose. Lab and billing text is
 * full of values that must survive (CPT, ICD-10, CARC/RARC, CLIA, amounts),
 * and an unanchored "long number" rule would destroy them.
 *
 * Each pack's `rulesSha256` is the sha256 of its rule sources (and guard
 * sources), so a record can name exactly which rules were active.
 *
 * Phase 2 rules were tuned against corpus-dev.mjs and corpus-dev-p2.mjs only.
 * corpus-heldout-p2.mjs was committed and hashed first (HASHES.md).
 *
 * provider-ids (Q1, operator decision 2026-10-06): provider identifiers are
 * KEPT by default; a deployment that turns this pack on replaces them. They
 * are public registry identifiers of the provider, not the patient. A TIN in
 * SSN format is the base detector's job (SSN) and is never a provider id.
 */
import { createHash } from 'node:crypto';

const SEP = String.raw`[ \t]*[:#\-]?[ \t]*`;
/** An identifier value: starts alphanumeric, carries at least one digit. */
const ID = String.raw`(?=[A-Z0-9\-\/]*[0-9])[A-Z0-9][A-Z0-9\-\/]{3,}`;
/** "Last, First" or "First Last", capitalised words, optional hyphen. */
const NAME = String.raw`\p{Lu}[\p{L}'\-]+(?:,[ \t]*\p{Lu}[\p{L}'\-]+|(?:[ \t]+\p{Lu}[\p{L}'\-]+){1,2})`;

const label = (labels, value, flags = 'giu') => new RegExp(String.raw`\b(?:${labels})` + SEP + `(${value})`, flags);
/**
 * A label spelled case-insensitively letter by letter, so the rule can run
 * WITHOUT the `i` flag. Under `i`, \p{Lu} matches lower-case letters too and
 * a name rule reads "physician Dr" as a name (found by the Phase 2 held-out
 * run; the same flaw the base detector fixed in 0.2.0).
 */
const ci = (src) => src.replace(/\\.|[a-z]/g, (c) => (c.length > 1 ? c : `[${c}${c.toUpperCase()}]`));
const nameLabel = (labels, value) => new RegExp(String.raw`\b(?:${ci(labels)})` + SEP + `(${value})`, 'gu');

/**
 * A capitalised word, then one or two more: a person's name, not a title.
 * Each word needs a lower-case letter after its capital, so an all-caps
 * label that follows a name ("Tomasz Wierzbicki   NPI") is not swallowed
 * into it (found 2026-10-06 on the Phase 1 dev split; denial-appeal and
 * provider-ids 0.1.1). All-caps names are left to the base detector.
 */
const NAME_WORD2 = String.raw`\p{Lu}[\p{Ll}'\-]*\p{Ll}[\p{L}'\-]*`;
const NAME2 = String.raw`${NAME_WORD2}(?:[ \t]+${NAME_WORD2}){1,2}`;
const HONORIFIC = String.raw`(?:Mr|Mrs|Ms|Mx|Miss)\.?`;
/** Words that make a capitalised phrase an organisation or a role, not a person. */
const NOT_A_PERSON = new Set(['provider', 'providers', 'sir', 'madam', 'member', 'members', 'customer', 'colleague', 'claims',
  'department', 'team', 'doctor', 'valued', 'patient', 'appeals', 'appeal', 'health', 'plan', 'services', 'service',
  'laboratory', 'laboratories', 'labs', 'lab', 'medical', 'clinic', 'clinical', 'insurance', 'payer', 'group', 'center',
  'centre', 'hospital', 'unit', 'inc', 'llc', 'corp', 'company', 'office', 'review', 'billing', 'reference', 'molecular',
  'diagnostics', 'pathology', 'associates', 'partners', 'network', 'care', 'healthcare', 'system', 'systems', 'utilization']);
const isPerson = (value) => !value.split(/[\s,]+/).some((w) => NOT_A_PERSON.has(w.toLowerCase()));
/** The sentence before `start` mentions an appeal, a claim or a denial. */
const inAppealSentence = (text, start) => {
  const from = Math.max(text.lastIndexOf('.', start - 1), text.lastIndexOf('\n', start - 1)) + 1;
  return /\b(?:appeal|claim|reconsideration|denial|denied)\b/i.test(text.slice(from, start));
};

/** A provider's name under a provider label, with or without "Dr.". */
const PROVIDER_NAME_RULE = Object.freeze({
  category: 'PROVIDER_ID',
  src: new RegExp(String.raw`\b(?:${ci(String.raw`(?:rendering|ordering|referring|billing|attending|treating)(?:[ \t]+(?:provider|physician|clinician))?|provider|physician|ordered[ \t]+by`)})[ \t]*:?[ \t]*(?:Dr\.?[ \t]+)?(${NAME2})`, 'gu'),
  guard: isPerson,
  providerName: true,
});

/**
 * Provider names under a provider label, for the BASE detector (0.8.0): the
 * base detector keeps them by default and the provider-ids pack replaces
 * them. Same rule as the pack's, so the two can never disagree on what a
 * provider name is.
 */
export function providerLabelNames(text) {
  return packFindings(text, [{ id: 'base', rules: [PROVIDER_NAME_RULE] }]).map((f) => f.value);
}

const RULES = Object.freeze({
  'denial-appeal': [
    // Letter-header reference numbers.
    { category: 'OTHER_ID', src: label(String.raw`(?:our[ \t]+)?ref(?:erence)?\.?(?:[ \t]+(?:no\.?|number|#|id))?|case[ \t]+(?:number|no\.?|#|id)|appeal[ \t]+(?:id|number|no\.?|#)`, ID) },
    // A claim number in prose ("appeal of claim 20261880072215"). Digits only,
    // eight or more, so "claim CO-45" and short codes are left alone.
    { category: 'OTHER_ID', src: /\bclaim(?:[ \t]+(?:number|no\.?|#|id))?[ \t]*[:#]?[ \t]*([0-9][0-9\-]{7,}[0-9])\b/giu },
    // Salutations: "Dear Ms. Castellanos-Pyke," / "Dear Ruairi Mbeki-Sorensen:".
    // "Dear Dr. …" is left alone: in a denial letter that is the provider (Q1).
    { category: 'PATIENT_NAME', src: new RegExp(String.raw`\bDear[ \t]+${HONORIFIC}[ \t]+(\p{Lu}[\p{L}'\-]+(?:[ \t]+\p{Lu}[\p{L}'\-]+){0,2})(?=[ \t]*[,:\n—])`, 'gu'), isName: true, guard: isPerson },
    { category: 'PATIENT_NAME', src: new RegExp(String.raw`\bDear[ \t]+(?!(?:Dr|Mr|Mrs|Ms|Mx|Miss)\b)(${NAME2})(?=[ \t]*[,:\n—])`, 'gu'), isName: true, guard: isPerson },
    // "Re: Wilhelmina Castellanos-Pyke" on its own line.
    { category: 'PATIENT_NAME', src: new RegExp(String.raw`(?:^|\n)[ \t]*(?:Re|RE|Regarding)[ \t]*:[ \t]*(${NAME2})[ \t]*(?=\n|$)`, 'gu'), isName: true, guard: isPerson },
    // "… claim … for Gideon Ashworth-Malley, member …", "for our patient, …".
    { category: 'PATIENT_NAME', src: new RegExp(String.raw`\bfor[ \t]+(?:(?:our|the)[ \t]+patient,?[ \t]+)?(${NAME2})(?=[ \t]*[,(])`, 'gu'), isName: true,
      guard: (value, text, start) => isPerson(value) && inAppealSentence(text, start) },
    // A signature naming the writer as the patient: "Hollis Varga-Eze (patient)".
    { category: 'PATIENT_NAME', src: new RegExp(String.raw`(${NAME2})[ \t]*\((?:patient|member|insured|subscriber)\)`, 'gu'), isName: true, guard: isPerson },
  ],
  'provider-ids': [
    { category: 'PROVIDER_ID', src: /\bNPI[ \t]*[:#]?[ \t]*([0-9]{10})(?![0-9])/gu },
    PROVIDER_NAME_RULE,
  ],
  'lab-requisition': [
    { category: 'OTHER_ID', src: label(String.raw`accession(?:[ \t]+(?:#|number|no\.?))?|acc\.?[ \t]*#`, ID) },
    { category: 'OTHER_ID', src: label(String.raw`req(?:uisition)?\.?[ \t]+(?:barcode|#|number|no\.?)`, ID) },
    { category: 'OTHER_ID', src: label(String.raw`spec(?:imen)?\.?[ \t]*(?:id|#|number|no\.?)`, ID) },
    { category: 'PATIENT_NAME', src: nameLabel(String.raw`pt\.?(?:[ \t]+name)?`, NAME), isName: true },
  ],
  'eob-835': [
    { category: 'OTHER_ID', src: label(String.raw`(?:patient[ \t]+)?account[ \t]*(?:#|number|no\.?)|acct[ \t]*#`, ID) },
    { category: 'OTHER_ID', src: label(String.raw`claim(?:[ \t]+control)?[ \t]*(?:#|number|no\.?)|ICN`, ID) },
    // X12 835 CLP: CLP01 patient control number and CLP07 payer claim control number.
    { category: 'OTHER_ID', src: /\bCLP\*([^*~\n]+)\*/gu, x12: true },
    { category: 'OTHER_ID', src: /\bCLP\*[^*~\n]*\*[^*~\n]*\*[^*~\n]*\*[^*~\n]*\*[^*~\n]*\*[^*~\n]*\*([^*~\n]+)/gu, x12: true },
    // X12 NM1*QC (patient): last name, then first name.
    { category: 'PATIENT_NAME', src: /\bNM1\*QC\*1\*([^*~\n]+)/gu, x12: true, isName: true },
    { category: 'PATIENT_NAME', src: /\bNM1\*QC\*1\*[^*~\n]+\*([^*~\n]+)/gu, x12: true, isName: true },
  ],
});

const TOKEN_LITERAL = /^\[[A-Z][A-Z_]*_[0-9]{3,}\]$/;

export const PACK_VERSIONS = Object.freeze({ 'lab-requisition': '0.1.1', 'eob-835': '0.1.0', 'denial-appeal': '0.1.1', 'provider-ids': '0.1.1' });
export const AVAILABLE_PACKS = Object.freeze(Object.keys(RULES));

function rulesSha256(id) {
  const src = RULES[id].map((r) => `${r.category}\u0000${r.src.source}\u0000${r.src.flags}\u0000${r.isName ? 1 : 0}${r.providerName ? 'P' : ''}${r.guard ? `\u0000${r.guard.toString()}` : ''}`).join('\n');
  return createHash('sha256').update(`${id}@${PACK_VERSIONS[id]}\n${src}`).digest('hex');
}

/** Resolve pack ids to frozen pack objects; an unknown id refuses. */
export function resolvePacks(ids = []) {
  if (!Array.isArray(ids)) throw new TypeError('packs must be an array of pack ids');
  const seen = new Set();
  return ids.map((id) => {
    if (!Object.hasOwn(RULES, id)) throw new TypeError(`unknown detection pack "${id}" (available: ${AVAILABLE_PACKS.join(', ')})`);
    if (seen.has(id)) throw new TypeError(`detection pack "${id}" listed twice`);
    seen.add(id);
    return Object.freeze({ id, version: PACK_VERSIONS[id], rulesSha256: rulesSha256(id), rules: RULES[id] });
  });
}

/** Findings a set of resolved packs adds to `text`. Names carry `isName`. */
export function packFindings(text, packs) {
  const out = [];
  for (const pack of packs) {
    for (const rule of pack.rules) {
      const re = new RegExp(rule.src.source, rule.src.flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        const value = m[1]?.trim();
        // A token the transformer already wrote ("[OTHER_ID_001]") is not an
        // identifier. Without this the verification rescan of a sanitized
        // X12 segment would find its own tokens and refuse the release.
        if (!value || TOKEN_LITERAL.test(value)) continue;
        const start = m.index + m[0].lastIndexOf(value);
        if (rule.guard && !rule.guard(value, text, start)) continue;
        out.push({ category: rule.category, start, end: start + value.length, value, isName: !!rule.isName, providerName: !!rule.providerName, pack: pack.id });
      }
    }
  }
  return out;
}

/** What a record names about the packs in force. */
export const packInfo = (packs) => packs.map(({ id, version, rulesSha256: sha }) => ({ id, version, rulesSha256: sha }));
