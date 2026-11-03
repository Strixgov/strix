/**
 * The container installs its runtime dependencies from container/, not from
 * the workspace. That copy must never drift from the package's own pinned
 * dependencies, or the image would run different parsing code than the
 * tests do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

test('container dependencies equal the package dependencies, exactly', () => {
  assert.deepEqual(read('../container/package.json').dependencies, read('../package.json').dependencies);
});

test('every dependency is pinned exactly and locked with an integrity hash', () => {
  const deps = read('../package.json').dependencies;
  const lock = read('../container/package-lock.json');
  for (const [name, version] of Object.entries(deps)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be an exact version`);
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} missing from the lock`);
    assert.equal(entry.version, version);
    assert.match(entry.integrity, /^sha512-/);
  }
});

test('the image runs the proxy, never a shell, and not as root', () => {
  const df = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(df, /npm ci --omit=dev --ignore-scripts/);
  assert.match(df, /USER 10001/);
  assert.match(df, /ENTRYPOINT \["node", "\/app\/pkg\/bin\/strix-egress-proxy\.mjs"/);
});
