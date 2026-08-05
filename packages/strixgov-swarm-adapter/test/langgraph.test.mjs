/**
 * @strixgov/swarm-adapter/langgraph — binding unit tests (node:test, dist).
 *
 * Proves the binding emits LangChain's tool return shape from the adapter, with
 * NO dependency on LangGraph/LangChain: an allowed call returns model-visible
 * text; a governed block returns a reasoned refusal STRING (never throws, so the
 * bad branch stays legible to the model instead of crashing the graph); a real
 * transport error DOES throw (a network failure is not a refusal).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governedToolFunc, delegateWorkers } from '../dist/bindings/langgraph.js';

test('governedToolFunc returns model-visible text when allowed', async () => {
  const adapter = { act: async () => ({ status: 'EXECUTED', evidenceId: 'evi-1' }) };
  const fn = governedToolFunc(adapter, 'summary', 'swarm.demo.writeDealSummary');
  const out = await fn({ dealId: '17' });
  assert.equal(typeof out, 'string');
  assert.match(out, /EXECUTED/);
  assert.match(out, /evi-1/);
});

test('governedToolFunc returns a reasoned refusal string when blocked (no throw)', async () => {
  const adapter = { act: async () => ({ status: 'BLOCKED', blockCode: 'SWARM_AMPLIFICATION', blockReason: 'cap not granted' }) };
  const fn = governedToolFunc(adapter, 'risky', 'swarm.demo.writeDealSummary');
  const out = await fn({ dealId: '17' });
  assert.equal(typeof out, 'string');
  assert.match(out, /BLOCKED/);
  assert.match(out, /SWARM_AMPLIFICATION/);
  assert.match(out, /not delegated/);
});

test('contentMode:"content" returns the LangChain content-array shape', async () => {
  const adapter = { act: async () => ({ status: 'EXECUTED', evidenceId: 'evi-2' }) };
  const fn = governedToolFunc(adapter, 'summary', 'cap', { contentMode: 'content' });
  const out = await fn({});
  assert.ok(Array.isArray(out));
  assert.equal(out[0].type, 'text');
  assert.match(out[0].text, /evi-2/);
});

test('a real transport error throws (a network failure is not a governance refusal)', async () => {
  const adapter = { act: async () => { throw new Error('ECONNREFUSED'); } };
  const fn = governedToolFunc(adapter, 'summary', 'cap');
  await assert.rejects(() => fn({}), /ECONNREFUSED/);
});

test('renderResult / renderBlock are customizable', async () => {
  const ok = governedToolFunc(
    { act: async () => ({ status: 'EXECUTED' }) }, 'a', 'cap',
    { renderResult: () => 'CUSTOM-OK' },
  );
  assert.equal(await ok({}), 'CUSTOM-OK');

  const blocked = governedToolFunc(
    { act: async () => ({ status: 'BLOCKED', blockCode: 'X' }) }, 'a', 'cap',
    { renderBlock: () => 'CUSTOM-BLOCK' },
  );
  assert.equal(await blocked({}), 'CUSTOM-BLOCK');
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
