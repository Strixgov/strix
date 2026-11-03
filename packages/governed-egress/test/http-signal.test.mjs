/**
 * The HTTP signal client, against a real local HTTP server playing the worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createHttpDetectionSignal } from '../src/detection/http-signal.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';

const TOKEN = 'k'.repeat(40);
const IDENTITY = {
  name: 'strix-gliner-signal',
  version: '0.1.0',
  model: 'urchade/gliner_multi_pii-v1',
  revision: '1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d',
  weightsSha256: 'a'.repeat(64),
  threshold: 0.5,
  chunk: { maxWords: 200, overlap: 50 },
};

/** A fake worker. `answer(text, req)` returns the JSON body or a status number. */
async function worker(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, url: req.url, body });
      const out = answer(JSON.parse(body).text);
      if (typeof out === 'number') { res.writeHead(out); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const namesIn = (text, names) => names.flatMap((n) => {
  const i = text.indexOf(n);
  return i < 0 ? [] : [{ category: 'PATIENT_NAME', start: i, end: i + n.length, value: n }];
});

test('a correct worker answer yields seeds, and the pipeline tokenizes them', async () => {
  const w = await worker((text) => ({ ...IDENTITY, threads: 1, seeds: namesIn(text, ['Grace']) }));
  try {
    const signal = createHttpDetectionSignal({ url: w.url, token: TOKEN, expected: IDENTITY });
    const r = await prepareDocumentForEgress({
      source: { bytes: Buffer.from('Grace called about the bill.'), mimeType: 'text/plain' },
      prompt: 'Summarize the document.',
      destination: { provider: 'anthropic', service: 'messages' },
      purpose: 'appeal_drafting',
      policy: HEALTHCARE_REFERENCE_POLICY,
      actor: 'test',
      deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer(), signals: [signal] },
    });
    assert.equal(r.outcome, 'PREPARED', r.reasonCode);
    assert.ok(!r.releaseText.includes('Grace'));
    assert.equal(r.artifact.detectionSignals[0].weightsSha256, IDENTITY.weightsSha256);
    assert.equal(w.seen[0].auth, `Bearer ${TOKEN}`);
    assert.equal(w.seen[0].url, '/v1/propose');
  } finally {
    await w.close();
  }
});

async function rejects(answer, re) {
  const w = await worker(answer);
  try {
    const signal = createHttpDetectionSignal({ url: w.url, token: TOKEN, expected: IDENTITY });
    await assert.rejects(signal.propose('Grace called.'), re);
  } finally {
    await w.close();
  }
}

test('a worker reporting different weights, revision or threshold is refused', async () => {
  await rejects(() => ({ ...IDENTITY, weightsSha256: 'b'.repeat(64), seeds: [] }), /weightsSha256/);
  await rejects(() => ({ ...IDENTITY, revision: 'main', seeds: [] }), /revision/);
  await rejects(() => ({ ...IDENTITY, threshold: 0.9, seeds: [] }), /threshold/);
  await rejects(() => ({ ...IDENTITY, chunk: { maxWords: 200, overlap: 0 }, seeds: [] }), /chunk/);
});

test('a seed whose offsets do not match its text is refused', async () => {
  // Code-point offsets from a UTF-16-unaware worker: shifted by one.
  await rejects(() => ({ ...IDENTITY, seeds: [{ category: 'PATIENT_NAME', start: 1, end: 6, value: 'Grace' }] }), /offsets do not match/);
});

test('a non-2xx answer, a non-JSON body, or no seeds array is refused', async () => {
  await rejects(() => 500, /HTTP 500/);
  await rejects(() => 'not json', /non-JSON/);
  await rejects(() => ({ ...IDENTITY }), /no seeds array/);
  await rejects(() => ({ ...IDENTITY, seeds: [{ category: 'PATIENT_NAME', start: 0, end: 5 }] }), /malformed seed/);
});

test('plain http is refused except to loopback, and a short token is refused', () => {
  assert.throws(() => createHttpDetectionSignal({ url: 'http://10.0.0.5:8765', token: TOKEN, expected: IDENTITY }), /loopback/);
  assert.doesNotThrow(() => createHttpDetectionSignal({ url: 'https://signal.internal:8765', token: TOKEN, expected: IDENTITY }));
  assert.throws(() => createHttpDetectionSignal({ url: 'http://127.0.0.1:8765', token: 'short', expected: IDENTITY }), /32/);
  assert.throws(() => createHttpDetectionSignal({ url: 'http://127.0.0.1:8765', token: TOKEN, expected: { ...IDENTITY, weightsSha256: 'x' } }), /64/);
  assert.throws(() => createHttpDetectionSignal({ url: 'http://127.0.0.1:8765', token: TOKEN, expected: { name: 'x' } }), /missing/);
});

test('an unreachable worker refuses the release, never falls back', async () => {
  const signal = createHttpDetectionSignal({ url: 'http://127.0.0.1:9', token: TOKEN, expected: IDENTITY });
  const r = await prepareDocumentForEgress({
    source: { bytes: Buffer.from('Grace called.'), mimeType: 'text/plain' },
    prompt: 'Summarize the document.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'appeal_drafting',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'test',
    deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer(), signals: [signal] },
  });
  assert.equal(r.outcome, 'DENY');
  assert.equal(r.reasonCode, 'DETECTION_SIGNAL_UNAVAILABLE');
  assert.ok(!r.detail.includes('Grace'));
});
