import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark, strixRedactor, commandRedactor } from '../accuracy/benchmark.mjs';

test('a no-op tool lets every identifier survive and keeps every decoy', async () => {
  // A pass-through in Node rather than `cat`, which Windows does not have.
  const r = await runBenchmark(commandRedactor(`"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`));
  for (const s of r.sets) {
    assert.ok(s.identifiers > 0);
    assert.equal(s.survived, s.identifiers);
    assert.equal(s.decoysKept, s.decoys);
  }
});

test('a tool that always fails is scored as refusing, never as redacting', async () => {
  const r = await runBenchmark(commandRedactor('exit 3'));
  for (const s of r.sets) {
    assert.equal(s.refused, s.identifiers);
    assert.equal(s.survived, 0);
  }
});

test('the strix pipeline lets nothing survive on the committed corpora', async () => {
  const r = await runBenchmark(await strixRedactor());
  for (const s of r.sets) assert.equal(s.survived, 0, `${s.corpus}: ${s.survived} survived`);
});
