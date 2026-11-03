/**
 * A DetectionSignal backed by the self-hosted signal worker
 * (apps/egress-signal-worker), reached over HTTP inside the customer's own
 * boundary.
 *
 * The client trusts nothing the worker says about itself without checking:
 *
 *   - IDENTITY on every response. The worker returns its model, revision and
 *     weights digest with each answer; any difference from the identity this
 *     client was pinned to refuses. A worker swapped or updated underneath a
 *     running console cannot quietly change what detection means.
 *   - Every SPAN against the document. Each seed carries the text it claims to
 *     cover, and `text.slice(start, end)` must equal it. An offset error (the
 *     code-point vs UTF-16 class, or any other) refuses instead of redacting
 *     the wrong characters and releasing the right ones.
 *   - The TRANSPORT. Plain http is accepted only to a loopback host; anything
 *     else must be https. The document is raw text at this point.
 *
 * Any failure throws, and the pipeline turns a throw into
 * DETECTION_SIGNAL_UNAVAILABLE. Error messages never carry document text.
 *
 * Nothing in production constructs this today (the console's dormancy pin).
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const IDENTITY_FIELDS = ['name', 'version', 'model', 'revision', 'weightsSha256', 'threshold'];

function checkUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new TypeError('signal worker url is not a URL');
  }
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u;
  throw new TypeError('signal worker url must be https, or http to a loopback host');
}

function sameChunk(a, b) {
  return (!a && !b) || (a && b && a.maxWords === b.maxWords && a.overlap === b.overlap);
}

/**
 * @param {{
 *   url: string,                 // worker base URL, e.g. http://127.0.0.1:8765
 *   token: string,               // STRIX_SIGNAL_TOKEN, 32+ characters
 *   expected: { name, version, model, revision, weightsSha256, threshold, chunk? },
 *   fetchImpl?: typeof fetch,
 *   requestTimeoutMs?: number,
 * }} options
 */
export function createHttpDetectionSignal({ url, token, expected, fetchImpl = globalThis.fetch, requestTimeoutMs = 30_000 }) {
  const base = checkUrl(url);
  if (typeof token !== 'string' || token.length < 32) throw new TypeError('signal worker token must be at least 32 characters');
  for (const k of IDENTITY_FIELDS) {
    if (expected?.[k] === undefined || expected[k] === '') throw new TypeError(`expected identity is missing ${k}`);
  }
  if (!/^[0-9a-f]{64}$/.test(expected.weightsSha256)) throw new TypeError('expected.weightsSha256 must be 64 lowercase hex');
  if (typeof fetchImpl !== 'function') throw new TypeError('no fetch implementation');
  const endpoint = new URL('/v1/propose', base).toString();
  const info = Object.freeze({ ...expected, ...(expected.chunk ? { chunk: { ...expected.chunk } } : {}) });

  return {
    info,
    async propose(text) {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!res.ok) throw new Error(`signal worker answered HTTP ${res.status}`);
      let body;
      try {
        body = await res.json();
      } catch {
        throw new Error('signal worker returned a non-JSON body');
      }
      for (const k of IDENTITY_FIELDS) {
        if (body?.[k] !== expected[k]) throw new Error(`signal worker identity differs from the pinned one (${k})`);
      }
      if (!sameChunk(body.chunk, expected.chunk)) throw new Error('signal worker identity differs from the pinned one (chunk)');
      if (!Array.isArray(body.seeds)) throw new Error('signal worker returned no seeds array');
      const seeds = [];
      for (const s of body.seeds) {
        if (!s || typeof s.value !== 'string' || !Number.isInteger(s.start) || !Number.isInteger(s.end)) {
          throw new Error('signal worker returned a malformed seed');
        }
        if (text.slice(s.start, s.end) !== s.value) {
          throw new Error('signal worker returned a seed whose offsets do not match its text');
        }
        seeds.push({ category: s.category, start: s.start, end: s.end });
      }
      return { seeds };
    },
  };
}
