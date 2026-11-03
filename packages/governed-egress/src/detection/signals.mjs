/**
 * Detection signals: an optional, stricter-only source of extra findings.
 *
 * A signal (in practice a local named-entity model) reads text and PROPOSES
 * spans. It decides nothing. Its spans become `seeds` for the deterministic
 * detector, which turns each accepted seed into a finding, joins it to a known
 * person, propagates it, and tokenizes it with everything else. Offsets,
 * merging and redaction stay in tested code.
 *
 * The rules this module enforces (docs/architecture/
 * governed-egress-local-signal-design-review-v1.md, approved 2026-09-25):
 *
 *   - A signal only ADDS. Nothing here can remove or clear a finding.
 *   - A signal that fails, times out, or returns malformed output REFUSES the
 *     release (DETECTION_SIGNAL_UNAVAILABLE). There is no silent fallback to
 *     detector-only: detector-only is a different policy pack.
 *   - Input over the word ceiling REFUSES (DETECTION_SIGNAL_INPUT_TOO_LARGE)
 *     instead of risking an unbounded run that ends in a timeout.
 *   - What is recorded is identity and counts. Never a value, span, offset or
 *     score, because those are derived from the document's content.
 *
 * No signal is registered in production by this module. A deployment that
 * passes none gets exactly the pre-0.5.0 behaviour.
 */
import { acceptSeed } from './pattern-detector.mjs';

export const SIGNAL_WORD_CEILING = 20_000;

/**
 * The refusal codes THIS module raises, as a closed set. Derived-by-test from
 * the `new DetectionSignalError('...'` literals below (test/detection-signals
 * .test.mjs), so a code added here without the set fails. The pipeline
 * re-raises them; it does not own them (the PIPELINE_DENY_CODES rule).
 */
export const SIGNAL_DENY_CODES = Object.freeze([
  'DETECTION_SIGNAL_INPUT_TOO_LARGE',
  'DETECTION_SIGNAL_UNAVAILABLE',
]);
export const DEFAULT_SIGNAL_TIMEOUT_MS = 30_000;

export class DetectionSignalError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'DetectionSignalError';
    this.reasonCode = reasonCode;
  }
}

/** The identity keys a signal may declare. Anything else is not recorded. */
const IDENTITY_KEYS = ['name', 'version', 'model', 'revision', 'weightsSha256', 'threshold'];

function identityOf(info) {
  const out = {};
  for (const k of IDENTITY_KEYS) {
    const v = info[k];
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  const chunk = info.chunk;
  if (chunk && Number.isInteger(chunk.maxWords) && Number.isInteger(chunk.overlap)) {
    out.chunk = { maxWords: chunk.maxWords, overlap: chunk.overlap };
  }
  return out;
}

/** Throws DetectionSignalError on a misconfigured signal list. */
export function validateSignals(signals) {
  if (!Array.isArray(signals)) {
    throw new DetectionSignalError('DETECTION_SIGNAL_UNAVAILABLE', 'deps.signals must be an array');
  }
  for (const s of signals) {
    if (!s || typeof s.propose !== 'function' || !s.info
        || typeof s.info.name !== 'string' || !s.info.name
        || typeof s.info.version !== 'string' || !s.info.version) {
      throw new DetectionSignalError('DETECTION_SIGNAL_UNAVAILABLE', 'a detection signal needs info.name, info.version and propose()');
    }
  }
}

function wordCount(text) {
  const m = text.match(/\S+/gu);
  return m ? m.length : 0;
}

async function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new DetectionSignalError('DETECTION_SIGNAL_UNAVAILABLE', `signal ${name} timed out after ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every signal over `text` and return the accepted seeds plus one count
 * report per signal. Throws DetectionSignalError on any failure.
 *
 * @param {Array<{info: object, propose(text): Promise<{seeds: Array}>}>} signals
 * @param {string} text
 * @param {{ timeoutMs?: number }} [options]
 */
export async function runSignals(signals, text, options = {}) {
  const words = wordCount(text);
  if (words > SIGNAL_WORD_CEILING) {
    throw new DetectionSignalError(
      'DETECTION_SIGNAL_INPUT_TOO_LARGE',
      `${words} words exceeds the detection-signal ceiling of ${SIGNAL_WORD_CEILING}`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_SIGNAL_TIMEOUT_MS;
  const seeds = [];
  const reports = [];
  for (const signal of signals) {
    let out;
    try {
      out = await withTimeout(Promise.resolve().then(() => signal.propose(text)), timeoutMs, signal.info.name);
    } catch (err) {
      if (err instanceof DetectionSignalError) throw err;
      throw new DetectionSignalError('DETECTION_SIGNAL_UNAVAILABLE', `signal ${signal.info.name} failed: ${err?.message}`);
    }
    if (!out || !Array.isArray(out.seeds)) {
      throw new DetectionSignalError('DETECTION_SIGNAL_UNAVAILABLE', `signal ${signal.info.name} returned no seeds array`);
    }
    let accepted = 0;
    let rejected = 0;
    for (const seed of out.seeds) {
      let r;
      try {
        r = acceptSeed(text, seed);
      } catch (err) {
        // A structurally broken seed means the signal is broken; its other
        // output cannot be trusted to be complete either.
        throw new DetectionSignalError('DETECTION_SIGNAL_UNAVAILABLE', `signal ${signal.info.name} returned a malformed seed: ${err?.message}`);
      }
      if (r.ok) {
        seeds.push(r.seed);
        accepted += 1;
      } else {
        rejected += 1;
      }
    }
    reports.push({ ...identityOf(signal.info), proposed: out.seeds.length, accepted, rejected });
  }
  return { seeds, reports };
}

/**
 * Does `detection` cover every span in `spans`? Used twice by the pipeline:
 * every accepted seed must be covered by a seeded-scan finding, and every
 * unseeded finding must still be covered by one (the scan only added). A
 * detector that ignores seeds, or that dropped a finding when seeded, fails.
 */
export function coversAll(detection, spans) {
  const findings = detection?.findings ?? [];
  return spans.every((s) => findings.some((f) => f.start <= s.start && f.end >= s.end));
}
