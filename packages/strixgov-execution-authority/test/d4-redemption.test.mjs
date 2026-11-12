/**
 * D4: ambiguous redemption and handler failure cannot produce a second
 * execution, and cannot be reported as a definite outcome the evidence does not
 * support.
 *
 * Against a fake Strix that keeps a consumption store and records every request.
 * The fake is a TEST DOUBLE for the wire contract. It signs with a key generated
 * here and is NOT Strix. Nothing here establishes that a real authority consumed
 * a grant or that any destination changed; those are separate observations.
 *
 * The properties counted, not inferred from a label:
 *   - consume is sent at most once per redemption attempt (no SDK retry);
 *   - the handler is entered exactly once, and only on PERMIT;
 *   - reconciliation issues only GET requests (read-only);
 *   - "not consumed" is concluded only from an authoritative FOUND answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';

const { StrixExecutionAuthorityClient, executeGoverned, buildProposal, canonicalJson, currentExecutionOf, canonicalSha256 } = await import('../dist/index.js');

const ISSUER = 'https://authority.strix.test';
const KID = 'strix-authority-test-2026-11';
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
const GRANT_ID = 'xg:d4-0001';
const ENC = encodeURIComponent(GRANT_ID);

function sign(payload) {
  const signature = crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64url');
  return { payload, signature, algorithm: 'Ed25519', canonicalization: 'strix-canonical-json-v1' };
}
const keySet = () => ({
  contractVersion: 1,
  purpose: 'strix-authority-grant',
  issuer: ISSUER,
  keys: [{ kty: 'OKP', crv: 'Ed25519', x, kid: KID, use: 'sig', alg: 'EdDSA', key_ops: ['verify'], purpose: 'strix-authority-grant', status: 'active', notBefore: '2020-01-01T00:00:00Z', notAfter: '2099-01-01T00:00:00Z' }],
});
function revocationDoc() {
  const now = Date.now();
  return sign({
    schemaVersion: 'strix-authority-revocation-v1',
    issuer: ISSUER,
    signingKeyId: KID,
    generation: 9,
    publishedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 5 * 60 * 1000).toISOString(),
    revokedGrantIds: [],
    revokedKeyIds: [],
  });
}
const proposal = () =>
  buildProposal({
    proposalId: 'xp:d4:refund-1',
    tenantId: 'oem-consumer-synthetic-01',
    principalId: 'agent:refund-assistant',
    action: 'payments.refund.issue',
    consequenceId: 'refund:d4:1',
    executionRoute: 'POST /refunds',
    payloadCommitment: canonicalSha256({ orderId: 'd4', amountCents: 1000 }),
    currentStateCommitment: canonicalSha256({ orderId: 'd4', captured: 1000 }),
    proposedAt: new Date('2026-11-10T12:00:00.000Z'),
  });
function grantFor(p) {
  const now = Date.now();
  return sign({
    schemaVersion: 'strix-execution-authority-v1',
    grantId: GRANT_ID,
    issuer: ISSUER,
    signingKeyId: KID,
    ...currentExecutionOf(p),
    strixDecisionId: 'cmd4decision0001',
    strixCapabilityId: 'execution.authority.grant',
    approvalsRequired: 2,
    approvalsGranted: 2,
    issuedAt: new Date(now - 1000).toISOString(),
    notBefore: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    singleUse: true,
  });
}

/**
 * A stateful fake Strix. `mode` decides what happens on the NEXT consume:
 *   'ok'            consume, answer CONSUMED
 *   'lost'          consume, then drop the connection (Strix DID consume)
 *   'drop'          drop the connection WITHOUT consuming (request never processed)
 *   'http:<n>'      answer status n with a problem body, WITHOUT consuming
 *   'malformed'     answer 200 with a body that is not a CONSUMED answer
 * Reads answer from the store; `readMode` can break the read path.
 */
function fakeStrix(state) {
  return (url, body) => {
    if (url === '/.well-known/strix-authority-keys.json') return { body: keySet() };
    if (url === '/api/public/authority/revocations') return { body: revocationDoc() };
    const consume = /^\/api\/v1\/authority\/grants\/([^/]+)\/consume$/.exec(url);
    if (consume) {
      const id = decodeURIComponent(consume[1]);
      if (state.consumed.has(id)) return { status: 409, body: { status: 'REFUSED', reasonCode: 'GRANT_ALREADY_CONSUMED', detail: 'this grant has already been consumed' } };
      const consumedAt = new Date().toISOString();
      const mode = state.mode;
      state.mode = 'ok';
      if (mode === 'ok') {
        state.consumed.set(id, { consumedAt, consumedBy: body.consumedBy });
        return { body: { status: 'CONSUMED', grantId: id, consumedAt, strixDecisionId: 'cmd4decision0001' } };
      }
      if (mode === 'lost') {
        state.consumed.set(id, { consumedAt, consumedBy: body.consumedBy });
        return 'DROP';
      }
      if (mode === 'drop') return 'DROP';
      if (mode === 'malformed') return { body: { status: 'PENDING' } };
      if (mode === 'conflict-no-reason') return { status: 409, body: { status: 'REFUSED' } };
      if (mode === 'conflict-bad-reason') return { status: 409, body: { status: 'REFUSED', reasonCode: 'already consumed', detail: 'x' } };
      if (mode === 'echo-other') {
        state.consumed.set(id, { consumedAt, consumedBy: body.consumedBy });
        return { body: { status: 'CONSUMED', grantId: 'xg:some-other-grant', consumedAt, strixDecisionId: 'cmd4decision0001' } };
      }
      const status = Number(mode.split(':')[1]);
      return { status, body: { error: { code: 'UPSTREAM', message: 'synthetic', status } } };
    }
    const status = /^\/api\/v1\/authority\/grants\/([^/]+)$/.exec(url);
    if (status) {
      const id = decodeURIComponent(status[1]);
      if (state.readMode === 'unavailable') return { status: 503, body: { error: { code: 'AUTHORITY_UNAVAILABLE', message: 'synthetic', status: 503 } } };
      if (state.readMode === 'malformed') return { body: { status: 'FOUND' } };
      if (state.readMode === 'bare-404') return { status: 404, body: {} };
      if (state.readMode === 'wrong-id') return { body: { status: 'FOUND', grantId: 'xg:other', strixDecisionId: 'cmd4decision0001', expiresAt: new Date(Date.now() + 60000).toISOString(), consumedAt: null, consumedBy: null, decisionState: 'EXECUTING' } };
      if (id !== GRANT_ID) return { status: 404, body: { error: { code: 'GRANT_NOT_FOUND', message: 'no grant', status: 404 } } };
      const rec = state.consumed.get(id);
      return {
        body: {
          status: 'FOUND',
          grantId: id,
          strixDecisionId: 'cmd4decision0001',
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          consumedAt: rec?.consumedAt ?? null,
          consumedBy: rec?.consumedBy ?? null,
          decisionState: 'EXECUTING',
          unresolvedReport: state.unresolved ?? null,
        },
      };
    }
    if (/\/outcome$/.test(url)) {
      // Mirrors the server policy: UNKNOWN is acknowledged, never recorded as terminal.
      return { body: { status: 'NOT_TERMINAL', strixDecisionId: 'cmd4decision0001', state: 'EXECUTING', reasonCode: 'UNKNOWN_OUTCOME_NOT_TERMINAL', grantId: GRANT_ID } };
    }
    return { status: 404, body: {} };
  };
}

async function withFake(state, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const parsed = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, body: parsed });
      const out = fakeStrix(state)(req.url, parsed);
      if (out === 'DROP') return req.socket.destroy();
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new StrixExecutionAuthorityClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 't', strixTenantId: 'tenant-1', issuer: ISSUER });
  try {
    return await fn({ client, seen });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const consumes = (seen) => seen.filter((r) => r.method === 'POST' && r.url.endsWith('/consume'));
const isAuthorityGrantPath = (u) => u.startsWith('/api/v1/authority/grants/');

test('a lost consume response is REDEMPTION_INDETERMINATE, sent exactly once, handler never entered', async () => {
  const state = { consumed: new Map(), mode: 'lost' };
  const p = proposal();
  await withFake(state, async ({ client, seen }) => {
    let entered = 0;
    const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', grant: grantFor(p), handler: async () => ((entered += 1), {}) });
    assert.equal(r.status, 'REDEMPTION_INDETERMINATE');
    assert.equal(r.handlerEntered, false);
    assert.equal(r.grantId, GRANT_ID);
    assert.equal(entered, 0, 'an ambiguous redemption must never enter the handler');
    assert.equal(consumes(seen).length, 1, 'the consume must be sent once: no SDK retry');
    assert.equal(seen.filter((x) => x.url.endsWith('/outcome')).length, 0, 'no outcome may be reported for an un-entered handler');
  });
});

test('after an ambiguous consume, reconciliation reads CONSUMED from Strix, and a second redemption is refused by Strix', async () => {
  const state = { consumed: new Map(), mode: 'lost' };
  const p = proposal();
  await withFake(state, async ({ client, seen }) => {
    const grant = grantFor(p);
    const first = await client.redeem(grant, currentExecutionOf(p), 'handler:1');
    assert.equal(first.status, 'REDEMPTION_INDETERMINATE');
    const rec = await client.reconcileRedemption(GRANT_ID);
    assert.equal(rec.status, 'CONSUMED', 'Strix recorded the consumption before the response was lost');
    assert.equal(rec.consumedBy, 'handler:1');
    // A later retry by the consumer must not produce a second permit.
    const replay = await client.redeem(grant, currentExecutionOf(p), 'handler:1');
    assert.equal(replay.status, 'REFUSE');
    assert.equal(replay.refusedBy, 'strix');
    assert.equal(replay.reasonCode, 'GRANT_ALREADY_CONSUMED');
    assert.equal(consumes(seen).length, 2, 'exactly the original attempt and one explicit replay, no hidden retry');
  });
});

test('a dropped connection with no server-side consumption reconciles to NOT_CONSUMED only via an authoritative read', async () => {
  const state = { consumed: new Map(), mode: 'drop' };
  const p = proposal();
  await withFake(state, async ({ client }) => {
    const first = await client.redeem(currentGrant(p), currentExecutionOf(p), 'handler:1');
    assert.equal(first.status, 'REDEMPTION_INDETERMINATE', 'we cannot tell from a dropped connection alone');
    const rec = await client.reconcileRedemption(GRANT_ID);
    assert.equal(rec.status, 'NOT_CONSUMED');
    assert.equal(rec.strixDecisionId, 'cmd4decision0001');
  });
});

test('reconciliation never concludes NOT_CONSUMED from a transport failure', async () => {
  const state = { consumed: new Map(), mode: 'ok', readMode: 'unavailable' };
  await withFake(state, async ({ client }) => {
    const rec = await client.reconcileRedemption(GRANT_ID);
    assert.equal(rec.status, 'UNKNOWN', 'an unreadable store is UNKNOWN, not NOT_CONSUMED');
    assert.notEqual(rec.status, 'NOT_CONSUMED');
  });
});

test('a malformed status answer is UNKNOWN, never NOT_CONSUMED', async () => {
  const state = { consumed: new Map(), mode: 'ok', readMode: 'malformed' };
  await withFake(state, async ({ client }) => {
    assert.equal((await client.reconcileRedemption(GRANT_ID)).status, 'UNKNOWN');
  });
});

test('reconciliation of an unknown grant id is NOT_FOUND and mutates nothing', async () => {
  const state = { consumed: new Map(), mode: 'ok' };
  await withFake(state, async ({ client, seen }) => {
    assert.equal((await client.reconcileRedemption('xg:never-issued')).status, 'NOT_FOUND');
    const grantCalls = seen.filter((x) => isAuthorityGrantPath(x.url) && !x.url.endsWith('/consume'));
    assert.ok(grantCalls.length >= 1);
    assert.ok(grantCalls.every((x) => x.method === 'GET'), 'reconciliation is read-only');
    assert.equal(state.consumed.size, 0);
  });
});

test('reconciliation issues only GET requests against the grant surface and consumes nothing', async () => {
  const state = { consumed: new Map([[GRANT_ID, { consumedAt: new Date().toISOString(), consumedBy: 'handler:1' }]]), mode: 'ok' };
  await withFake(state, async ({ client, seen }) => {
    const before = seen.length;
    const rec = await client.reconcileRedemption(GRANT_ID);
    assert.equal(rec.status, 'CONSUMED');
    const issued = seen.slice(before);
    assert.ok(issued.length >= 1);
    assert.ok(issued.every((x) => x.method === 'GET'), 'every request reconciliation issues is a GET');
    assert.ok(issued.every((x) => !x.url.endsWith('/consume') && !x.url.endsWith('/outcome')), 'reconciliation never consumes or reports');
  });
});

for (const [label, mode, expected] of [
  ['HTTP 500 after an unprocessed request', 'http:500', 'REDEMPTION_INDETERMINATE'],
  ['HTTP 503', 'http:503', 'REDEMPTION_INDETERMINATE'],
  ['HTTP 408 (a timeout is not a definite no)', 'http:408', 'REDEMPTION_INDETERMINATE'],
  ['a 200 that is not a CONSUMED answer', 'malformed', 'REDEMPTION_INDETERMINATE'],
  ['HTTP 400 (not a definite no: status alone never proves non-processing)', 'http:400', 'REDEMPTION_INDETERMINATE'],
]) {
  test(`${label} maps to ${expected}, handler never entered`, async () => {
    const state = { consumed: new Map(), mode };
    const p = proposal();
    await withFake(state, async ({ client }) => {
      let entered = 0;
      const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', grant: currentGrant(p), handler: async () => ((entered += 1), {}) });
      assert.equal(r.status, expected);
      assert.equal(r.handlerEntered, false);
      assert.equal(entered, 0);
    });
  });
}

test('a definite 409 REFUSED is a REFUSE, never an indeterminate redemption', async () => {
  const state = { consumed: new Map([[GRANT_ID, { consumedAt: new Date().toISOString(), consumedBy: 'other' }]]), mode: 'ok' };
  const p = proposal();
  await withFake(state, async ({ client }) => {
    const r = await client.redeem(currentGrant(p), currentExecutionOf(p), 'handler:1');
    assert.equal(r.status, 'REFUSE');
    assert.equal(r.reasonCode, 'GRANT_ALREADY_CONSUMED');
  });
});

test('a handler that throws after PERMIT leaves the consequence UNKNOWN, handler entered once, outcome reported as UNKNOWN', async () => {
  const state = { consumed: new Map(), mode: 'ok' };
  const p = proposal();
  await withFake(state, async ({ client, seen }) => {
    let entered = 0;
    const r = await executeGoverned({
      client,
      proposal: p,
      presenter: 'handler:1',
      grant: currentGrant(p),
      handler: async () => {
        entered += 1;
        throw new Error('timeout after the click landed');
      },
    });
    assert.equal(r.status, 'PERMIT_HANDLER_THREW');
    assert.equal(r.consequenceEstablished, false);
    assert.equal(r.handlerEntered, true);
    assert.equal(entered, 1, 'the handler is entered exactly once and never retried');
    const outcomes = seen.filter((x) => x.url.endsWith('/outcome')).map((x) => [x.body.outcome, x.body.handlerEntered]);
    assert.deepEqual(outcomes, [['UNKNOWN', true]]);
    assert.equal(r.outcome.status, 'NOT_TERMINAL', 'Strix does not record UNKNOWN as a terminal state');
  });
});

function currentGrant(p) {
  return grantFor(p);
}

// ─── Review findings (PR #2869): classification must rest on the body, and a
// reconciliation must never become an execution permit. ─────────────────────

for (const status of [401, 403, 404, 408, 410, 413, 415, 422, 429, 500, 502, 503]) {
  test(`HTTP ${status} with a Strix-shaped problem body is still INDETERMINATE: status alone proves nothing`, async () => {
    const state = { consumed: new Map(), mode: `http:${status}` };
    const p = proposal();
    await withFake(state, async ({ client, seen }) => {
      let entered = 0;
      const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', grant: currentGrant(p), handler: async () => ((entered += 1), {}) });
      assert.equal(r.status, 'REDEMPTION_INDETERMINATE');
      assert.equal(r.handlerEntered, false);
      assert.equal(entered, 0);
      assert.equal(consumes(seen).length, 1, 'no retry after an indeterminate consume');
    });
  });
}

for (const [label, mode] of [
  ['a 409 with no reason code', 'conflict-no-reason'],
  ['a 409 whose reason code is not in the refusal shape', 'conflict-bad-reason'],
]) {
  test(`${label} is INDETERMINATE, not a definite REFUSE`, async () => {
    const state = { consumed: new Map(), mode };
    const p = proposal();
    await withFake(state, async ({ client }) => {
      const r = await client.redeem(currentGrant(p), currentExecutionOf(p), 'handler:1');
      assert.equal(r.status, 'REDEMPTION_INDETERMINATE');
    });
  });
}

test('a 200 CONSUMED that echoes a different grant id is INDETERMINATE, never a PERMIT', async () => {
  const state = { consumed: new Map(), mode: 'echo-other' };
  const p = proposal();
  await withFake(state, async ({ client }) => {
    const r = await client.redeem(currentGrant(p), currentExecutionOf(p), 'handler:1');
    assert.notEqual(r.status, 'PERMIT');
    assert.equal(r.status, 'REDEMPTION_INDETERMINATE');
  });
});

test('reconciliation results carry the literal permitsExecution: false', async () => {
  const state = { consumed: new Map([[GRANT_ID, { consumedAt: new Date().toISOString(), consumedBy: 'handler:1' }]]), mode: 'ok' };
  await withFake(state, async ({ client }) => {
    const consumed = await client.reconcileRedemption(GRANT_ID);
    const missing = await client.reconcileRedemption('xg:never-issued');
    assert.equal(consumed.status, 'CONSUMED');
    assert.equal(consumed.permitsExecution, false);
    assert.equal(missing.permitsExecution, false);
  });
});

test('a 404 without the GRANT_NOT_FOUND code is UNKNOWN, never NOT_FOUND', async () => {
  const state = { consumed: new Map(), mode: 'ok', readMode: 'bare-404' };
  await withFake(state, async ({ client }) => {
    assert.equal((await client.reconcileRedemption(GRANT_ID)).status, 'UNKNOWN');
  });
});

test('a FOUND answer for a different grant id is UNKNOWN, never CONSUMED or NOT_CONSUMED', async () => {
  const state = { consumed: new Map(), mode: 'ok', readMode: 'wrong-id' };
  await withFake(state, async ({ client }) => {
    const rec = await client.reconcileRedemption(GRANT_ID);
    assert.equal(rec.status, 'UNKNOWN');
  });
});

test('CONSUMED reconciliation does NOT authorize execution: the handler stays unentered and the grant is refused', async () => {
  // Lost response, but Strix recorded the consumption. The consumer then
  // reconciles and gets CONSUMED. It must still not be able to run the handler.
  const state = { consumed: new Map(), mode: 'lost' };
  const p = proposal();
  await withFake(state, async ({ client, seen }) => {
    const grant = currentGrant(p);
    assert.equal((await executeGoverned({ client, proposal: p, presenter: 'handler:1', grant, handler: async () => ({}) })).status, 'REDEMPTION_INDETERMINATE');
    const rec = await client.reconcileRedemption(GRANT_ID);
    assert.equal(rec.status, 'CONSUMED');
    assert.equal(rec.permitsExecution, false);
    let entered = 0;
    const later = await executeGoverned({ client, proposal: p, presenter: 'handler:1', grant, handler: async () => ((entered += 1), {}) });
    assert.equal(later.status, 'REFUSE', 'a consumed grant cannot be redeemed again to enter a handler');
    assert.equal(later.refusedBy, 'strix');
    assert.equal(later.reasonCode, 'GRANT_ALREADY_CONSUMED');
    assert.equal(later.handlerEntered, false);
    assert.equal(entered, 0);
    assert.equal(seen.filter((x) => x.url.endsWith('/outcome')).length, 0, 'no outcome is reported for a handler that never ran');
  });
});

test('only redeem() issues a consume request, and reconciliation code cannot reach the handler path', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8');
  const adapter = readFileSync(new URL('../dist/adapter.js', import.meta.url), 'utf8');
  const adapterDts = readFileSync(new URL('../dist/adapter.d.ts', import.meta.url), 'utf8');
  assert.equal(client.split('/consume`').length - 1, 1, 'exactly one consume call site');
  assert.ok(!/reconcil/i.test(adapter), 'the adapter never references reconciliation');
  // Only the input interface matters: the prose in the result types may mention reconciliation.
  const input = adapterDts.slice(adapterDts.indexOf('export interface ExecuteGovernedInput'), adapterDts.indexOf('export declare function executeGoverned'));
  assert.ok(input.length > 100, 'the input interface was located');
  assert.ok(!/reconcil/i.test(input), 'the adapter input type accepts no reconciliation result');
});

test('reconciliation surfaces a durably recorded unresolved attempt, and it still grants no permission', async () => {
  const state = { consumed: new Map([[GRANT_ID, { consumedAt: new Date().toISOString(), consumedBy: 'handler:1' }]]), mode: 'ok', unresolved: { reportedAt: '2026-11-10T12:30:00.000Z', reportedBy: 'handler:1' } };
  await withFake(state, async ({ client }) => {
    const rec = await client.reconcileRedemption(GRANT_ID);
    assert.equal(rec.status, 'CONSUMED');
    assert.deepEqual(rec.unresolvedAttempt, { reportedAt: '2026-11-10T12:30:00.000Z', reportedBy: 'handler:1' });
    assert.equal(rec.permitsExecution, false, 'an unresolved attempt is a record, never an execution permit');
  });
});

