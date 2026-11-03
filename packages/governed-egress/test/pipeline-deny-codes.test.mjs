/**
 * PIPELINE_DENY_CODES must equal the set of literal refusal codes pipeline.mjs
 * actually raises — DERIVED from the source, never compared against a second
 * hand-written list.
 *
 * The defect this exists to prevent is not hypothetical. The console's
 * `PIPELINE_REFUSAL_CODES` was a hand-maintained list under exactly that name,
 * and it contained the ingest and policy codes instead — so the completeness
 * check built on it (`untranslatedKnownCodes()`) reported clean while eight of
 * this module's nine refusals had no customer-facing language at all. A check
 * whose unit is a list someone remembered to update measures the list, not the
 * code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PIPELINE_DENY_CODES } from '../src/index.mjs';

const SOURCE = fileURLToPath(new URL('../src/pipeline.mjs', import.meta.url));

/** Every `deny('CODE'` literal, single- or multi-line. */
function declaredInSource() {
  const text = readFileSync(SOURCE, 'utf8');
  // Strip the exported constant itself so the scan reads the CALL SITES, not
  // the declaration — otherwise the list would trivially agree with itself.
  const withoutDeclaration = text.replace(
    /export const PIPELINE_DENY_CODES = Object\.freeze\(\[[\s\S]*?\]\);/,
    '',
  );
  const found = [...withoutDeclaration.matchAll(/deny\(\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
  return [...new Set(found)].sort();
}

test('PIPELINE_DENY_CODES equals the codes raised at the call sites', () => {
  const fromSource = declaredInSource();
  assert.ok(fromSource.length > 0, 'the scan found no deny() call sites — it is measuring nothing');
  assert.deepEqual([...PIPELINE_DENY_CODES].sort(), fromSource);
});

test('the set is frozen and carries no duplicates', () => {
  assert.ok(Object.isFrozen(PIPELINE_DENY_CODES));
  assert.equal(new Set(PIPELINE_DENY_CODES).size, PIPELINE_DENY_CODES.length);
});

test('it claims no vocabulary this module does not own', () => {
  // Codes re-raised from ingest / policy belong to those modules.
  for (const foreign of ['UNSUPPORTED_ARTIFACT', 'DESTINATION_NOT_ENABLED', 'POLICY_INVALID']) {
    assert.ok(
      !PIPELINE_DENY_CODES.includes(foreign),
      `${foreign} is defined by another module and must not be claimed here`,
    );
  }
});
