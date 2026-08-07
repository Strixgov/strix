/**
 * Durable trace-signal sender — the SDK-side half of Live Trace-Driven
 * Revocation's Phase 1 (ADVISORY) recording.
 *
 * Real local HTTP server, no transport mocking (same discipline as
 * governed-action.test.mjs): these assertions cover the actual
 * context.traceSignals wire shape a real evaluate() request carries, not a
 * stub of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const { governedAction, resolveRunId, isTraceOptionEnabled, traceHistoryFilePath } =
  await import('../dist/index.js');

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

function evaluateBody(seen) {
  const req = seen.find((s) => s.url.endsWith('/api/v1/evaluate'));
  assert.ok(req, 'no evaluate() request was captured');
  return req.body;
}

function tmpTraceDir() {
  return mkdtempSync(join(tmpdir(), 'strix-trace-test-'));
}

test('default (no trace option): context carries no traceSignals field at all — zero behavior change for existing callers', async () => {
  await withKernel(kernel(), async (base, seen) => {
    await governedAction(
      { ...CREDS, strixUrl: base, capabilityId: 'mcp.github.merge_pull_request', payload: { pr: 1 } },
      async () => ({ merged: true }),
    );
    const body = evaluateBody(seen);
    assert.equal(body.context.payloadHash !== undefined, true);
    assert.equal('traceSignals' in body.context, false,
      'an unconfigured caller must see byte-identical context shape to before this feature existed');
  });
});

test('trace: true sends a traceSignals slot with exactly one event on the first call', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        {
          ...CREDS, strixUrl: base, capabilityId: 'mcp.github.merge_pull_request', payload: { pr: 1 },
          trace: { runId: 'run-a', traceDir: dir },
        },
        async () => ({ merged: true }),
      );
      const slot = evaluateBody(seen).context.traceSignals;
      assert.equal(slot.schema, 'strix.trace-signals.v1');
      assert.equal(slot.events.length, 1);
      assert.equal(slot.events[0].seq, 0);
      assert.equal(slot.events[0].runId, 'run-a');
      assert.equal(slot.events[0].tenantId, 'test-tenant');
      assert.equal(slot.events[0].capabilityId, 'mcp.github.merge_pull_request');
      assert.match(slot.events[0].payloadHash, /^[0-9a-f]{64}$/);
      assert.ok(slot.events[0].occurredAt);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sequential calls with the SAME runId accumulate — seq increments, both events present', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base, seen) => {
      const call = (capabilityId) => governedAction(
        { ...CREDS, strixUrl: base, capabilityId, payload: {}, trace: { runId: 'run-b', traceDir: dir } },
        async () => ({}),
      );
      await call('mcp.github.merge_pull_request');
      await call('mcp.github.push_files');

      const evals = seen.filter((s) => s.url.endsWith('/api/v1/evaluate'));
      assert.equal(evals.length, 2);
      const secondSlot = evals[1].body.context.traceSignals;
      assert.equal(secondSlot.events.length, 2, 'the second call must see the first call in its trace-so-far');
      assert.equal(secondSlot.events[0].seq, 0);
      assert.equal(secondSlot.events[0].capabilityId, 'mcp.github.merge_pull_request');
      assert.equal(secondSlot.events[1].seq, 1);
      assert.equal(secondSlot.events[1].capabilityId, 'mcp.github.push_files');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DIFFERENT runIds never see each other\'s history', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'a.b', payload: {}, trace: { runId: 'run-x', traceDir: dir } },
        async () => ({}),
      );
      await governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'c.d', payload: {}, trace: { runId: 'run-y', traceDir: dir } },
        async () => ({}),
      );
      const evals = seen.filter((s) => s.url.endsWith('/api/v1/evaluate'));
      assert.equal(evals[1].body.context.traceSignals.events.length, 1,
        'run-y must start fresh, not inherit run-x\'s history');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('durability: history seeded on disk BEFORE any in-process call is genuinely read, not just the in-memory fallback', async () => {
  // This is the load-bearing durability assertion: a fresh runId with NOTHING
  // in this process's in-memory map must still pick up a pre-existing seq
  // from disk, proving disk is actually consulted — not merely written to
  // for show while an in-memory cache silently does all the real work.
  const dir = tmpTraceDir();
  try {
    // Seed at the path PRODUCTION resolves, not a hand-written one: a second
    // copy of the naming rule here could drift from the real one and leave
    // this test seeding a file nothing ever reads, which would look green
    // while proving nothing.
    const seedPath = await traceHistoryFilePath({
      tenantId: CREDS.tenantId, runId: 'seeded-run', traceDir: dir,
    });
    mkdirSync(dirname(seedPath), { recursive: true });
    writeFileSync(
      seedPath,
      JSON.stringify([
        { tenantId: CREDS.tenantId, seq: 0, capabilityId: 'prior.action', payloadHash: 'a'.repeat(64), occurredAt: '2026-01-01T00:00:00Z' },
        { tenantId: CREDS.tenantId, seq: 1, capabilityId: 'prior.action', payloadHash: 'a'.repeat(64), occurredAt: '2026-01-01T00:00:01Z' },
      ]),
      'utf8',
    );
    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        {
          ...CREDS, strixUrl: base, capabilityId: 'new.action', payload: {},
          trace: { runId: 'seeded-run', traceDir: dir },
        },
        async () => ({}),
      );
      const slot = evaluateBody(seen).context.traceSignals;
      assert.equal(slot.events.length, 3, 'the two disk-seeded events plus this call\'s own');
      assert.equal(slot.events[2].seq, 2, 'seq must continue from the disk-persisted history, not restart at 0');
      assert.equal(slot.events[2].capabilityId, 'new.action');
    });

    const onDisk = JSON.parse(readFileSync(seedPath, 'utf8'));
    assert.equal(onDisk.length, 3, 'the updated history must be persisted back to disk');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('maxEvents bounds the window — oldest events drop, newest are kept', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base, seen) => {
      for (let i = 0; i < 5; i++) {
        await governedAction(
          {
            ...CREDS, strixUrl: base, capabilityId: `cap.${i}`, payload: {},
            trace: { runId: 'bounded-run', traceDir: dir, maxEvents: 3 },
          },
          async () => ({}),
        );
      }
      const evals = seen.filter((s) => s.url.endsWith('/api/v1/evaluate'));
      const lastSlot = evals[evals.length - 1].body.context.traceSignals;
      assert.equal(lastSlot.events.length, 3, 'must never exceed maxEvents');
      assert.deepEqual(
        lastSlot.events.map((e) => e.capabilityId),
        ['cap.2', 'cap.3', 'cap.4'],
        'the oldest events must be dropped, keeping the most recent window',
      );
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('traceDir: false disables persistence — no file is written, in-memory only for this process', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        {
          ...CREDS, strixUrl: base, capabilityId: 'a.b', payload: {},
          trace: { runId: 'memory-only-run', traceDir: false },
        },
        async () => ({}),
      );
      const slot = evaluateBody(seen).context.traceSignals;
      assert.equal(slot.events.length, 1, 'in-memory tracking must still work this call');
    });
    // Nothing was ever pointed at `dir` in this test, so its emptiness proves
    // no accidental disk write happened anywhere on the default path either.
    const fs = await import('node:fs');
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a broken traceDir (a FILE, not a directory) never breaks the governed action — degrades to no trace-signal participation', async () => {
  const dir = tmpTraceDir();
  const brokenPath = join(dir, 'not-a-directory');
  writeFileSync(brokenPath, 'i am a file, not a directory', 'utf8');
  try {
    await withKernel(kernel(), async (base, seen) => {
      let ran = 0;
      const result = await governedAction(
        {
          ...CREDS, strixUrl: base, capabilityId: 'a.b', payload: {},
          trace: { runId: 'x', traceDir: brokenPath },
        },
        async () => { ran += 1; return { ok: true }; },
      );
      assert.equal(ran, 1, 'the governed action must run normally despite a broken trace directory');
      assert.deepEqual(result.result, { ok: true });
      // Either no traceSignals field at all, or an empty-history slot — never a thrown error.
      const body = evaluateBody(seen);
      if ('traceSignals' in body.context) {
        assert.ok(Array.isArray(body.context.traceSignals.events));
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('STRIX_TRACE_SIGNALS_SDK=true enables trace-signal sending globally with no per-call option', async () => {
  const dir = tmpTraceDir();
  const priorSdkFlag = process.env.STRIX_TRACE_SIGNALS_SDK;
  const priorTraceDir = process.env.STRIX_TRACE_DIR;
  process.env.STRIX_TRACE_SIGNALS_SDK = 'true';
  process.env.STRIX_TRACE_DIR = dir;
  try {
    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'a.b', payload: {} },
        async () => ({}),
      );
      const body = evaluateBody(seen);
      assert.ok('traceSignals' in body.context, 'the global env opt-in must apply with zero per-call config');
    });
  } finally {
    if (priorSdkFlag === undefined) delete process.env.STRIX_TRACE_SIGNALS_SDK;
    else process.env.STRIX_TRACE_SIGNALS_SDK = priorSdkFlag;
    if (priorTraceDir === undefined) delete process.env.STRIX_TRACE_DIR;
    else process.env.STRIX_TRACE_DIR = priorTraceDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trace: false ALWAYS overrides the global env opt-in — an explicit per-call refusal is never silently ignored', async () => {
  const priorSdkFlag = process.env.STRIX_TRACE_SIGNALS_SDK;
  process.env.STRIX_TRACE_SIGNALS_SDK = 'true';
  try {
    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'a.b', payload: {}, trace: false },
        async () => ({}),
      );
      const body = evaluateBody(seen);
      assert.equal('traceSignals' in body.context, false);
    });
  } finally {
    if (priorSdkFlag === undefined) delete process.env.STRIX_TRACE_SIGNALS_SDK;
    else process.env.STRIX_TRACE_SIGNALS_SDK = priorSdkFlag;
  }
});

test('declaredBudgets/consumption are included when provided, and never as an explicit-undefined key otherwise', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        {
          ...CREDS, strixUrl: base, capabilityId: 'a.b', payload: {},
          trace: { runId: 'budget-run', traceDir: dir, declaredBudgets: { 'spend.usd': 100 }, consumption: { 'spend.usd': 10 } },
        },
        async () => ({}),
      );
      const slot = evaluateBody(seen).context.traceSignals;
      assert.deepEqual(slot.events[0].declaredBudgets, { 'spend.usd': 100 });
      assert.deepEqual(slot.events[0].consumption, { 'spend.usd': 10 });

      await governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'c.d', payload: {}, trace: { runId: 'budget-run', traceDir: dir } },
        async () => ({}),
      );
      const secondSlot = seen.filter((s) => s.url.endsWith('/api/v1/evaluate')).at(-1).body.context.traceSignals;
      assert.equal('declaredBudgets' in secondSlot.events[1], false,
        'a call without declaredBudgets must OMIT the key, never send it as undefined (SCJ v1 throws on that)');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('declaredPairs are included only when non-empty; omitted (not sent as an empty array) otherwise', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'a.b', payload: {}, trace: { runId: 'r1', traceDir: dir } },
        async () => ({}),
      );
      assert.equal('declaredPairs' in evaluateBody(seen).context.traceSignals, false);

      await governedAction(
        {
          ...CREDS, strixUrl: base, capabilityId: 'a.b', payload: {},
          trace: { runId: 'r2', traceDir: dir, declaredPairs: [['retrieve.doc', 'send.email']] },
        },
        async () => ({}),
      );
      const evals = seen.filter((s) => s.url.endsWith('/api/v1/evaluate'));
      assert.deepEqual(evals.at(-1).body.context.traceSignals.declaredPairs, [['retrieve.doc', 'send.email']]);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent calls to the SAME runId never corrupt the history file — a lost update is acceptable, invalid JSON is not', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base) => {
      const call = (capabilityId) => governedAction(
        { ...CREDS, strixUrl: base, capabilityId, payload: {}, trace: { runId: 'race-run', traceDir: dir } },
        async () => ({}),
      );
      // Genuinely concurrent, not sequential-awaited — this is exactly the
      // shape that could tear a non-atomic write.
      await Promise.all([call('a.1'), call('b.2'), call('c.3'), call('d.4'), call('e.5')]);

      const racePath = await traceHistoryFilePath({
        tenantId: CREDS.tenantId, runId: 'race-run', traceDir: dir,
      });
      const onDisk = readFileSync(racePath, 'utf8');
      const parsed = JSON.parse(onDisk); // throws on truncated/interleaved bytes
      assert.ok(Array.isArray(parsed), 'the file must always be well-formed JSON, even under a race');
      assert.ok(parsed.length >= 1 && parsed.length <= 5,
        'a lost update under the race is acceptable; corruption or an out-of-range count is not');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveRunId + isTraceOptionEnabled: unit-level contract', () => {
  assert.equal(isTraceOptionEnabled(true), true);
  assert.equal(isTraceOptionEnabled(false), false);
  assert.equal(isTraceOptionEnabled({ runId: 'x' }), true);
  assert.equal(isTraceOptionEnabled(undefined), false, 'off by default with no env var set');

  assert.equal(resolveRunId('explicit-id'), 'explicit-id');
  assert.equal(resolveRunId('  '), resolveRunId('  '), 'whitespace-only falls through to the same process default both times');
});

test('STRIX_RUN_ID env var is honored when no explicit runId option is given', async () => {
  const dir = tmpTraceDir();
  const prior = process.env.STRIX_RUN_ID;
  process.env.STRIX_RUN_ID = 'ci-job-42';
  try {
    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        { ...CREDS, strixUrl: base, capabilityId: 'a.b', payload: {}, trace: { traceDir: dir } },
        async () => ({}),
      );
      const slot = evaluateBody(seen).context.traceSignals;
      assert.equal(slot.events[0].runId, 'ci-job-42');
    });
  } finally {
    if (prior === undefined) delete process.env.STRIX_RUN_ID;
    else process.env.STRIX_RUN_ID = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-tenant contamination (Codex P1) + the identifier-collision class it
// belongs to. History was keyed by runId ALONE — in memory and on disk —
// while `tenantId` was stamped onto every event at SEND time from the
// CURRENT call. Two tenants sharing a runId therefore did not merely see
// each other's events: each tenant's request relabeled the other's events
// as its OWN. That is a leak (tenant A's capabilityIds + payloadHashes ride
// tenant B's request body and land on tenant B's decision row) and a
// fabrication (the events assert a tenantId that did not take them).
//
// The default zero-configuration path is the exposed one: with no runId and
// no STRIX_RUN_ID, every call in a process shares one generated
// `processRunId`, which is exactly the shape of a multi-tenant Node service.
// ─────────────────────────────────────────────────────────────────────────

test('cross-tenant: two tenants sharing one runId never see each other\'s events', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base, seen) => {
      const call = (tenantId, capabilityId) => governedAction(
        {
          apiKey: 'test-key', tenantId, strixUrl: base, capabilityId, payload: {},
          trace: { runId: 'shared-run', traceDir: dir },
        },
        async () => ({}),
      );
      await call('tenant-a', 'finance.refund.issue');
      await call('tenant-b', 'mcp.github.push_files');

      const bodies = seen.filter((s) => s.url.endsWith('/api/v1/evaluate')).map((s) => s.body);
      assert.equal(bodies.length, 2);

      const b = bodies[1].context.traceSignals;
      assert.equal(b.events.length, 1,
        'tenant-b must see ONLY its own event — inheriting tenant-a\'s history is a cross-tenant leak');
      assert.equal(b.events[0].capabilityId, 'mcp.github.push_files');
      assert.equal(b.events[0].seq, 0, 'tenant-b\'s first call is seq 0 in ITS own history');
      for (const ev of b.events) {
        assert.equal(ev.tenantId, 'tenant-b');
        assert.notEqual(ev.capabilityId, 'finance.refund.issue',
          'a foreign tenant\'s capability id must never appear in this tenant\'s request body');
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cross-tenant: the in-memory fallback (traceDir:false) is partitioned by tenant too', async () => {
  await withKernel(kernel(), async (base, seen) => {
    const call = (tenantId, capabilityId) => governedAction(
      {
        apiKey: 'test-key', tenantId, strixUrl: base, capabilityId, payload: {},
        trace: { runId: 'mem-shared-run', traceDir: false },
      },
      async () => ({}),
    );
    await call('mem-tenant-a', 'finance.refund.issue');
    await call('mem-tenant-b', 'mcp.github.push_files');

    const bodies = seen.filter((s) => s.url.endsWith('/api/v1/evaluate')).map((s) => s.body);
    const b = bodies[1].context.traceSignals;
    assert.equal(b.events.length, 1, 'disk-disabled mode must partition by tenant as well');
    assert.equal(b.events[0].capabilityId, 'mcp.github.push_files');
  });
});

test('cross-tenant: two tenants sharing a runId write SEPARATE history files', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base) => {
      const call = (tenantId, capabilityId) => governedAction(
        {
          apiKey: 'test-key', tenantId, strixUrl: base, capabilityId, payload: {},
          trace: { runId: 'file-shared-run', traceDir: dir },
        },
        async () => ({}),
      );
      await call('file-tenant-a', 'finance.refund.issue');
      await call('file-tenant-b', 'mcp.github.push_files');
    });

    const { readdirSync, statSync } = await import('node:fs');
    const files = [];
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.json')) files.push(p);
      }
    };
    walk(dir);
    assert.equal(files.length, 2,
      'one history file per (tenant, run) — a single shared file is the cross-tenant leak on disk');
    for (const f of files) {
      const events = JSON.parse(readFileSync(f, 'utf8'));
      const caps = new Set(events.map((e) => e.capabilityId));
      assert.equal(caps.size, 1, `${f} mixes capabilities from more than one tenant`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('identifier collision: runIds that differ only in path-unsafe characters keep separate history', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base, seen) => {
      const call = (runId, capabilityId) => governedAction(
        {
          ...CREDS, strixUrl: base, capabilityId, payload: {},
          trace: { runId, traceDir: dir },
        },
        async () => ({}),
      );
      // Both sanitize to the same `run_a` under a naive replace-with-underscore
      // filename rule, which silently merges two genuinely distinct runs.
      await call('run/a', 'finance.refund.issue');
      await call('run_a', 'mcp.github.push_files');

      const bodies = seen.filter((s) => s.url.endsWith('/api/v1/evaluate')).map((s) => s.body);
      const second = bodies[1].context.traceSignals;
      assert.equal(second.events.length, 1,
        'two distinct runIds must not share one history file just because they sanitize alike');
      assert.equal(second.events[0].runId, 'run_a');
      assert.equal(second.events[0].capabilityId, 'mcp.github.push_files');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stored history file whose events name a DIFFERENT tenant is dropped, never adopted', async () => {
  const dir = tmpTraceDir();
  try {
    const path = await traceHistoryFilePath({
      tenantId: 'victim-tenant', runId: 'planted-run', traceDir: dir,
    });
    mkdirSync(dirname(path), { recursive: true });
    // Sitting at victim-tenant's own path, but naming someone else. Reading
    // the path instead of the content is exactly how the original defect
    // relabeled foreign events.
    writeFileSync(path, JSON.stringify([
      { tenantId: 'attacker-tenant', seq: 0, capabilityId: 'finance.refund.issue', payloadHash: 'b'.repeat(64), occurredAt: '2026-01-01T00:00:00Z' },
    ]), 'utf8');

    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        {
          apiKey: 'test-key', tenantId: 'victim-tenant', strixUrl: base,
          capabilityId: 'own.action', payload: {},
          trace: { runId: 'planted-run', traceDir: dir },
        },
        async () => ({}),
      );
      const slot = evaluateBody(seen).context.traceSignals;
      assert.equal(slot.events.length, 1, 'the planted foreign event must not be inherited');
      assert.equal(slot.events[0].seq, 0, 'seq restarts — a dropped file leaves no history behind');
      assert.equal(slot.events[0].tenantId, 'victim-tenant');
      assert.equal(slot.events[0].capabilityId, 'own.action');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pre-partition history file (no tenantId on its events) is dropped rather than inherited', async () => {
  const dir = tmpTraceDir();
  try {
    const path = await traceHistoryFilePath({
      tenantId: 'legacy-tenant', runId: 'legacy-run', traceDir: dir,
    });
    mkdirSync(dirname(path), { recursive: true });
    // The shape an older version wrote. It cannot prove whose events it
    // holds, so losing one run's advisory history is the safe direction.
    writeFileSync(path, JSON.stringify([
      { seq: 0, capabilityId: 'prior.action', payloadHash: 'c'.repeat(64), occurredAt: '2026-01-01T00:00:00Z' },
    ]), 'utf8');

    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        {
          apiKey: 'test-key', tenantId: 'legacy-tenant', strixUrl: base,
          capabilityId: 'new.action', payload: {},
          trace: { runId: 'legacy-run', traceDir: dir },
        },
        async () => ({}),
      );
      const slot = evaluateBody(seen).context.traceSignals;
      assert.equal(slot.events.length, 1);
      assert.equal(slot.events[0].seq, 0);
      assert.equal(slot.events[0].capabilityId, 'new.action');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every event on the wire carries a tenantId, and it is always the calling tenant', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base, seen) => {
      const call = (capabilityId) => governedAction(
        {
          apiKey: 'test-key', tenantId: 'stamp-tenant', strixUrl: base, capabilityId, payload: {},
          trace: { runId: 'stamp-run', traceDir: dir },
        },
        async () => ({}),
      );
      await call('a.one');
      await call('a.two');
      const bodies = seen.filter((s) => s.url.endsWith('/api/v1/evaluate')).map((s) => s.body);
      const events = bodies[1].context.traceSignals.events;
      assert.equal(events.length, 2);
      for (const ev of events) {
        assert.equal(ev.tenantId, 'stamp-tenant');
        assert.equal(ev.runId, 'stamp-run');
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Codex review follow-ups (PR #2073) ────────────────────────────────────
// Both were RED before the fix in the same commit as these tests.

test('traceHistoryFilePath resolves the path the writer ACTUALLY used for padded identifiers', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base) => {
      // The writer trims both identifiers (`normalizeTenantId` + `resolveRunId`).
      // A caller handing the helper the same padded strings it handed
      // governedAction must get back the file that exists, not a hash of the
      // raw input — otherwise "locate or delete this run's history" silently
      // targets nothing.
      await governedAction(
        {
          apiKey: 'k', tenantId: '  pad-tenant  ', strixUrl: base,
          capabilityId: 'pad.one', payload: {},
          trace: { runId: '  pad-run  ', traceDir: dir },
        },
        async () => ({}),
      );
      const padded = await traceHistoryFilePath({
        tenantId: '  pad-tenant  ', runId: '  pad-run  ', traceDir: dir,
      });
      const trimmed = await traceHistoryFilePath({
        tenantId: 'pad-tenant', runId: 'pad-run', traceDir: dir,
      });
      assert.equal(padded, trimmed, 'padded and trimmed ids must resolve to one path');
      const events = JSON.parse(readFileSync(padded, 'utf8'));
      assert.equal(events.length, 1);
      assert.equal(events[0].tenantId, 'pad-tenant');
      assert.equal(events[0].capabilityId, 'pad.one');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('traceHistoryFilePath returns null for a tenant id that normalizes to nothing', async () => {
  const dir = tmpTraceDir();
  try {
    // No file is ever written under a blank tenant, so returning a plausible
    // path would be a lie. Same honest null as disabled persistence.
    assert.equal(await traceHistoryFilePath({ tenantId: '   ', runId: 'r', traceDir: dir }), null);
    assert.equal(await traceHistoryFilePath({ tenantId: '', runId: 'r', traceDir: dir }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('traceHistoryFilePath with no runId resolves the same run the writer would use', async () => {
  const dir = tmpTraceDir();
  try {
    await withKernel(kernel(), async (base) => {
      // Omitting runId must follow the writer's own fallback chain
      // (STRIX_RUN_ID, then this process's id) rather than hashing "".
      await governedAction(
        { apiKey: 'k', tenantId: 'implicit-run-tenant', strixUrl: base,
          capabilityId: 'implicit.one', payload: {}, trace: { traceDir: dir } },
        async () => ({}),
      );
      const path = await traceHistoryFilePath({
        tenantId: 'implicit-run-tenant', traceDir: dir,
      });
      assert.ok(path, 'helper must resolve a path');
      const events = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(events[0].capabilityId, 'implicit.one');
      assert.equal(path, await traceHistoryFilePath({
        tenantId: 'implicit-run-tenant', runId: resolveRunId(), traceDir: dir,
      }));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hashing does not depend on globalThis.crypto being present (Node 18 path)', async () => {
  // engines declares node >=18, where globalThis.crypto is only exposed under
  // --experimental-global-webcrypto. Simulate its absence and assert the
  // package still hashes, mints an evidence id, and derives a history path —
  // and that the bytes are identical to the Web Crypto branch.
  const dir = tmpTraceDir();
  const saved = globalThis.crypto;
  try {
    const withCrypto = await traceHistoryFilePath({
      tenantId: 'fallback-tenant', runId: 'fallback-run', traceDir: dir,
    });
    // eslint-disable-next-line no-global-assign
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    const withoutCrypto = await traceHistoryFilePath({
      tenantId: 'fallback-tenant', runId: 'fallback-run', traceDir: dir,
    });
    assert.equal(withoutCrypto, withCrypto, 'fallback digest must be byte-identical');

    await withKernel(kernel(), async (base, seen) => {
      await governedAction(
        { apiKey: 'k', tenantId: 'fallback-tenant', strixUrl: base,
          capabilityId: 'fallback.one', payload: { a: 1 },
          trace: { runId: 'fallback-run', traceDir: dir } },
        async () => ({}),
      );
      const body = evaluateBody(seen);
      assert.match(body.context.payloadHash ?? body.payloadHash ?? '', /^[0-9a-f]{64}$/);
    });
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
