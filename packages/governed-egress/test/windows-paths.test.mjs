// Two path shapes work on Linux and break on Windows, and CI runs Linux:
//   import(join(...))           — `C:` in a bare path is read as a URL scheme
//   new URL(...).pathname       — gives /C:/..., which is not a Windows path
// Both broke the accuracy check and PDF asset discovery on a Windows checkout
// (2026-10-07). Use pathToFileURL / fileURLToPath instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['src', 'bin', 'accuracy', 'test', 'demo'];
const BAD = [
  [/\bimport\(\s*(?:join|resolve|path\.join|path\.resolve)\(/, 'import() of a bare path'],
  [/new URL\([^)]*\)\.pathname/, 'URL.pathname used as a file path'],
];

function files(dir) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(rel));
    else if (e.name.endsWith('.mjs')) out.push(rel);
  }
  return out;
}

test('no source uses a path shape that breaks on Windows', () => {
  const all = DIRS.flatMap(files).filter((f) => !f.endsWith('windows-paths.test.mjs'));
  assert.ok(all.length > 50, 'the scan found almost nothing; it is measuring the wrong tree');
  const hits = [];
  for (const f of all) {
    const code = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [re, why] of BAD) if (re.test(code)) hits.push(`${f}: ${why}`);
  }
  assert.deepEqual(hits, []);
});
