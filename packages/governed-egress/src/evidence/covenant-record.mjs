/**
 * Covenant evidence record — an insurance underwriting covenant (warranty)
 * checked against the governed-egress evidence log.
 *
 * WHAT THIS IS. A cyber/E&O underwriter asks an insured a covenant question
 * ("do you keep PHI out of external AI tools?"). Today the answer is a
 * self-attestation. This record answers it with a DERIVED verdict over the
 * insured's own egress evidence chain for a stated window: per-term status,
 * the counts it rests on, the chain head it was derived from, and an explicit
 * coverage declaration saying what the record cannot see.
 *
 * LOAD-BEARING RULES (each pinned in test/covenant-record.test.mjs):
 *  - Verdicts are DERIVED, never accepted as input, and `verifyCovenantRecord`
 *    re-derives from the log — a stored verdict is never trusted.
 *  - Three states, never two. NOT_ESTABLISHED (could not check) is neither
 *    SATISFIED nor BREACHED: a broken chain, an empty window, or a log that is
 *    not the whole log from genesis can never read as compliance.
 *  - Overall verdict is worst-of: BREACHED > NOT_ESTABLISHED > SATISFIED.
 *  - No PHI and no entry text: the record carries counts, sequence numbers and
 *    hashes. The two identifiers an underwriter supplies (`insuredRef`,
 *    `covenantRef`) are restricted to an opaque-token alphabet so a name or
 *    address cannot ride in through them.
 *  - The record is a LOCAL UNSIGNED record (same ceiling as the receipt and the
 *    log). It does not determine coverage, compliance with the policy, or
 *    anything about AI use that did not pass through the governed proxy.
 */
import { createHash } from 'node:crypto';
import { canonical, verifyEvidenceChain } from './log.mjs';

export const COVENANT_RECORD_VERSION = 'covenant-evidence-v0';
export const COVENANT_RECORD_PROVES = 'LOCAL_UNSIGNED_RECORD';

export const COVENANT_STATUS = Object.freeze({
  SATISFIED: 'SATISFIED',
  BREACHED: 'BREACHED',
  NOT_ESTABLISHED: 'NOT_ESTABLISHED',
});

const SEVERITY = { SATISFIED: 0, NOT_ESTABLISHED: 1, BREACHED: 2 };

/** Why a term could not be established. Closed set. */
export const NOT_ESTABLISHED_REASONS = Object.freeze({
  CHAIN_INVALID: 'CHAIN_INVALID',
  NO_RELEASES_IN_WINDOW: 'NO_RELEASES_IN_WINDOW',
});

/**
 * Closed registry of covenant terms this version can derive. A term that is not
 * here is refused at build time: the registry is the claim ceiling, so a new
 * term is a deliberate addition with its own test, never a free-text string.
 */
export const COVENANT_TERMS = Object.freeze({
  /**
   * Every external-AI release authorized in the window passed the independent
   * post-transformation re-scan with zero remaining prohibited findings.
   */
  RELEASES_PASSED_VERIFICATION: 'RELEASES_PASSED_VERIFICATION',
  /**
   * Every release whose artifact was classified as containing PHI was
   * transformed before release, and the transformation covered every finding.
   */
  PHI_TRANSFORMED_BEFORE_RELEASE: 'PHI_TRANSFORMED_BEFORE_RELEASE',
});

/** What a verdict does NOT cover. Carried on every record, never dropped. */
export const COVENANT_COVERAGE = Object.freeze({
  scope: 'GOVERNED_TRAFFIC_ONLY',
  ungovernedAiUseObserved: null,
  notCovered: Object.freeze([
    'AI use that did not pass through the governed egress proxy',
    'identifiers the detector did not find (ceiling: no findings by this detector)',
    'whether the insured meets any covenant not listed in `terms`',
    'authenticity of the log (an unsigned chain proves internal consistency only)',
  ]),
});

const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function assertOpaqueRef(name, value) {
  if (typeof value !== 'string' || !OPAQUE_REF.test(value)) {
    throw new TypeError(`${name} must be an opaque token matching ${OPAQUE_REF} — names, addresses and free text are refused`);
  }
}

function assertInstant(name, value) {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be a UTC ISO-8601 instant like 2026-09-01T00:00:00Z`);
  }
}

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function inWindow(entry, from, to) {
  if (typeof entry.at !== 'string') return false;
  const t = Date.parse(entry.at);
  return !Number.isNaN(t) && t >= Date.parse(from) && t < Date.parse(to);
}

function evaluateTerm(term, authorized) {
  if (authorized.length === 0) {
    return {
      status: COVENANT_STATUS.NOT_ESTABLISHED,
      reason: NOT_ESTABLISHED_REASONS.NO_RELEASES_IN_WINDOW,
      examined: 0,
      violations: 0,
    };
  }
  let violations = 0;
  for (const e of authorized) {
    if (term === COVENANT_TERMS.RELEASES_PASSED_VERIFICATION) {
      const v = e.verification;
      if (!v || v.result !== 'passed' || (v.remainingProhibitedFindings ?? 0) !== 0) violations += 1;
    } else if (term === COVENANT_TERMS.PHI_TRANSFORMED_BEFORE_RELEASE) {
      if (e.initialClassification === 'phi_detected') {
        const t = e.transformation;
        const covered =
          t && Number.isInteger(t.detectedCount) && Number.isInteger(t.transformedCount) && t.transformedCount >= t.detectedCount && t.detectedCount > 0;
        if (!covered) violations += 1;
      }
    }
  }
  return {
    status: violations > 0 ? COVENANT_STATUS.BREACHED : COVENANT_STATUS.SATISFIED,
    examined: authorized.length,
    violations,
  };
}

/**
 * Derive the per-term results and the facts they rest on from a presented log.
 * Shared by build and verify so the two can never disagree about the rule.
 */
function derive({ entries, terms, windowFrom, windowTo }) {
  const chain = verifyEvidenceChain(entries);
  const base = {
    chain: chain.valid
      ? { valid: true, length: chain.length, headHash: chain.headHash }
      : { valid: false, length: entries.length, reasonCode: chain.reasonCode },
  };
  if (!chain.valid) {
    return {
      ...base,
      facts: null,
      termResults: Object.fromEntries(
        terms.map((t) => [t, { status: COVENANT_STATUS.NOT_ESTABLISHED, reason: NOT_ESTABLISHED_REASONS.CHAIN_INVALID, examined: 0, violations: 0 }]),
      ),
    };
  }
  const windowed = entries.filter((e) => inWindow(e, windowFrom, windowTo));
  const authorized = windowed.filter((e) => e.type === 'egress_authorized');
  const outcomes = windowed.filter((e) => e.type === 'egress_outcome');
  const count = (status) => outcomes.filter((o) => o.disclosureStatus === status).length;
  const facts = {
    entriesInWindow: windowed.length,
    firstSeq: windowed.length ? windowed[0].seq : null,
    lastSeq: windowed.length ? windowed[windowed.length - 1].seq : null,
    releasesAuthorized: authorized.length,
    refusals: windowed.filter((e) => e.type === 'egress_denied' || e.type === 'egress_refused').length,
    outcomes: {
      disclosed: count('disclosed'),
      possiblyDisclosed: count('possibly_disclosed'),
      notDisclosed: count('not_disclosed'),
    },
  };
  return {
    ...base,
    facts,
    termResults: Object.fromEntries(terms.map((t) => [t, evaluateTerm(t, authorized)])),
  };
}

function worstOf(termResults) {
  return Object.values(termResults).reduce(
    (worst, r) => (SEVERITY[r.status] > SEVERITY[worst] ? r.status : worst),
    COVENANT_STATUS.SATISFIED,
  );
}

function checkInputs({ insuredRef, covenantRef, terms, windowFrom, windowTo }) {
  assertOpaqueRef('insuredRef', insuredRef);
  assertOpaqueRef('covenantRef', covenantRef);
  assertInstant('windowFrom', windowFrom);
  assertInstant('windowTo', windowTo);
  if (Date.parse(windowFrom) >= Date.parse(windowTo)) throw new RangeError('windowFrom must be strictly before windowTo');
  if (!Array.isArray(terms) || terms.length === 0) throw new TypeError('terms must be a non-empty list — a record over zero terms would read as a pass');
  const known = Object.values(COVENANT_TERMS);
  for (const t of terms) {
    if (!known.includes(t)) throw new RangeError(`unknown covenant term "${String(t)}" — the registry is closed`);
  }
  if (new Set(terms).size !== terms.length) throw new RangeError('terms must not repeat');
}

/**
 * Build a covenant evidence record from the log's entries.
 *
 * @param {{
 *   insuredRef: string, covenantRef: string, terms: string[],
 *   windowFrom: string, windowTo: string, entries: Array<object>,
 * }} input  `entries` is the FULL log as list() returns it (from genesis).
 */
export function buildCovenantEvidenceRecord(input) {
  checkInputs(input);
  const { insuredRef, covenantRef, windowFrom, windowTo, entries } = input;
  const terms = [...input.terms].sort();
  const d = derive({ entries, terms, windowFrom, windowTo });
  const body = {
    covenantRecordVersion: COVENANT_RECORD_VERSION,
    insuredRef,
    covenantRef,
    window: { from: windowFrom, to: windowTo },
    terms: terms.map((t) => ({ term: t, ...d.termResults[t] })),
    overall: worstOf(d.termResults),
    derivedFrom: { chain: d.chain, facts: d.facts },
    coverage: COVENANT_COVERAGE,
    underwriterDeterminationMade: false,
    proves: COVENANT_RECORD_PROVES,
  };
  return Object.freeze({ ...body, recordHash: `sha256:${sha256Hex(canonical(body))}` });
}

/**
 * Re-derive a presented record from the log and report whether it agrees.
 * Never trusts the record's stored verdict, counts or hash.
 *
 * @returns {{ agrees: boolean, reasons: string[], proves: 'INTERNAL_CONSISTENCY_ONLY' }}
 */
export function verifyCovenantRecord(record, entries) {
  const reasons = [];
  try {
    const rebuilt = buildCovenantEvidenceRecord({
      insuredRef: record?.insuredRef,
      covenantRef: record?.covenantRef,
      terms: (record?.terms ?? []).map((t) => t.term),
      windowFrom: record?.window?.from,
      windowTo: record?.window?.to,
      entries,
    });
    const { recordHash: claimed, ...content } = record;
    if (`sha256:${sha256Hex(canonical(content))}` !== claimed) reasons.push('RECORD_HASH_MISMATCH');
    if (rebuilt.recordHash !== claimed) reasons.push('NOT_REDERIVABLE_FROM_LOG');
    if (rebuilt.overall !== record.overall) reasons.push('OVERALL_VERDICT_DIFFERS');
  } catch (err) {
    reasons.push(`UNREADABLE_RECORD: ${err?.message ?? 'invalid'}`);
  }
  return { agrees: reasons.length === 0, reasons, proves: 'INTERNAL_CONSISTENCY_ONLY' };
}
