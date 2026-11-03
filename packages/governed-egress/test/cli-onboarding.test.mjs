// A buyer installing from npm meets the CLI before anything else. These pin
// that it explains itself and hands out a starter policy that actually works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEgressPolicy, decideDestination } from '../src/policy/policy.mjs';
import { PACK_VERSIONS } from '../src/detection/packs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'strix-egress-proxy.mjs');
const STARTER = path.join(HERE, '..', 'examples', 'policy-starter.json');
const cli = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

test('--help exits 0 and names every option the parser accepts', () => {
  const r = cli(['--help']);
  assert.equal(r.status, 0, r.stderr);
  // Derived from the parser itself, so a new flag cannot ship undocumented.
  const src = readFileSync(BIN, 'utf8');
  const flags = [...src.matchAll(/case '(--[a-z-]+)':/g)].map((m) => m[1]).filter((f) => f !== '--token');
  assert.ok(flags.length >= 10, 'parser flags were not found; the scan is measuring nothing');
  for (const f of flags) assert.ok(r.stdout.includes(f), `--help does not mention ${f}`);
  for (const id of Object.keys(PACK_VERSIONS)) assert.ok(r.stdout.includes(id), `--help does not name pack ${id}`);
  assert.match(r.stdout, /not that a document contains no PHI/);
});

test('--version reports the proxy and the package version', () => {
  const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const r = cli(['--version']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(pkg.version), r.stdout);
});

test('init-policy writes the starter policy and refuses to overwrite', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'egress-init-'));
  const first = cli(['init-policy'], dir);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'policy.json'), 'utf8')), JSON.parse(readFileSync(STARTER, 'utf8')));
  writeFileSync(path.join(dir, 'policy.json'), '{"edited":true}');
  const second = cli(['init-policy'], dir);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
  assert.equal(readFileSync(path.join(dir, 'policy.json'), 'utf8'), '{"edited":true}');
  const named = cli(['init-policy', 'custom.json'], dir);
  assert.equal(named.status, 0);
  assert.ok(existsSync(path.join(dir, 'custom.json')));
});

test('the starter policy validates and only lets de-identified data out', () => {
  const policy = JSON.parse(readFileSync(STARTER, 'utf8'));
  validateEgressPolicy(policy);
  assert.equal(policy.dataEgress.externalAI.default, 'deny');
  for (const provider of ['anthropic', 'openai']) {
    assert.equal(decideDestination({ classification: 'deidentified', destination: { provider }, policy }).eligible, true, provider);
    assert.equal(decideDestination({ classification: 'clear', destination: { provider }, policy }).eligible, true, provider);
    assert.equal(decideDestination({ classification: 'unknown', destination: { provider }, policy }).eligible, false, provider);
    assert.equal(decideDestination({ classification: 'phi_detected', destination: { provider }, policy }).eligible, false, provider);
  }
  assert.equal(decideDestination({ classification: 'deidentified', destination: { provider: 'gemini' }, policy }).eligible, false);
});

test('the starter policy ships in the npm package', () => {
  const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('examples/'), 'examples/ is not in package.json files');
});
