/**
 * governedAnthropicDocumentRequest — end-to-end adapter tests (spec §9).
 *
 * The transport is injected (a spy, or the REAL transport module over a
 * fake fetch) so these run air-gapped: no network, no API key, and the
 * provider-call count is measured, never assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  governedAnthropicDocumentRequest,
  EGRESS_CAPABILITY_ID,
  ANTHROPIC_DESTINATION,
} from '../src/adapters/anthropic/index.mjs';
import { createAnthropicMessagesTransport, TransportError, ANTHROPIC_API_VERSION } from '../src/adapters/anthropic/transport.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../src/evidence/log.mjs';
import { RECEIPT_PROVES } from '../src/evidence/receipt.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { buildRecordText, buildCleanText, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const PROMPT = 'Summarize the encounter and list any abnormal results.';

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

test('SANITIZE end-to-end: PHI document is de-identified, released once, and the response returns', async () => {
  const deps = makeDeps();
  const transport = spyTransport();
  const result = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    actor: 'analyst@healthcare.example',
    policy: HEALTHCARE_REFERENCE_POLICY,
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

  // Receipt (spec §11): identifiers by hash, counts and verdicts only.
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
  assert.equal(r.transformation.findings, r.transformation.transformed);
  assert.equal(r.verification.result, 'passed');
  assert.equal(r.verification.remainingProhibitedFindings, 0);
  assert.match(r.authorizationBinding, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(r.destination, { ...ANTHROPIC_DESTINATION });
  assert.equal(r.execution, 'completed');
  assert.equal(r.disclosureStatus, 'disclosed');
  assert.equal(r.policy.policyId, HEALTHCARE_REFERENCE_POLICY.policyId);
  assert.equal(r.proves, RECEIPT_PROVES, 'the receipt states its own ceiling: an unsigned local record');
});

test('ALLOW end-to-end: a clean document releases unchanged with no transformation block', async () => {
  const deps = makeDeps();
  const transport = spyTransport();
  const clean = buildCleanText();
  const result = await governedAnthropicDocumentRequest({
    source: { text: clean },
    prompt: PROMPT,
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps,
    transport,
  });

  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.released, true);
  assert.equal(transport.calls[0].documentText, clean, 'a clean document releases byte-identical');
  assert.equal(result.receipt.classification, 'clear');
  assert.equal(result.receipt.transformation, undefined);
  assert.equal(result.receipt.verification.result, 'passed');
  assert.equal(result.receipt.originalArtifactHash, result.receipt.releasedArtifactHash);
});

test('DENY end-to-end: a deny-PHI policy refuses with the transport never constructed or invoked', async () => {
  const deps = makeDeps();
  const transport = spyTransport();
  const denyPolicy = structuredClone(HEALTHCARE_REFERENCE_POLICY);
  denyPolicy.dataEgress.externalAI.phi.action = 'deny';
  denyPolicy.dataEgress.externalAI.phi.requirePostTransformVerification = false; // only required when action === 'sanitize'

  const result = await governedAnthropicDocumentRequest({
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

test('unconfigured deployment: no injected transport + no API key throws BEFORE any provider I/O, authorization unspent', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const deps = makeDeps();
    await assert.rejects(
      governedAnthropicDocumentRequest({
        source: { text: buildRecordText() },
        prompt: PROMPT,
        policy: HEALTHCARE_REFERENCE_POLICY,
        deps,
      }),
      (err) => err instanceof TransportError && err.kind === 'unconfigured',
    );
    // The pipeline authorized, then the construction throw stopped everything
    // strictly before the gate: no attempt evidence, and the minted
    // authorization was never consumed (it expires harmlessly).
    const entries = deps.evidence.list();
    assert.equal(entries.filter((e) => e.type === 'egress_attempt').length, 0);
    assert.equal(entries.filter((e) => e.type === 'egress_outcome').length, 0);
    const authorized = entries.find((e) => e.type === 'egress_authorized');
    assert.ok(authorized, 'the authorization record exists');
    const auth = deps.store.get(authorized.authorizationId);
    assert.equal(auth.consumedAt, undefined, 'the authorization was never consumed');
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('the REAL transport composes the wire body from exactly the gate-verified pieces (fake fetch)', async () => {
  const deps = makeDeps();
  const requests = [];
  const transport = createAnthropicMessagesTransport({
    apiKey: 'test-key-never-logged',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        headers: { get: () => 'req_test_1' },
        async json() {
          return {
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{ type: 'text', text: 'ok' }],
          };
        },
      };
    },
  });

  const result = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    policy: HEALTHCARE_REFERENCE_POLICY,
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

test('an HTTP-refused provider call is honest: released=false, execution failed, disclosure DISCLOSED', async () => {
  const deps = makeDeps();
  const transport = createAnthropicMessagesTransport({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      async text() {
        return '{"type":"error","error":{"type":"rate_limit_error"}}';
      },
    }),
  });

  const result = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    policy: HEALTHCARE_REFERENCE_POLICY,
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
// testConnection — the credential readiness probe (§3 of the productization
// scope). It lives on the transport because the credential does; a probe in a
// product layer would be a second implementation of provider authentication.
// ─────────────────────────────────────────────────────────────────────────────

test('testConnection presents the credential and probes models, never messages', async () => {
  const seen = [];
  const transport = createAnthropicMessagesTransport({
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
  // The same auth headers `send` builds, from the same closed-over key.
  assert.equal(seen[0].headers['x-api-key'], 'probe-key');
  assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  // It authenticates WITHOUT inferring: no completion, and no body at all.
  assert.ok(!seen[0].url.includes('/v1/messages'));
  assert.equal(seen[0].body, undefined, 'the probe sends no body, so no content can ride it');
});

test('testConnection RETURNS a 401 rather than throwing — for a probe the refusal is the answer', async () => {
  const transport = createAnthropicMessagesTransport({
    apiKey: 'wrong-key',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      async text() { return '{"error":{"message":"invalid x-api-key"}}'; },
    }),
  });

  // `send` throws TransportError('http') here, deliberately: for a release a
  // non-2xx IS the failure. A probe must not hand its classification to
  // whatever try/catch happens to be nearest.
  const obs = await transport.testConnection();
  assert.equal(obs.reached, true, 'bytes reached the provider and came back');
  assert.equal(obs.status, 401);
  assert.ok(obs.bodySnippet.includes('invalid x-api-key'), 'the provider says WHY, and that is the only thing distinguishing two 401s');
  // No verdict on the observation: classification is the caller's judgment.
  assert.equal(obs.state, undefined);
  assert.equal(obs.ok, undefined);
});

test('testConnection distinguishes a timeout from a refused connection, and never carries the credential', async () => {
  const timedOut = createAnthropicMessagesTransport({
    apiKey: 'probe-key',
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });
  const refused = createAnthropicMessagesTransport({
    apiKey: 'probe-key',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });

  const t = await timedOut.testConnection();
  const r = await refused.testConnection();
  // Timeout may have reached the provider; a refusal provably did not.
  assert.equal(t.reached, false);
  assert.equal(t.kind, 'timeout');
  assert.equal(r.reached, false);
  assert.equal(r.kind, 'network');
  for (const obs of [t, r]) {
    assert.ok(!JSON.stringify(obs).includes('probe-key'), 'the observation never carries the credential');
  }
});

test('an unconfigured transport cannot be probed — it never constructs', () => {
  assert.throws(
    () => createAnthropicMessagesTransport({ apiKey: '' }),
    (err) => err instanceof TransportError && err.kind === 'unconfigured',
  );
});

test('a malformed baseUrl (not an absolute URL) is refused at construction — never a silent misroute', () => {
  assert.throws(
    () => createAnthropicMessagesTransport({ apiKey: 'probe-key', baseUrl: 'not-a-url' }),
    (err) => err instanceof TransportError && err.kind === 'unconfigured' && /baseUrl must be an absolute URL/.test(err.message),
  );
});

test('a well-formed but non-https baseUrl is refused at construction, even http', () => {
  assert.throws(
    () => createAnthropicMessagesTransport({ apiKey: 'probe-key', baseUrl: 'http://api.anthropic.com' }),
    (err) => err instanceof TransportError && err.kind === 'unconfigured' && /baseUrl must be https/.test(err.message),
  );
});

test('a valid https baseUrl constructs, and the resolved endpoint is reported off the ACTUAL configuration, not a constant', () => {
  const t = createAnthropicMessagesTransport({ apiKey: 'probe-key', baseUrl: 'https://api.example.invalid' });
  assert.equal(t.endpoint.baseUrl, 'https://api.example.invalid');
  assert.equal(t.endpoint.apiVersion, ANTHROPIC_API_VERSION);
  // The endpoint object never carries the credential — it is handed to callers.
  assert.ok(!JSON.stringify(t.endpoint).includes('probe-key'));
});

test('the default baseUrl (no override) is https and matches the documented default', () => {
  const t = createAnthropicMessagesTransport({ apiKey: 'probe-key' });
  assert.equal(t.endpoint.baseUrl, 'https://api.anthropic.com');
});
