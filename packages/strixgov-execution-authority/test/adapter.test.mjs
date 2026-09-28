/**
 * The non-bypass contract of the reference adapter, against a real local HTTP
 * server standing in for Strix.
 *
 * The property under test is negative and is counted, never inferred from a
 * status: on every path except PERMIT the handler is entered ZERO times. The
 * counter lives in the test, outside the SDK, so a bug that reported REFUSE
 * after running the handler would be caught by the count, not by the label.
 *
 * The fake Strix signs grants with a key generated here and publishes a key
 * set and a signed revocation document in the real wire shapes. Cross-
 * implementation agreement on those bytes is the corpus test's job; this file
 * tests the adapter's ordering and its refusal to run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';

const { StrixExecutionAuthorityClient, executeGoverned, governedTool, buildProposal, canonicalJson, currentExecutionOf, canonicalSha256 } = await import('../dist/index.js');

const ISSUER = 'https://authority.strix.test';
const KID = 'strix-authority-test-2026-09';
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const attacker = crypto.generateKeyPairSync('ed25519');
const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');

function sign(payload, key = privateKey) {
  const signature = crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), key).toString('base64url');
  return { payload, signature, algorithm: 'Ed25519', canonicalization: 'strix-canonical-json-v1' };
}

function keySet(status = 'active') {
  return {
    contractVersion: 1,
    purpose: 'strix-authority-grant',
    issuer: ISSUER,
    keys: [{ kty: 'OKP', crv: 'Ed25519', x, kid: KID, use: 'sig', alg: 'EdDSA', key_ops: ['verify'], purpose: 'strix-authority-grant', status, notBefore: '2020-01-01T00:00:00Z', notAfter: '2099-01-01T00:00:00Z' }],
  };
}

function revocationDoc(over = {}) {
  const now = Date.now();
  return sign({
    schemaVersion: 'strix-authority-revocation-v1',
    issuer: ISSUER,
    signingKeyId: KID,
    generation: 7,
    publishedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 5 * 60 * 1000).toISOString(),
    revokedGrantIds: [],
    revokedKeyIds: [],
    ...over,
  });
}

const proposal = () =>
  buildProposal({
    proposalId: 'xp:order-7731:refund',
    tenantId: 'oem-consumer-synthetic-01',
    principalId: 'agent:refund-assistant',
    action: 'payments.refund.issue',
    consequenceId: 'refund:order-7731:98900',
    executionRoute: 'POST /refunds',
    payloadCommitment: canonicalSha256({ orderId: 'order-7731', amountCents: 98900, destination: 'card:4242' }),
    currentStateCommitment: canonicalSha256({ orderId: 'order-7731', captured: 98900 }),
    proposedAt: new Date('2026-09-28T12:00:00.000Z'),
  });

function grantFor(p, over = {}) {
  const now = Date.now();
  return sign({
    schemaVersion: 'strix-execution-authority-v1',
    grantId: 'xg:test-0001',
    issuer: ISSUER,
    signingKeyId: KID,
    ...currentExecutionOf(p),
    strixDecisionId: 'cmdecision0001',
    strixCapabilityId: 'execution.authority.grant',
    approvalsRequired: 2,
    approvalsGranted: 2,
    issuedAt: new Date(now - 1000).toISOString(),
    notBefore: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    singleUse: true,
    ...over,
  });
}

/** A Strix stand-in: scripted answers per path, every request recorded. */
async function withStrix(script, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, url: req.url, body: parsed, auth: req.headers.authorization, tenant: req.headers['x-tenant-id'] });
      const out = script(req.url, parsed, req);
      if (out === 'DROP') return req.socket.destroy();
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(out.raw ?? JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new StrixExecutionAuthorityClient({ baseUrl, token: 'test-token', strixTenantId: 'tenant-1', issuer: ISSUER });
  try {
    return await fn({ client, seen, baseUrl });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const trustRoutes = (overrides = {}) => (url) => {
  if (url === '/.well-known/strix-authority-keys.json') return overrides.keys ?? { body: keySet() };
  if (url === '/api/public/authority/revocations') return overrides.revocations ?? { body: revocationDoc() };
  return null;
};

function counter() {
  const c = { entered: 0, executions: [] };
  c.handler = async (execution) => {
    c.entered += 1;
    c.executions.push(execution);
    return { refundId: 're_synthetic_1' };
  };
  return c;
}

test('PERMIT: evaluate → redeem → handler once → outcome reported, in that order, with the exact execution', async () => {
  const p = proposal();
  const g = grantFor(p);
  const c = counter();
  await withStrix((url, body) => {
    const t = trustRoutes()(url);
    if (t) return t;
    if (url === `/api/v1/authority/requests/${encodeURIComponent(p.proposalId)}`) return { body: { status: 'GRANTED', grant: g } };
    if (url === '/api/v1/authority/grants/xg%3Atest-0001/consume') {
      assert.equal(c.entered, 0, 'the handler must not have run before consumption');
      assert.deepEqual(body.consequence, currentExecutionOf(p));
      return { body: { status: 'CONSUMED', grantId: 'xg:test-0001', consumedAt: new Date().toISOString(), strixDecisionId: 'cmdecision0001' } };
    }
    if (url === '/api/v1/authority/grants/xg%3Atest-0001/outcome') {
      assert.equal(c.entered, 1);
      assert.equal(body.outcome, 'EXECUTED');
      assert.equal(body.handlerEntered, true);
      return { body: { status: 'RECORDED', strixDecisionId: 'cmdecision0001', state: 'EXECUTED', replay: false, signed: true, evidenceId: 'cmdecision0001', evidenceHash: 'a'.repeat(64), proofPath: '/api/public/proof/cmdecision0001' } };
    }
    return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
  }, async ({ client, seen }) => {
    const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', handler: c.handler, observedConsequence: (x) => x });
    assert.equal(r.status, 'PERMIT');
    assert.equal(r.handlerEntered, true);
    assert.equal(c.entered, 1);
    assert.deepEqual(r.result, { refundId: 're_synthetic_1' });
    assert.equal(r.outcome.status, 'RECORDED');
    assert.equal(r.outcome.proofPath, '/api/public/proof/cmdecision0001');
    const order = seen.map((s) => s.url).filter((u) => u.startsWith('/api/v1'));
    assert.deepEqual(order, [`/api/v1/authority/requests/${encodeURIComponent(p.proposalId)}`, '/api/v1/authority/grants/xg%3Atest-0001/consume', '/api/v1/authority/grants/xg%3Atest-0001/outcome']);
    for (const s of seen.filter((x) => x.url.startsWith('/api/v1'))) {
      assert.equal(s.auth, 'Bearer test-token');
      assert.equal(s.tenant, 'tenant-1');
    }
    // The proposal's bytes never travel: only commitments do.
    assert.ok(!JSON.stringify(seen).includes('card:4242'));
  });
});

test('REQUIRE_APPROVAL and evaluate-REFUSED never reach redemption, and the handler is not entered', async () => {
  const p = proposal();
  const c = counter();
  await withStrix((url) => trustRoutes()(url) ?? { body: { status: 'APPROVAL_REQUIRED', strixDecisionId: 'cmdecision0002', approvalsRequired: 2, approvalsGranted: 0 } }, async ({ client, seen }) => {
    const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', handler: c.handler });
    assert.equal(r.status, 'REQUIRE_APPROVAL');
    assert.equal(r.handlerEntered, false);
    assert.equal(c.entered, 0);
    assert.ok(!seen.some((s) => s.url.includes('/consume')));
  });
  await withStrix((url) => trustRoutes()(url) ?? { body: { status: 'REFUSED', strixDecisionId: 'cmdecision0003', reasonCode: 'POLICY_DENIED' } }, async ({ client }) => {
    const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', handler: c.handler });
    assert.equal(r.status, 'REFUSE');
    assert.equal(r.reasonCode, 'POLICY_DENIED');
    assert.equal(c.entered, 0);
  });
});

for (const [label, consumeAnswer, expectStatus, expectCode] of [
  ['Strix refuses the consumption (replay / mismatch / revoked)', { status: 409, body: { status: 'REFUSED', reasonCode: 'GRANT_ALREADY_CONSUMED', detail: 'spent', refusalEvidenceId: 'xg:test-0001:refusal:1' } }, 'REFUSE', 'GRANT_ALREADY_CONSUMED'],
  ['Strix cannot answer (500)', { status: 500, body: { error: { code: 'INTERNAL', message: 'boom', status: 500 } } }, 'UNAVAILABLE', 'INTERNAL'],
  ['Strix is dormant (503)', { status: 503, body: { error: { code: 'AUTHORITY_DORMANT', message: 'off', status: 503 } } }, 'UNAVAILABLE', 'AUTHORITY_DORMANT'],
  ['the consume response is not JSON', { status: 200, raw: 'not json' }, 'UNAVAILABLE', 'MALFORMED_RESPONSE'],
  ['the consume response is a 200 without CONSUMED', { status: 200, body: { status: 'OK' } }, 'UNAVAILABLE', 'HTTP_200'],
  ['the connection drops mid-consume', 'DROP', 'UNAVAILABLE', 'TRANSPORT_ERROR'],
]) {
  test(`${label}: the handler is not entered`, async () => {
    const p = proposal();
    const g = grantFor(p);
    const c = counter();
    await withStrix((url) => {
      const t = trustRoutes()(url);
      if (t) return t;
      if (url.endsWith('/consume')) return consumeAnswer;
      return { body: { status: 'GRANTED', grant: g } };
    }, async ({ client, seen }) => {
      const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', handler: c.handler });
      assert.equal(r.status, expectStatus, JSON.stringify(r));
      assert.equal(r.handlerEntered, false);
      assert.equal(c.entered, 0);
      assert.equal(r.status === 'REFUSE' ? r.reasonCode : r.code, expectCode);
      if (r.status === 'REFUSE') assert.equal(r.refusalEvidenceId, 'xg:test-0001:refusal:1');
      assert.ok(!seen.some((s) => s.url.includes('/outcome')), 'no outcome is reported for a handler that never ran');
    });
  });
}

test('a forged grant is refused locally and never presented to Strix', async () => {
  const p = proposal();
  const forged = grantFor(p);
  forged.signature = sign(forged.payload, attacker.privateKey).signature;
  const c = counter();
  await withStrix((url) => trustRoutes()(url) ?? { status: 500, body: { error: { code: 'MUST_NOT_BE_CALLED' } } }, async ({ client, seen }) => {
    const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', grant: forged, handler: c.handler });
    assert.equal(r.status, 'REFUSE');
    assert.equal(r.refusedBy, 'local');
    assert.equal(r.reasonCode, 'AUTHORITY_SIGNATURE_INVALID');
    assert.equal(c.entered, 0);
    assert.ok(!seen.some((s) => s.url.startsWith('/api/v1')), 'a forged artifact is not shown to Strix');
  });
});

test('a mutated execution at the boundary is presented as-is, so Strix records the mismatch, and the handler is not entered', async () => {
  const p = proposal();
  const g = grantFor(p);
  const c = counter();
  await withStrix((url, body) => {
    const t = trustRoutes()(url);
    if (t) return t;
    if (url.endsWith('/consume')) {
      assert.equal(body.consequence.payloadCommitment, '0'.repeat(64));
      return { status: 409, body: { status: 'REFUSED', reasonCode: 'CONSEQUENCE_MISMATCH', detail: 'payloadCommitment', refusalEvidenceId: 'xg:test-0001:refusal:2' } };
    }
    return { body: { status: 'GRANTED', grant: g } };
  }, async ({ client }) => {
    const r = await executeGoverned({
      client,
      proposal: p,
      presenter: 'handler:1',
      currentExecution: () => ({ ...currentExecutionOf(p), payloadCommitment: '0'.repeat(64) }),
      handler: c.handler,
    });
    assert.equal(r.status, 'REFUSE');
    assert.equal(r.refusedBy, 'strix');
    assert.deepEqual(r.mismatchedFields, ['payloadCommitment']);
    assert.equal(c.entered, 0);
  });
});

test('an expired grant is refused; a grant whose window exceeds the trust ceiling is refused locally', async () => {
  const p = proposal();
  const c = counter();
  const expired = grantFor(p, { notBefore: '2020-01-01T00:00:00.000Z', issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:30:00.000Z' });
  await withStrix((url) => trustRoutes()(url) ?? { status: 409, body: { status: 'REFUSED', reasonCode: 'GRANT_EXPIRED', detail: 'expired' } }, async ({ client }) => {
    const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', grant: expired, handler: c.handler });
    assert.equal(r.status, 'REFUSE');
    assert.equal(r.reasonCode, 'GRANT_EXPIRED');
    assert.equal(c.entered, 0);
  });
  const tooLong = grantFor(p, { expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() });
  await withStrix((url) => trustRoutes()(url) ?? { status: 500 }, async ({ client, seen }) => {
    const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', grant: tooLong, handler: c.handler });
    assert.equal(r.status, 'REFUSE');
    assert.equal(r.reasonCode, 'AUTHORITY_LIFETIME_EXCEEDED');
    assert.equal(c.entered, 0);
    assert.ok(!seen.some((s) => s.url.includes('/consume')));
  });
});

for (const [label, overrides, code] of [
  ['the key set is unavailable', { keys: { status: 503, body: { error: { code: 'AUTHORITY_KEYS_UNAVAILABLE' } } } }, 'KEY_SET_UNAVAILABLE'],
  ['the revocation document is unavailable', { revocations: { status: 503, body: { error: { code: 'X' } } } }, 'REVOCATIONS_UNAVAILABLE'],
  ['the revocation document is stale', { revocations: { body: revocationDoc({ validUntil: new Date(Date.now() - 1000).toISOString() }) } }, 'TRUST_INVALID'],
  ['the revocation document is signed by a foreign key', { revocations: { body: sign(revocationDoc().payload, attacker.privateKey) } }, 'TRUST_INVALID'],
  ['the key set names another issuer', { keys: { body: { ...keySet(), issuer: 'https://other.strix.test' } } }, 'TRUST_INVALID'],
  ['the key set carries evidence-purpose keys', { keys: { body: { ...keySet(), purpose: 'strix-evidence' } } }, 'TRUST_INVALID'],
]) {
  test(`${label}: silence is never trust; UNAVAILABLE and the handler is not entered`, async () => {
    const p = proposal();
    const g = grantFor(p);
    const c = counter();
    await withStrix((url) => trustRoutes(overrides)(url) ?? { body: { status: 'GRANTED', grant: g } }, async ({ client, seen }) => {
      const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', handler: c.handler });
      assert.equal(r.status, 'UNAVAILABLE', JSON.stringify(r));
      assert.equal(r.code, code);
      assert.equal(c.entered, 0);
      assert.ok(!seen.some((s) => s.url.includes('/consume')), 'nothing is presented without trust');
    });
  });
}

test('a revoked grant or key in the current revocation document is refused before presentation', async () => {
  const p = proposal();
  const g = grantFor(p);
  const c = counter();
  for (const over of [{ revokedGrantIds: ['xg:test-0001'] }, { revokedKeyIds: [KID] }]) {
    await withStrix((url) => trustRoutes({ revocations: { body: revocationDoc(over) } })(url) ?? { status: 409, body: { status: 'REFUSED', reasonCode: 'GRANT_REVOKED', detail: 'revoked' } }, async ({ client }) => {
      const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', grant: g, handler: c.handler });
      assert.equal(r.status, 'REFUSE');
      assert.equal(c.entered, 0);
    });
  }
});

test('a handler that throws after PERMIT is reported FAILED with handlerEntered true, never EXECUTED', async () => {
  const p = proposal();
  const g = grantFor(p);
  const reports = [];
  await withStrix((url, body) => {
    const t = trustRoutes()(url);
    if (t) return t;
    if (url.endsWith('/consume')) return { body: { status: 'CONSUMED', grantId: 'xg:test-0001', consumedAt: new Date().toISOString(), strixDecisionId: 'cmdecision0001' } };
    if (url.endsWith('/outcome')) {
      reports.push(body);
      return { body: { status: 'RECORDED', strixDecisionId: 'cmdecision0001', state: 'FAILED', replay: false, signed: true, evidenceId: 'cmdecision0001', evidenceHash: 'b'.repeat(64), proofPath: '/api/public/proof/cmdecision0001' } };
    }
    return { body: { status: 'GRANTED', grant: g } };
  }, async ({ client }) => {
    const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', handler: async () => { throw new Error('processor timeout'); } });
    assert.equal(r.status, 'PERMIT_HANDLER_FAILED');
    assert.equal(r.handlerEntered, true);
    assert.deepEqual(reports.map((x) => [x.outcome, x.handlerEntered]), [['FAILED', true]]);
    assert.equal(r.outcome.state, 'FAILED');
  });
});

test('a lost outcome report is reported as UNREPORTED, never as recorded', async () => {
  const p = proposal();
  const g = grantFor(p);
  await withStrix((url) => {
    const t = trustRoutes()(url);
    if (t) return t;
    if (url.endsWith('/consume')) return { body: { status: 'CONSUMED', grantId: 'xg:test-0001', consumedAt: new Date().toISOString(), strixDecisionId: 'cmdecision0001' } };
    if (url.endsWith('/outcome')) return 'DROP';
    return { body: { status: 'GRANTED', grant: g } };
  }, async ({ client }) => {
    const r = await executeGoverned({ client, proposal: p, presenter: 'handler:1', handler: async () => 'done' });
    assert.equal(r.status, 'PERMIT');
    assert.equal(r.outcome.status, 'UNREPORTED');
  });
});

test('governedTool wraps an agent tool so its handler runs only under PERMIT for the arguments presented', async () => {
  const c = counter();
  let calls = 0;
  await withStrix((url, body) => {
    const t = trustRoutes()(url);
    if (t) return t;
    if (url.includes('/requests/')) {
      calls += 1;
      const p = body.proposal;
      // First call: refund of 98900 is granted. Second: a bulk route is refused.
      return p.executionRoute === 'POST /refunds' ? { body: { status: 'GRANTED', grant: grantFor(p) } } : { body: { status: 'REFUSED', strixDecisionId: 'cmd2', reasonCode: 'POLICY_DENIED' } };
    }
    if (url.endsWith('/consume')) return { body: { status: 'CONSUMED', grantId: 'xg:test-0001', consumedAt: new Date().toISOString(), strixDecisionId: 'cmdecision0001' } };
    if (url.endsWith('/outcome')) return { body: { status: 'RECORDED', strixDecisionId: 'cmdecision0001', state: 'EXECUTED', replay: false, signed: true, evidenceId: 'cmdecision0001', evidenceHash: 'c'.repeat(64), proofPath: '/api/public/proof/cmdecision0001' } };
    return { status: 404, body: {} };
  }, async ({ client }) => {
    const tool = governedTool({
      name: 'issue_refund',
      client,
      presenter: 'mcp:refund-tool',
      proposalFor: (args) => buildProposal({ ...currentExecutionOf(proposal()), executionRoute: args.bulk ? 'POST /refunds/bulk' : 'POST /refunds', proposalId: args.bulk ? 'xp:bulk' : 'xp:order-7731:refund' }),
      handler: (args, execution) => c.handler(execution),
    });
    const ok = await tool.execute({ bulk: false });
    assert.equal(ok.status, 'PERMIT');
    const no = await tool.execute({ bulk: true });
    assert.equal(no.status, 'REFUSE');
    assert.equal(c.entered, 1);
    assert.equal(calls, 2);
  });
});

test('the client refuses a non-https base URL outside loopback', () => {
  assert.throws(() => new StrixExecutionAuthorityClient({ baseUrl: 'http://strix.example', token: 't', strixTenantId: 'x' }));
});
