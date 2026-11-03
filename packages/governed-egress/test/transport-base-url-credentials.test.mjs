/**
 * The transport `baseUrl` guard — one rule, both providers.
 *
 * WHAT THIS EXISTS TO PREVENT, stated once so a future reader does not have
 * to reconstruct it: `types.d.ts` promises that a transport's `endpoint`
 * object "Never carries a credential", and until this guard landed nothing
 * enforced it. A URL may carry userinfo, `https://user:secret@host`, and
 * that form passes a protocol-only check. The resolved `baseUrl` is
 * published on `adapter.endpoint`, and `kernel-gate.mjs`'s `endpointFields`
 * copies that object VERBATIM into both the attempt and the outcome evidence
 * entries — before the request is sent. So the field added to make the real
 * destination visible would have written a proxy credential into the
 * evidence log, and left it there even if `fetch` went on to reject the URL.
 *
 * Both transports are covered by every case deliberately. They are
 * field-for-field mirrors, the Anthropic one is the transport in production
 * use, and a guard proven on one sibling is not a guard on the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiChatTransport } from '../src/adapters/openai/transport.mjs';
import { createAnthropicMessagesTransport } from '../src/adapters/anthropic/transport.mjs';

const TRANSPORTS = [
  ['openai', createOpenAiChatTransport],
  ['anthropic', createAnthropicMessagesTransport],
];

// A value that would be a working credential if it ever reached the wire or
// a log. Asserted absent from every refusal message below.
const SECRET = 'sk-not-a-real-secret-value';

function refusalOf(factory, baseUrl) {
  try {
    factory({ apiKey: 'test-key', baseUrl });
    return null;
  } catch (err) {
    return err;
  }
}

for (const [name, factory] of TRANSPORTS) {
  test(`${name}: refuses a baseUrl carrying userinfo, at construction`, () => {
    const err = refusalOf(factory, `https://user:${SECRET}@proxy.example`);
    assert.ok(err, 'expected the transport to refuse to construct');
    assert.equal(err.kind, 'unconfigured');
    assert.match(err.message, /must not carry credentials/);
  });

  test(`${name}: the refusal message does not echo the credential`, () => {
    // The whole point of the branch is that the value contains a secret;
    // a refusal that prints it moves the leak from evidence into the logs.
    const err = refusalOf(factory, `https://user:${SECRET}@proxy.example`);
    assert.ok(err);
    assert.ok(!err.message.includes(SECRET), `refusal message leaked the credential: ${err.message}`);
    // A bare username is still userinfo and still refused.
    const userOnly = refusalOf(factory, 'https://someuser@proxy.example');
    assert.ok(userOnly, 'a username with no password is still userinfo');
    assert.equal(userOnly.kind, 'unconfigured');
  });

  test(`${name}: refuses a baseUrl carrying a query string or fragment`, () => {
    const q = refusalOf(factory, `https://proxy.example?token=${SECRET}`);
    assert.ok(q);
    assert.equal(q.kind, 'unconfigured');
    assert.ok(!q.message.includes(SECRET), 'query refusal leaked the value');
    const h = refusalOf(factory, 'https://proxy.example#frag');
    assert.ok(h);
    assert.equal(h.kind, 'unconfigured');
  });

  test(`${name}: still refuses non-https and unparseable, unchanged`, () => {
    assert.equal(refusalOf(factory, 'http://api.example')?.kind, 'unconfigured');
    assert.equal(refusalOf(factory, 'not-a-url')?.kind, 'unconfigured');
  });

  test(`${name}: a clean https baseUrl constructs and its endpoint carries no credential`, () => {
    const t = factory({ apiKey: SECRET, baseUrl: 'https://api.example' });
    assert.equal(t.endpoint.baseUrl, 'https://api.example');
    // The API key is a separate leak path from the URL, and both are closed:
    // nothing on the returned object may carry it, because this object is
    // handed to callers and `endpoint` is copied into evidence.
    assert.ok(!JSON.stringify(t.endpoint).includes(SECRET), 'endpoint carried the API key');
  });
}

test('endpoint.apiVersion is provider-optional, which is why the type may not require it', () => {
  // This is the runtime fact behind the `apiVersion?:` declaration. Anthropic
  // versions its Messages API by a dated header and reports one; OpenAI's
  // Chat Completions has no equivalent, so it reports none. A test that
  // demanded both would be pressure to invent an OpenAI version to satisfy a
  // type — fabricating a fact about the provider.
  const anthropic = createAnthropicMessagesTransport({ apiKey: 'k', baseUrl: 'https://api.example' });
  const openai = createOpenAiChatTransport({ apiKey: 'k', baseUrl: 'https://api.example' });
  assert.equal(typeof anthropic.endpoint.apiVersion, 'string');
  assert.equal(openai.endpoint.apiVersion, undefined);
  assert.equal(typeof openai.endpoint.baseUrl, 'string');
});
