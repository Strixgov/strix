/**
 * governedOpenAiDocumentRequest — end-to-end adapter tests, the OpenAI
 * sibling of test/adapter-anthropic.test.mjs. Same discipline: the
 * transport is injected (a spy, or the REAL transport module over a fake
 * fetch) so these run air-gapped — no network, no API key, and the
 * provider-call count is measured, never assumed.
 *
 * This suite exists to PROVE the pipeline is provider-agnostic, not just
 * to add a second provider's coverage: every assertion here mirrors its
 * Anthropic counterpart so a divergence in outcome, not merely in wire
 * shape, would fail loudly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  governedOpenAiDocumentRequest,
  EGRESS_CAPABILITY_ID,
  OPENAI_DESTINATION,
} from '../src/adapters/openai/index.mjs';
import { createOpenAiChatTransport, TransportError, DEFAULT_OPENAI_MODEL } from '../src/adapters/openai/transport.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../src/evidence/log.mjs';
import { RECEIPT_PROVES } from '../src/evidence/receipt.mjs';
import { deepFreeze } from '../src/policy/policy.mjs';
import { buildRecordText, buildCleanText, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const PROMPT = 'Summarize the encounter and list any abnormal results.';

// Deliberately a SEPARATE policy object from HEALTHCARE_REFERENCE_POLICY, never a
// mutated clone of it: HEALTHCARE_REFERENCE_POLICY is a named customer pilot's own
// explicit, previously-scoped rule set ("raw PHI never reaches Claude").
// Silently widening that named pilot's destinations to add a second
// provider it never approved would be exactly the scope creep this
// repo's own discipline warns against — a new provider is opted in by a
// policy author explicitly, per tenant, never inherited by a code change.
const OPENAI_TEST_POLICY = deepFreeze({
  policyId: 'openai-adapter-test-policy',
  policyVersion: '0.1.0',
  dataEgress: {
    externalAI: {
      default: 'deny',
      phi: {
        action: 'sanitize',
        requirePostTransformVerification: true,
        failClosed: true,
      },
      destinations: {
        openai: {
          enabled: true,
          allowedData: ['deidentified', 'non_sensitive'],
        },
      },
    },
  },
});

function makeDeps() {
  return {
    detector: createPatternDetector(),
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
  };
}

function spyTransport(result = { responseText: 'Routine encounter; all results within reference ranges.' }) {
  const calls = [];
  return {
    name: 'spy',
    calls,
    async send(payload) {
      calls.push(payload);
      return result;
    },
  };
}

test('SANITIZE end-to-end (OpenAI): PHI document is de-identified, released once, and the response returns', async () => {
  const deps = makeDeps();
  const transport = spyTransport();
  const result = await governedOpenAiDocumentRequest({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    actor: 'analyst@healthcare.example',
    policy: OPENAI_TEST_POLICY,
    deps,
    transport,
  });

  assert.equal(result.released, true);
  assert.equal(result.decision, 'SANITIZE');
  assert.equal(result.execution, 'completed');
  assert.equal(result.disclosureStatus, 'disclosed');
  assert.equal(result.response, 'Routine encounter; all results within reference ranges.');
  assert.equal(transport.calls.length, 1, 'exactly one provider call');

  const sent = transport.calls[0];
  assert.equal(sent.prompt, PROMPT);
  assert.match(sent.documentText, /\[PATIENT_\d{3}\]/, 'the transmitted document is the tokenized form');
  for (const value of Object.values(SYNTHETIC_PHI)) {
    assert.ok(
      !sent.documentText.toLowerCase().includes(String(value).toLowerCase()),
      `raw identifier reached the transport payload: ${value}`,
    );
  }

  const r = result.receipt;
  assert.equal(r.capability, EGRESS_CAPABILITY_ID);
  assert.equal(r.decision, 'SANITIZE');
  assert.equal(r.initialClassification, 'phi_detected');
  assert.equal(r.classification, 'deidentified');
  assert.match(r.originalArtifactHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(r.releasedArtifactHash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(r.originalArtifactHash, r.releasedArtifactHash);
  assert.match(r.promptHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.transformation.result, 'deidentified');
  assert.equal(r.verification.result, 'passed');
  assert.equal(r.verification.remainingProhibitedFindings, 0);
  assert.match(r.authorizationBinding, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(r.destination, { ...OPENAI_DESTINATION });
  assert.equal(r.execution, 'completed');
  assert.equal(r.disclosureStatus, 'disclosed');
  assert.equal(r.policy.policyId, OPENAI_TEST_POLICY.policyId);
  assert.equal(r.proves, RECEIPT_PROVES, 'the receipt states its own ceiling: an unsigned local record');
});

test('ALLOW end-to-end (OpenAI): a clean document releases unchanged with no transformation block', async () => {
  const deps = makeDeps();
  const transport = spyTransport();
  const clean = buildCleanText();
  const result = await governedOpenAiDocumentRequest({
    source: { text: clean },
    prompt: PROMPT,
    policy: OPENAI_TEST_POLICY,
    deps,
    transport,
  });

  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.released, true);
  assert.equal(transport.calls[0].documentText, clean, 'a clean document releases byte-identical');
  assert.equal(result.receipt.classification, 'clear');
  assert.equal(result.receipt.transformation, undefined);
  assert.equal(result.receipt.originalArtifactHash, result.receipt.releasedArtifactHash);
});

test('DENY end-to-end (OpenAI): a deny-PHI policy refuses with the transport never constructed or invoked', async () => {
  const deps = makeDeps();
  const transport = spyTransport();
  const denyPolicy = structuredClone(OPENAI_TEST_POLICY);
  denyPolicy.dataEgress.externalAI.phi.action = 'deny';
  denyPolicy.dataEgress.externalAI.phi.requirePostTransformVerification = false;

  const result = await governedOpenAiDocumentRequest({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    policy: denyPolicy,
    deps,
    transport,
  });

  assert.equal(result.released, false);
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'PHI_EGRESS_DENIED_BY_POLICY');
  assert.equal(transport.calls.length, 0);
  assert.equal(result.receipt.execution, 'not_attempted');
  assert.equal(result.receipt.disclosureStatus, 'not_disclosed');
});

test('unconfigured deployment (OpenAI): no injected transport + no API key throws BEFORE any provider I/O, authorization unspent', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const deps = makeDeps();
    await assert.rejects(
      governedOpenAiDocumentRequest({
        source: { text: buildRecordText() },
        prompt: PROMPT,
        policy: OPENAI_TEST_POLICY,
        deps,
      }),
      (err) => err instanceof TransportError && err.kind === 'unconfigured',
    );
    const entries = deps.evidence.list();
    assert.equal(entries.filter((e) => e.type === 'egress_attempt').length, 0);
    assert.equal(entries.filter((e) => e.type === 'egress_outcome').length, 0);
    const authorized = entries.find((e) => e.type === 'egress_authorized');
    assert.ok(authorized, 'the authorization record exists');
    const auth = deps.store.get(authorized.authorizationId);
    assert.equal(auth.consumedAt, undefined, 'the authorization was never consumed');
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

test('the REAL OpenAI transport composes the wire body from exactly the gate-verified pieces (fake fetch)', async () => {
  const deps = makeDeps();
  const requests = [];
  const transport = createOpenAiChatTransport({
    apiKey: 'test-key-never-logged',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        headers: { get: () => 'req_test_1' },
        async json() {
          return {
            model: DEFAULT_OPENAI_MODEL,
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      };
    },
  });

  const result = await governedOpenAiDocumentRequest({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    policy: OPENAI_TEST_POLICY,
    deps,
    transport,
  });

  assert.equal(result.released, true);
  assert.equal(result.response, 'ok');
  assert.equal(result.providerMeta.requestId, 'req_test_1');
  assert.equal(requests.length, 1);

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.messages.length, 1, 'one fixed-template user message; no injectable extra content');
  const content = body.messages[0].content;
  assert.ok(content.includes(PROMPT));
  assert.match(content, /\[MRN_\d{3}\]/, 'the wire body carries the tokenized document');
  for (const value of Object.values(SYNTHETIC_PHI)) {
    assert.ok(
      !content.toLowerCase().includes(String(value).toLowerCase()),
      `raw identifier reached the wire body: ${value}`,
    );
  }
});

test('an HTTP-refused OpenAI call is honest: released=false, execution failed, disclosure DISCLOSED', async () => {
  const deps = makeDeps();
  const transport = createOpenAiChatTransport({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      async text() {
        return '{"error":{"type":"rate_limit_exceeded"}}';
      },
    }),
  });

  const result = await governedOpenAiDocumentRequest({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    policy: OPENAI_TEST_POLICY,
    deps,
    transport,
  });

  assert.equal(result.released, false);
  assert.equal(result.decision, 'SANITIZE', 'the authorization verdict is unchanged — execution is a separate axis');
  assert.equal(result.execution, 'failed');
  assert.equal(result.disclosureStatus, 'disclosed', 'the provider received the payload and refused the request');
  const outcome = deps.evidence.list().find((e) => e.type === 'egress_outcome');
  assert.equal(outcome.transportError.kind, 'http');
  assert.ok(!JSON.stringify(deps.evidence.list()).includes('test-key'), 'the API key never enters evidence');
});

// ─────────────────────────────────────────────────────────────────────────────
// testConnection — the credential readiness probe, mirroring the sibling
// transport's for the same reason: it lives here because the credential
// does, and a probe built elsewhere would be a second implementation of
// provider authentication.
// ─────────────────────────────────────────────────────────────────────────────

test('testConnection (OpenAI) presents the credential and probes models, never chat completions', async () => {
  const seen = [];
  const transport = createOpenAiChatTransport({
    apiKey: 'probe-key',
    baseUrl: 'https://api.example.invalid',
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
      return { ok: true, status: 200, statusText: 'OK', async text() { return '{"data":[]}'; } };
    },
  });

  const obs = await transport.testConnection();
  assert.equal(obs.reached, true);
  assert.equal(obs.status, 200);
  assert.equal(obs.probedUrl, 'https://api.example.invalid/v1/models');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].headers.authorization, 'Bearer probe-key');
  assert.ok(!seen[0].url.includes('/v1/chat/completions'));
  assert.equal(seen[0].body, undefined, 'the probe sends no body, so no content can ride it');
});

test('testConnection (OpenAI) RETURNS a 401 rather than throwing — for a probe the refusal is the answer', async () => {
  const transport = createOpenAiChatTransport({
    apiKey: 'wrong-key',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      async text() { return '{"error":{"message":"Incorrect API key provided"}}'; },
    }),
  });

  const obs = await transport.testConnection();
  assert.equal(obs.reached, true, 'bytes reached the provider and came back');
  assert.equal(obs.status, 401);
  assert.ok(obs.bodySnippet.includes('Incorrect API key'), 'the provider says WHY, the only thing distinguishing two 401s');
  assert.equal(obs.state, undefined);
  assert.equal(obs.ok, undefined);
});

test('testConnection (OpenAI) distinguishes a timeout from a refused connection, and never carries the credential', async () => {
  const timedOut = createOpenAiChatTransport({
    apiKey: 'probe-key',
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });
  const refused = createOpenAiChatTransport({
    apiKey: 'probe-key',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });

  const t = await timedOut.testConnection();
  const r = await refused.testConnection();
  assert.equal(t.reached, false);
  assert.equal(t.kind, 'timeout');
  assert.equal(r.reached, false);
  assert.equal(r.kind, 'network');
  for (const obs of [t, r]) {
    assert.ok(!JSON.stringify(obs).includes('probe-key'), 'the observation never carries the credential');
  }
});

test('an unconfigured OpenAI transport cannot be probed — it never constructs', () => {
  assert.throws(
    () => createOpenAiChatTransport({ apiKey: '' }),
    (err) => err instanceof TransportError && err.kind === 'unconfigured',
  );
});

test('a malformed baseUrl (not an absolute URL) is refused at construction — never a silent misroute', () => {
  assert.throws(
    () => createOpenAiChatTransport({ apiKey: 'probe-key', baseUrl: 'not-a-url' }),
    (err) => err instanceof TransportError && err.kind === 'unconfigured' && /baseUrl must be an absolute URL/.test(err.message),
  );
});

test('a well-formed but non-https baseUrl is refused at construction, even http', () => {
  assert.throws(
    () => createOpenAiChatTransport({ apiKey: 'probe-key', baseUrl: 'http://api.openai.com' }),
    (err) => err instanceof TransportError && err.kind === 'unconfigured' && /baseUrl must be https/.test(err.message),
  );
});

test('a valid https baseUrl constructs, and the resolved endpoint is reported off the ACTUAL configuration, not a constant', () => {
  const t = createOpenAiChatTransport({ apiKey: 'probe-key', baseUrl: 'https://api.example.invalid' });
  assert.equal(t.endpoint.baseUrl, 'https://api.example.invalid');
  assert.ok(!JSON.stringify(t.endpoint).includes('probe-key'));
});

test('the default baseUrl (no override) is https and matches the documented default', () => {
  const t = createOpenAiChatTransport({ apiKey: 'probe-key' });
  assert.equal(t.endpoint.baseUrl, 'https://api.openai.com');
});

test('the request body carries max_completion_tokens, never the deprecated max_tokens', async () => {
  // NOT a shape preference. `DEFAULT_OPENAI_MODEL` is a model whose Chat
  // Completions endpoint REJECTS `max_tokens` outright with an HTTP 400, so
  // a transport sending it would have failed on its first real release while
  // every test here passed — a mock fetch accepts whichever field it is
  // handed, so the double is exactly what hides this class of defect.
  //
  // The assertion is therefore two-sided: the supported field must be
  // present AND the deprecated one must be absent. Asserting only the first
  // would still pass if both were sent, which is the state the provider
  // refuses.
  const requests = [];
  const transport = createOpenAiChatTransport({
    apiKey: 'test-key-never-logged',
    maxTokens: 777,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        headers: { get: () => 'req_test_limit' },
        async json() {
          return {
            model: DEFAULT_OPENAI_MODEL,
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          };
        },
      };
    },
  });

  await transport.send({ documentText: 'a document', prompt: PROMPT });

  assert.equal(requests.length, 1, 'expected exactly one provider call');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.max_completion_tokens, 777, 'the configured limit must reach the provider');
  assert.ok(
    !('max_tokens' in body),
    'max_tokens is rejected by the default model — sending it alongside the supported field still 400s',
  );
  assert.equal(body.model, DEFAULT_OPENAI_MODEL);
});
