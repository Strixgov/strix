/**
 * The published accuracy report is generated, never typed. This fails if
 * the committed REPORT.md / report.json differ from a regeneration: a
 * detector, pipeline or corpus change must come with the new numbers, and a
 * hand-edited number cannot survive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the committed accuracy report equals a regeneration', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../accuracy/run.mjs', import.meta.url)), '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
