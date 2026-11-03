/**
 * The published IngestRefusalCode union must name every code the extractors
 * can actually return. Derived from the source, not listed: a code added to an
 * extractor and missing from the type is a consumer's exhaustive switch
 * silently falling through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function sourceCodes() {
  const found = new Set();
  for (const f of ['csv-text.mjs', 'xlsx-text.mjs', 'pptx-text.mjs', 'docx-text.mjs', 'ingest.mjs', 'zip-container.mjs', 'pdf-text.mjs']) {
    const code = strip(readFileSync(join(root, 'src/artifact', f), 'utf8'));
    for (const re of [/new \w+Error\(\s*'([A-Z_]+)'/g, /\bfail\(\s*'([A-Z_]+)'/g, /TABLE_[A-Z_]+:\s*'([A-Z_]+)'/g, /\brefusal\(\s*'([A-Z_]+)'/g]) {
      for (const m of code.matchAll(re)) if (!m[1].startsWith('TABLE_')) found.add(m[1]);
    }
  }
  return [...found].sort();
}

function declaredCodes() {
  const types = readFileSync(join(root, 'types.d.ts'), 'utf8');
  const block = types.match(/export type IngestRefusalCode =([\s\S]*?);/);
  assert.ok(block, 'IngestRefusalCode union not found');
  return [...block[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

test('the derivation is not scanning nothing', () => {
  const codes = sourceCodes();
  assert.ok(codes.length >= 30, `only ${codes.length} codes derived`);
  for (const c of ['TABULAR_TEXT_UNDECLARED', 'DOCX_HIDDEN_CONTENT', 'CSV_NAME_VALUE_UNRECOGNIZED']) assert.ok(codes.includes(c), c);
});

test('every source refusal code is in the published IngestRefusalCode union', () => {
  const declared = new Set(declaredCodes());
  const missing = sourceCodes().filter((c) => !declared.has(c));
  assert.deepEqual(missing, []);
});
