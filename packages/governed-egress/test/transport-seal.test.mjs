// The public provider transports are not a route around the gate (2026-11-11).
// A transport only transmits a gate-sealed payload; a direct send() is refused
// before any I/O, and the seal is not reachable from outside the package.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnthropicMessagesTransport,
  createOpenAiChatTransport,
  governedAnthropicDocumentRequest,
  governedOpenAiDocumentRequest,
  createPatternDetector,
  createTokenizingTransformer,
  createInMemoryAuthorizationStore,
  createInMemoryEvidenceLog,
  HEALTHCARE_REFERENCE_POLICY,
} from '../src/index.mjs';

function fakeFetch(calls, body) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => 'req_seal' }, async json() { return body; }, async text() { return ''; } };
  };
}
const ANTHROPIC_OK = { model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const OPENAI_OK = { model: 'm', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };

const factories = [
  ['anthropic', () => { const calls = []; return { calls, t: createAnthropicMessagesTransport({ apiKey: 'k', fetchImpl: fakeFetch(calls, ANTHROPIC_OK) }) }; }],
  ['openai', () => { const calls = []; return { calls, t: createOpenAiChatTransport({ apiKey: 'k', fetchImpl: fakeFetch(calls, OPENAI_OK) }) }; }],
];

for (const [name, make] of factories) {
  test(`${name}: a direct send() is refused before any I/O`, async () => {
    const { calls, t } = make();
    await assert.rejects(t.send({ documentText: 'raw PHI: SSN 123-45-6789', prompt: 'p' }), (err) => err.kind === 'unsealed');
    assert.equal(calls.length, 0, 'fetch must never run for an unsealed send');
  });

  test(`${name}: a lookalike or globally registered symbol does not unseal it`, async () => {
    const { calls, t } = make();
    for (const sym of [Symbol('strix-egress.gate-send'), Symbol.for('strix-egress.gate-send')]) {
      await assert.rejects(t.send({ documentText: 'x', prompt: 'p', [sym]: true }), (err) => err.kind === 'unsealed');
    }
    assert.equal(calls.length, 0);
  });
}

const deps = () => ({
  detector: createPatternDetector(),
  transformer: createTokenizingTransformer(),
  store: createInMemoryAuthorizationStore(),
  evidence: createInMemoryEvidenceLog(),
});
const source = { bytes: Buffer.from('Quarterly throughput: 412 specimens processed.'), mimeType: 'text/plain', filename: 'n.txt' };
// The reference policy enables only Anthropic; OpenAI needs its own entry (default is deny).
const BOTH = { ...HEALTHCARE_REFERENCE_POLICY, policyId: 'seal-test-both', dataEgress: { externalAI: { ...HEALTHCARE_REFERENCE_POLICY.dataEgress.externalAI, destinations: { ...HEALTHCARE_REFERENCE_POLICY.dataEgress.externalAI.destinations, openai: { enabled: true, allowedData: ['deidentified', 'non_sensitive'] } } } } };

test('the same transports still send through the governed adapters, exactly once', async () => {
  const a = []; const o = [];
  const ra = await governedAnthropicDocumentRequest({ source, prompt: 'Summarize.', policy: HEALTHCARE_REFERENCE_POLICY, deps: deps(),
    transport: createAnthropicMessagesTransport({ apiKey: 'k', fetchImpl: fakeFetch(a, ANTHROPIC_OK) }) });
  const ro = await governedOpenAiDocumentRequest({ source, prompt: 'Summarize.', policy: BOTH, deps: deps(),
    transport: createOpenAiChatTransport({ apiKey: 'k', fetchImpl: fakeFetch(o, OPENAI_OK) }) });
  assert.equal(ra.released, true);
  assert.equal(ro.released, true);
  assert.equal(a.length, 1);
  assert.equal(o.length, 1);
});

test('the seal module is not importable through the package name', async () => {
  await assert.rejects(import('@strixgov/governed-egress/src/egress/gate-seal.mjs'), (err) => err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
});
