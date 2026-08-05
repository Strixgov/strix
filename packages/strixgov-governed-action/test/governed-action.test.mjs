/**
 * The non-bypass contract, tested against a real local HTTP server.
 *
 * The load-bearing property is negative: on any block path — deny, approval
 * required, or an unreachable kernel — the wrapped operation must NEVER run. A
 * library that executed the side effect and then recorded a denial would be
 * worse than no governance at all, because the record would be a lie.
 *
 * No transport mocking: a real server on a real port, so these assertions cover
 * the actual fetch + canonicalization path rather than a stub of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const {
  governedAction, governedFetch, resolveCapability, qualifiesAsFirstProof,
  StrixDenied, StrixApprovalRequired, StrixUnreachable,
} = await import('../dist/index.js');

/** A kernel stand-in that answers with a scripted verdict and records traffic. */
async function withKernel(handler, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      const out = handler(req.url);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, seen); } finally { server.close(); }
}

const CREDS = { apiKey: 'test-key', tenantId: 'test-tenant' };

function kernel({ verdict = 'allow', decisionId = 'dec_1' } = {}) {
  return (url) => {
    if (url.endsWith('/api/v1/evaluate')) {
      return { body: { action: verdict, decisionId, reason: `scripted ${verdict}` } };
    }
    if (url.endsWith('/api/v1/evidence/ingest')) {
      return { body: { ingested: 1, skipped: 0, quarantined: 0 } };
    }
    if (url.includes('/receipt')) {
      return { body: { evidenceId: 'ev_signed_1', proofUrl: 'https://example.test/proof/ev_signed_1' } };
    }
    return { status: 404, body: {} };
  };
}

test('allow: runs the operation and returns a real verify command', async () => {
  await withKernel(kernel(), async (base) => {
    let ran = 0;
    const r = await governedAction(
      { ...CREDS, strixUrl: base, capabilityId: 'mcp.github.merge_pull_request', payload: { pr: 1 } },
      async () => { ran += 1; return { merged: true }; },
    );
    assert.equal(ran, 1, 'operation must run exactly once on allow');
    assert.deepEqual(r.result, { merged: true });
    assert.equal(r.signedEvidenceId, 'ev_signed_1');
    assert.equal(r.verifyCommand, 'npx @strixgov/verifier@latest ev_signed_1',
      'verify command must be @latest-pinned and built from the signed id');
  });
});

test('deny: throws StrixDenied and the operation NEVER runs', async () => {
  await withKernel(kernel({ verdict: 'deny' }), async (base, seen) => {
    let ran = 0;
    await assert.rejects(
      () => governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'mcp.github.merge_pull_request', payload: {} },
        async () => { ran += 1; },
      ),
      StrixDenied,
    );
    assert.equal(ran, 0, 'a denied action must not execute');
    assert.equal(seen.filter((s) => s.url.includes('evidence')).length, 0,
      'a denied action writes no execution evidence — denials live on the decision chain');
  });
});

test('approval required: throws and the operation NEVER runs', async () => {
  await withKernel(kernel({ verdict: 'require_approval' }), async (base) => {
    let ran = 0;
    await assert.rejects(
      () => governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'mcp.github.merge_pull_request', payload: {} },
        async () => { ran += 1; },
      ),
      StrixApprovalRequired,
    );
    assert.equal(ran, 0, 'an approval-gated action must not execute before approval');
  });
});

test('unreachable kernel: fails closed, operation NEVER runs', async () => {
  let ran = 0;
  await assert.rejects(
    () => governedAction(
      { ...CREDS, strixUrl: 'http://127.0.0.1:1', capabilityId: 'x.y', payload: {}, timeoutMs: 300 },
      async () => { ran += 1; },
    ),
    StrixUnreachable,
  );
  assert.equal(ran, 0, 'an unreachable kernel must fail closed, never fail open');
});

test('an HTTP 4xx from the kernel is NEVER reported as a governance denial', async () => {
  // Regression pin. This surfaced for real: run through a network egress
  // allowlist, the proxy answered `403 Host not in allowlist` and the library
  // classified it StrixDenied — claiming the kernel had evaluated and refused
  // the action when the kernel was never reached. The CLI then printed "The
  // operation did NOT run. That is the system working."
  //
  // A denial is HTTP 200 with action:'deny'. Any 4xx is transport or auth, so it
  // must report as unreachable: failed closed, no decision obtained. Both refuse
  // to run the operation — the difference is whether the stated reason is true.
  for (const status of [401, 403, 404, 429]) {
    await withKernel(() => ({ status, body: { error: 'Host not in allowlist' } }), async (base) => {
      let ran = 0;
      await assert.rejects(
        () => governedAction(
          { ...CREDS, strixUrl: base, capabilityId: 'mcp.github.merge_pull_request', payload: {} },
          async () => { ran += 1; },
        ),
        (err) => {
          assert.equal(err.name, 'StrixUnreachable',
            `HTTP ${status} must not be reported as a policy verdict (got ${err.name})`);
          assert.ok(!(err instanceof StrixDenied), `HTTP ${status} must not be a StrixDenied`);
          assert.match(err.message, /no decision obtained/);
          return true;
        },
      );
      assert.equal(ran, 0, `HTTP ${status} must still fail closed — the operation never runs`);
    });
  }
});

test('a 5xx is also "no decision obtained", not a verdict', async () => {
  await withKernel(() => ({ status: 503, body: { error: 'upstream unavailable' } }), async (base) => {
    let ran = 0;
    await assert.rejects(
      () => governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'mcp.github.push_files', payload: {} },
        async () => { ran += 1; },
      ),
      (err) => {
        assert.equal(err.name, 'StrixUnreachable');
        assert.match(err.message, /no decision obtained/);
        return true;
      },
    );
    assert.equal(ran, 0);
  });
});

test('a failing operation still records evidence, then rethrows', async () => {
  await withKernel(kernel(), async (base, seen) => {
    await assert.rejects(
      () => governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'mcp.github.push_files', payload: {} },
        async () => { throw new Error('upstream 500'); },
      ),
      /upstream 500/,
    );
    const ev = seen.find((s) => s.url.includes('evidence'));
    assert.ok(ev, 'a failure after allow must still be recorded');
    assert.equal(ev.body.records[0].metadata.outcome, 'error');
    assert.equal(ev.body.records[0].metadata.payload, undefined,
      "a failed operation's params must not be persisted");
  });
});

test('governedFetch records method and URL but never request headers', async () => {
  await withKernel((url) => {
    if (url === '/target') return { body: { ok: true } };
    return kernel()(url);
  }, async (base, seen) => {
    const r = await governedFetch(
      'mcp.github.merge_pull_request',
      `${base}/target`,
      { method: 'PUT', headers: { Authorization: 'Bearer super-secret' }, body: JSON.stringify({ a: 1 }) },
      { ...CREDS, strixUrl: base },
    );
    assert.equal(r.result.status, 200);
    assert.equal(r.result.ok, true);

    const ev = seen.find((s) => s.url.includes('evidence'));
    const payload = ev.body.records[0].metadata.payload;
    assert.equal(payload.method, 'PUT');
    assert.deepEqual(payload.requestBody, { a: 1 });
    assert.equal(payload.headers, undefined, 'headers must never enter evidence');
    assert.ok(!JSON.stringify(seen).includes('super-secret'),
      'no credential from the wrapped call may appear anywhere in kernel traffic');
  });
});

test('governedFetch returns non-2xx rather than throwing', async () => {
  await withKernel((url) => {
    if (url === '/target') return { status: 422, body: { error: 'unprocessable' } };
    return kernel()(url);
  }, async (base) => {
    const r = await governedFetch(
      'mcp.github.push_files', `${base}/target`, { method: 'POST' }, { ...CREDS, strixUrl: base },
    );
    assert.equal(r.result.status, 422);
    assert.equal(r.result.ok, false, 'the call happened; evidence must reflect that, not a throw');
  });
});

// ── PROOF-1 capability honesty ────────────────────────────────────────────

const GH = [
  { id: 'mcp.github.merge_pull_request', risk: 'CRITICAL' },
  { id: 'mcp.github.list_issues', risk: 'LOW' },
];
const SLACK = [{ id: 'mcp.slack.post_message', risk: 'MEDIUM' }];

test('a CRITICAL capability qualifies as a first proof', () => {
  const r = resolveCapability('mcp.github.merge_pull_request', GH);
  assert.equal(r.qualification.status, 'QUALIFIES');
  assert.equal(qualifiesAsFirstProof(r), true);
});

test('no Slack capability qualifies today — reported, not promoted', () => {
  const r = resolveCapability('mcp.slack.post_message', SLACK);
  assert.equal(r.qualification.status, 'NOT_CONSEQUENTIAL');
  assert.equal(qualifiesAsFirstProof(r), false);
  assert.match(r.qualification.reason, /Time-to-First-Proof/);
});

test('an unclassified id is UNKNOWN, never assumed either way', () => {
  const r = resolveCapability('acme.invoice.void', GH);
  assert.equal(r.qualification.status, 'UNKNOWN');
  assert.equal(qualifiesAsFirstProof(r), false);
});

test('placeholder capability ids are refused outright', () => {
  for (const bad of ['test', 'dummy', 'placeholder', 'example']) {
    assert.throws(() => resolveCapability(bad, GH), /placeholder/i, `${bad} must be refused`);
  }
});
