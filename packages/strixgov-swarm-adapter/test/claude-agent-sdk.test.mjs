/**
 * @strixgov/swarm-adapter/claude-agent-sdk — binding unit tests (node:test, dist).
 *
 * Proves the binding emits the Claude Agent SDK's { content, isError? } shape from
 * the adapter, with NO dependency on the SDK: an allowed call returns a normal
 * result; a governed block returns isError + a refusal the model can reason about
 * (never throws, never crashes the agent).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governedToolHandler, delegateWorkers } from '../dist/bindings/claude-agent-sdk.js';

test('governedToolHandler returns an SDK content result when allowed', async () => {
  const adapter = { act: async () => ({ status: 'EXECUTED', evidenceId: 'evi-1' }) };
  const handler = governedToolHandler(adapter, 'summary', 'swarm.demo.writeDealSummary');
  const res = await handler({ dealId: '17' });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.content[0].type, 'text');
  assert.match(res.content[0].text, /EXECUTED/);
  assert.match(res.content[0].text, /evi-1/);
});

test('governedToolHandler returns isError + a reasoned refusal when blocked (no throw)', async () => {
  const adapter = { act: async () => ({ status: 'BLOCKED', blockCode: 'SWARM_AMPLIFICATION', blockReason: 'cap not granted' }) };
  const handler = governedToolHandler(adapter, 'risky', 'swarm.demo.writeDealSummary');
  const res = await handler({ dealId: '17' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /BLOCKED/);
  assert.match(res.content[0].text, /SWARM_AMPLIFICATION/);
  assert.match(res.content[0].text, /not delegated/);
});

test('renderResult / renderBlock are customizable', async () => {
  const ok = governedToolHandler(
    { act: async () => ({ status: 'EXECUTED' }) }, 'a', 'cap',
    { renderResult: () => 'CUSTOM-OK' },
  );
  assert.equal((await ok({})).content[0].text, 'CUSTOM-OK');

  const blocked = governedToolHandler(
    { act: async () => ({ status: 'BLOCKED', blockCode: 'X' }) }, 'a', 'cap',
    { renderBlock: () => 'CUSTOM-BLOCK' },
  );
  assert.equal((await blocked({})).content[0].text, 'CUSTOM-BLOCK');
});

test('delegateWorkers fans out depth-1 grants and returns delegation ids', async () => {
  const calls = [];
  const adapter = { delegate: async (spec) => { calls.push(spec); return `edge-${spec.to}`; } };
  const ids = await delegateWorkers(adapter, 'planner', [
    { to: 'summary', capabilities: ['deal.summarize'], budget: 3 },
    { to: 'risky', capabilities: ['crm.read'], budget: 1 },
  ]);
  assert.deepEqual(ids, ['edge-summary', 'edge-risky']);
  assert.equal(calls[0].from, 'planner');
  assert.equal(calls[1].to, 'risky');
});
