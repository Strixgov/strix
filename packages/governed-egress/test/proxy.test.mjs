/**
 * The drop-in proxy, driven over real HTTP on a loopback port with a fake
 * provider transport (no network, no key). Every property is checked at the
 * wire: what the client sends, what the provider receives, what comes back.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEgressProxy, parseChatRequest, MIN_TOKEN_LENGTH } from '../src/proxy/server.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { buildRecordText, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const TOKEN = 'p'.repeat(MIN_TOKEN_LENGTH + 8);
const NEEDLES = Object.values(SYNTHETIC_PHI).map((v) => String(v).toLowerCase());
const leaked = (v) => NEEDLES.filter((n) => JSON.stringify(v).toLowerCase().includes(n));

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function start({ answer = (p) => `Summary for ${p.documentText.match(/\[PATIENT_\d{3}\]/)?.[0] ?? 'nobody'}.`, ...config } = {}) {
  const sent = [];
  const lines = [];
  const proxy = createEgressProxy({
    policy: HEALTHCARE_REFERENCE_POLICY,
    provider: 'anthropic',
    token: TOKEN,
    model: 'test-model',
    transportFor: (model) => ({
      name: 'fake',
      async send(payload) {
        sent.push({ ...payload, model });
        return { responseText: answer(payload) };
      },
    }),
    log: (l) => lines.push(l),
    ...config,
  });
  const server = await proxy.listen({ port: 0 });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, sent, lines, proxy };
}

const post = (base, path, body, headers = { authorization: `Bearer ${TOKEN}` }) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));

test('OpenAI shape: the provider receives tokens, the client gets the answer back with values restored', async () => {
  const { base, sent, lines, proxy } = await start();
  const { status, json } = await post(base, '/v1/chat/completions', {
    model: 'test-model',
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'Summarize the encounter for the physician.' },
      { role: 'user', content: buildRecordText() },
    ],
  });
  assert.equal(status, 200);
  assert.equal(json.object, 'chat.completion');
  assert.equal(json.choices[0].message.content, `Summary for ${SYNTHETIC_PHI.patientName}.`);
  assert.equal(json.strix.decision, 'SANITIZE');
  assert.equal(json.strix.responseScan.status, 'clean');
  assert.deepEqual(json.strix.ignoredParameters, ['temperature'], 'unforwarded parameters are named, not silently honoured');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].prompt, 'Summarize the encounter for the physician.');
  assert.deepEqual(leaked(sent), [], 'nothing original reached the provider');
  assert.deepEqual(leaked(json.strix), [], 'governance block carries no values');
  assert.deepEqual(leaked(proxy.evidence.list()), [], 'evidence');
  assert.deepEqual(leaked(lines), [], 'logs');
  assert.ok(lines.every((l) => /^POST \/v1\/chat\/completions \d{3}$/.test(l)));
});

test('Anthropic shape works the same, with x-api-key auth', async () => {
  const { base } = await start();
  const { status, json } = await post(
    base,
    '/v1/messages',
    { model: 'test-model', max_tokens: 200, system: 'Summarize.', messages: [{ role: 'user', content: [{ type: 'text', text: buildRecordText() }] }] },
    { 'x-api-key': TOKEN },
  );
  assert.equal(status, 200);
  assert.equal(json.type, 'message');
  assert.equal(json.content[0].text, `Summary for ${SYNTHETIC_PHI.patientName}.`);
});

test('a wrong or missing token is refused before the body is read, and nothing is sent', async () => {
  const { base, sent } = await start();
  for (const headers of [{}, { authorization: 'Bearer nope' }, { 'x-api-key': `${TOKEN}x` }]) {
    const r = await post(base, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, headers);
    assert.equal(r.status, 401);
  }
  assert.equal(sent.length, 0);
});

test('an identifier in the system prompt refuses, and nothing is sent', async () => {
  const { base, sent } = await start();
  const { status, json } = await post(base, '/v1/chat/completions', {
    messages: [
      { role: 'system', content: `Write to ${SYNTHETIC_PHI.email} about the results.` },
      { role: 'user', content: buildRecordText() },
    ],
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, 'PROMPT_CONTAINS_SENSITIVE_DATA');
  assert.equal(sent.length, 0);
});

test('requests the proxy cannot govern are refused by name, never passed through', async () => {
  const { base, sent } = await start();
  const cases = [
    [{ stream: 'yes', messages: [{ role: 'user', content: 'x' }] }, 'BODY_MALFORMED'],
    [{ tools: [{}], messages: [{ role: 'user', content: 'x' }] }, 'TOOLS_UNSUPPORTED'],
    [{ n: 2, messages: [{ role: 'user', content: 'x' }] }, 'MULTIPLE_CHOICES_UNSUPPORTED'],
    [{ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }, 'ASSISTANT_PREFILL_UNSUPPORTED'],
    [{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }, 'CONTENT_UNSUPPORTED'],
    [{ model: 'someone-elses-model', messages: [{ role: 'user', content: 'x' }] }, 'MODEL_NOT_ALLOWED'],
    [{ messages: [] }, 'BODY_MALFORMED'],
  ];
  for (const [body, code] of cases) {
    const r = await post(base, '/v1/chat/completions', body);
    assert.equal(r.status, 400, code);
    assert.equal(r.json.error.code, code);
  }
  assert.equal(sent.length, 0);
});

test('stream:false and n:1 are accepted', () => {
  const p = parseChatRequest({ stream: false, n: 1, messages: [{ role: 'user', content: 'hello' }] }, 'openai');
  assert.equal(p.document, 'hello');
});

test('an oversized body refuses with 413', async () => {
  const { base, sent } = await start();
  const huge = 'a'.repeat(11 * 1024 * 1024);
  const r = await post(base, '/v1/chat/completions', { messages: [{ role: 'user', content: huge }] });
  assert.equal(r.status, 413);
  assert.equal(sent.length, 0);
});

test('withhold mode: an answer with an invented identifier is withheld after release', async () => {
  const { base } = await start({ scanResponse: { onFindings: 'withhold' }, answer: () => 'Call them at 615-555-0142.' });
  const { status, json } = await post(base, '/v1/chat/completions', { messages: [{ role: 'user', content: buildRecordText() }] });
  assert.equal(status, 422);
  assert.equal(json.error.code, 'RESPONSE_WITHHELD');
  assert.equal(json.strix.released, true, 'the release happened; only the answer was withheld');
  assert.ok(!JSON.stringify(json).includes('615-555-0142'));
});

test('a provider failure is a 502 that says what may have been disclosed', async () => {
  const proxyFail = await start({
    transportFor: () => ({ name: 'down', async send() { const e = new Error('boom'); e.kind = 'network'; throw e; } }),
  });
  const { status, json } = await post(proxyFail.base, '/v1/chat/completions', { messages: [{ role: 'user', content: buildRecordText() }] });
  assert.equal(status, 502);
  assert.equal(json.error.code, 'PROVIDER_ERROR');
  assert.ok(['possibly_disclosed', 'disclosed', 'not_disclosed'].includes(json.strix.disclosureStatus));
});

test('startup refuses a short token, an unknown provider, a malformed option, and a remote bind without TLS', async () => {
  assert.throws(() => createEgressProxy({ policy: HEALTHCARE_REFERENCE_POLICY, provider: 'anthropic', token: 'short' }));
  assert.throws(() => createEgressProxy({ policy: HEALTHCARE_REFERENCE_POLICY, provider: 'other', token: TOKEN }));
  assert.throws(() => createEgressProxy({ policy: HEALTHCARE_REFERENCE_POLICY, provider: 'anthropic', token: TOKEN, scanResponse: { onFindings: 'x' } }));
  const fake = () => ({ name: 'fake', async send() { return { responseText: 'x' }; } });
  const proxy = createEgressProxy({ policy: HEALTHCARE_REFERENCE_POLICY, provider: 'anthropic', token: TOKEN, transportFor: fake });
  assert.throws(() => proxy.listen({ port: 0, host: '0.0.0.0' }), /needs TLS/);
});

test('startup refuses a non-https provider base URL', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  try {
    assert.throws(() => createEgressProxy({ policy: HEALTHCARE_REFERENCE_POLICY, provider: 'anthropic', token: TOKEN, baseUrl: 'http://provider.internal' }));
    assert.doesNotThrow(() => createEgressProxy({ policy: HEALTHCARE_REFERENCE_POLICY, provider: 'anthropic', token: TOKEN, baseUrl: 'https://provider.internal' }));
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('startup refuses when the real provider key is missing, instead of failing the first request', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => createEgressProxy({ policy: HEALTHCARE_REFERENCE_POLICY, provider: 'anthropic', token: TOKEN }), /ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('healthz answers without auth and reveals no configuration beyond provider and model', async () => {
  const { base } = await start();
  const r = await fetch(`${base}/healthz`).then((x) => x.json());
  assert.deepEqual(Object.keys(r).sort(), ['model', 'ok', 'provider', 'proxy']);
});
