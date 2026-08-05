/**
 * Benchmark harness tests (node:test). Proves the corpus is well-formed, the
 * runner drives the REAL policy, the load-bearing claims hold, and every signed
 * receipt re-verifies — so the published numbers are checkable, not asserted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTACK_CORPUS, CATEGORIES, corpusByCategory } from '../benchmark/corpus.mjs';
import { runBenchmark } from '../benchmark/run-benchmark.mjs';
import { TOOL_NAME_TO_CAPABILITY } from '../src/decide.mjs';

test('corpus is non-trivial and every category is represented', () => {
  assert.ok(ATTACK_CORPUS.length >= 90, `expected a substantial corpus, got ${ATTACK_CORPUS.length}`);
  const byCat = corpusByCategory();
  for (const c of CATEGORIES) assert.ok(byCat[c].length > 0, `category ${c} has no vectors`);
});

test('every corpus entry has a unique id and a real Claude Code tool', () => {
  const ids = new Set();
  for (const v of ATTACK_CORPUS) {
    assert.ok(!ids.has(v.id), `duplicate id ${v.id}`);
    ids.add(v.id);
    assert.ok(v.tool in TOOL_NAME_TO_CAPABILITY, `unknown tool "${v.tool}" in ${v.id}`);
    assert.ok(v.input && typeof v.input === 'object', `missing input in ${v.id}`);
    assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(v.severity), `bad severity in ${v.id}`);
  }
});

test('runBenchmark: the two load-bearing claims hold + all receipts verify', async () => {
  const result = await runBenchmark();
  // Default Pack: zero state-changing attempts auto-execute.
  assert.equal(result.headline.claim_default_zero_auto_exec, true,
    `default-pack auto-executed ${result.headline.defaultPackAutoExecuted} state-changing attempts`);
  // Strict lockdown: every state-changing attempt denied, none executed.
  assert.equal(result.headline.claim_strict_all_denied, true,
    `strict lockdown left ${result.headline.strictLockdownAutoExecuted} executed`);
  // Receipts: issued, complete (one per attempt per governed profile), all re-verified.
  assert.ok(result.receipts.issued > 0, 'receipts were issued');
  assert.equal(result.receipts.failures.length, 0, `receipt verify failures: ${JSON.stringify(result.receipts.failures)}`);
  assert.equal(result.receipts.verified, result.receipts.issued, 'every issued receipt re-verified');
  assert.equal(result.receipts.complete, true, `issuance incomplete: ${JSON.stringify(result.receipts.issuanceFailures)}`);
  assert.equal(result.receipts.issued, result.receipts.expected, 'issued === expected (attempts × governed profiles)');
  assert.equal(result.receipts.issuanceFailures.length, 0, 'no governed call failed to mint a receipt');
});

test('ungoverned baseline: every state-changing attempt would execute', async () => {
  const result = await runBenchmark();
  const ung = result.profiles['ungoverned'].summary;
  assert.equal(ung.stateChangingAutoExecuted, ung.stateChanging);
  assert.ok(ung.stateChanging > 0);
});

test('honesty: read-only recon attempts are reported separately, not as blocked', async () => {
  const result = await runBenchmark();
  const def = result.profiles['default-pack'].summary;
  // There is at least one read-only attempt (a credentials-file recon read),
  // and it is counted as allowed-with-evidence, NOT folded into denied/held.
  assert.ok(def.readOnly >= 1, 'expected at least one read-only recon attempt');
  assert.equal(def.readOnlyAllowed, def.readOnly, 'read-only attempts are allowed-with-evidence');
  assert.equal(def.stateChanging + def.readOnly, def.total);
});
