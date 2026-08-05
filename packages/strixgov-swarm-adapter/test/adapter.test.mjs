/**
 * @strixgov/swarm-adapter — self-contained unit tests (node:test, against dist).
 *
 * No Strix boundary, no DB — pure package surface: HttpTransport status mapping,
 * governedTool execute/block behavior, and the depth-1 multi-hop guard. The full
 * end-to-end (through the real governed boundary) lives in the Strix Console's
 * tests/swarm/adapter.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpTransport, governedTool, GovernedBlockError, SwarmAdapter } from '../dist/index.js';

function fakeFetch(routes) {
  return async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    const r = routes[key] ?? routes['*'] ?? { status: 404, body: {} };
    return { status: r.status, json: async () => r.body };
  };
}

test('HttpTransport maps statuses to ok/error and EXECUTED/BLOCKED', async () => {
  const t = new HttpTransport({
    base: 'https://x.test', tenantId: 'acme', token: 'tok',
    fetchImpl: fakeFetch({
      'POST /api/v1/swarm/runs': { status: 201, body: { swarmRunId: 'r1' } },
      'POST /api/v1/swarm/actions/execute': { status: 200, body: { verification_status: 'EXECUTED', evidenceId: 'e1' } },
    }),
  });
  const open = await t.openRun({});
  assert.equal(open.ok, true);
  assert.equal(open.swarmRunId, 'r1');

  const exec = await t.execute({});
  assert.equal(exec.status, 'EXECUTED');
  assert.equal(exec.evidenceId, 'e1');
});

test('HttpTransport surfaces a governed block as BLOCKED', async () => {
  const t = new HttpTransport({
    base: 'https://x.test', tenantId: 'acme', token: 'tok',
    fetchImpl: fakeFetch({
      'POST /api/v1/swarm/actions/execute': { status: 403, body: { verification_status: 'BLOCKED', blockCode: 'SWARM_AMPLIFICATION', blockReason: 'cap not granted' } },
    }),
  });
  const exec = await t.execute({});
  assert.equal(exec.status, 'BLOCKED');
  assert.equal(exec.blockCode, 'SWARM_AMPLIFICATION');
});

test('governedTool executes when allowed and throws GovernedBlockError when blocked', async () => {
  const okAdapter = { act: async () => ({ status: 'EXECUTED', evidenceId: 'e1' }) };
  const blockAdapter = { act: async () => ({ status: 'BLOCKED', blockCode: 'SWARM_AMPLIFICATION' }) };

  const okTool = governedTool(okAdapter, 'summary', 'swarm.demo.writeDealSummary');
  const r = await okTool({ dealId: '17' });
  assert.equal(r.status, 'EXECUTED');
  assert.equal(r.evidenceId, 'e1');

  const blockedTool = governedTool(blockAdapter, 'risky', 'swarm.demo.writeDealSummary');
  await assert.rejects(() => blockedTool({ dealId: '17' }), (e) => {
    assert.ok(e instanceof GovernedBlockError);
    assert.equal(e.blockCode, 'SWARM_AMPLIFICATION');
    assert.equal(e.agentId, 'risky');
    return true;
  });
});

test('SwarmAdapter refuses multi-hop delegation in v0.1 (depth-1 only)', async () => {
  const transport = {
    openRun: async () => ({ ok: true, swarmRunId: 'r1' }),
    registerAgent: async () => ({ ok: true }),
    persistDelegation: async () => ({ ok: true, delegationId: 'd1' }),
    execute: async () => ({ status: 'EXECUTED' }),
  };
  const adapter = new SwarmAdapter({ transport, tenantId: 'acme', environment: 'prod' });
  await adapter.openRun({ rootAgentId: 'planner', rootDecisionId: 'dec', capabilityCeiling: ['crm.read'] });
  await assert.rejects(
    () => adapter.delegate({ from: 'worker', to: 'grandchild', capabilities: ['crm.read'], budget: 1 }),
    /depth-1 only/,
  );
});
