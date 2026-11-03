/**
 * Structural pin, not a type-system one: every REAL provider transport
 * factory under src/adapters/<provider>/transport.mjs must construct an object that
 * declares a truthy `endpoint` field with a `baseUrl`.
 *
 * `EgressTransport.endpoint` is documented-optional on the TYPE deliberately
 * (a relay or test double legitimately has none and must report "cannot
 * probe" — see the Anthropic transport's own header comment on why the
 * field can't simply be made required). But `kernel-gate.mjs`'s
 * `endpointFields(adapter)` silently omits the key from evidence whenever
 * `adapter.endpoint` is falsy: `adapter?.endpoint ? {...} : {}`. So a real
 * provider adapter that forgot to declare `endpoint` would degrade
 * silently — the exact destination-decoupling finding this fix closes,
 * reappearing for any future third provider with no test to catch it.
 *
 * This test never hardcodes the adapter list: it walks src/adapters/*
 * for every transport.mjs, derives the exported `create*Transport` factory
 * by name, constructs it with a synthetic credential (construction alone
 * makes no network call — only `.send()`/`.testConnection()` do, so this
 * stays air-gapped), and asserts the resolved endpoint shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ADAPTERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters');

function discoverTransportModules() {
  const entries = readdirSync(ADAPTERS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  const modules = [];
  for (const entry of entries) {
    const transportPath = path.join(ADAPTERS_DIR, entry.name, 'transport.mjs');
    if (existsSync(transportPath)) {
      modules.push({ providerDir: entry.name, transportPath });
    }
  }
  return modules;
}

test('every adapter directory under src/adapters has a transport.mjs (the walk is non-empty)', () => {
  const modules = discoverTransportModules();
  // A walk that silently finds nothing would make every assertion below
  // vacuously pass — the empty-set trap this repo's own history records
  // repeatedly. There are at least two real providers (anthropic, openai)
  // as of this test's writing; a future removal must not silently zero out.
  assert.ok(modules.length >= 2, `expected >=2 provider transport modules, found ${modules.length}`);
});

test('every provider transport factory declares a truthy endpoint with a baseUrl', async () => {
  const modules = discoverTransportModules();
  assert.ok(modules.length > 0, 'no transport modules discovered — cannot make this assertion');

  for (const { providerDir, transportPath } of modules) {
    const mod = await import(pathToFileURL(transportPath).href);
    const factoryName = Object.keys(mod).find((k) => /^create.*Transport$/.test(k));
    assert.ok(factoryName, `${providerDir}: expected an exported create*Transport factory, found none`);

    const factory = mod[factoryName];
    // A synthetic, non-functional credential — construction never dials
    // out; only send()/testConnection() would, and neither is called here.
    const transport = factory({ apiKey: 'sk-structural-pin-not-a-real-key' });

    assert.ok(
      transport && typeof transport === 'object',
      `${providerDir}: ${factoryName}() did not return an object`,
    );
    assert.ok(
      transport.endpoint,
      `${providerDir}: ${factoryName}() returned no truthy .endpoint — kernel-gate's endpointFields() ` +
        `would silently omit the real destination from evidence for this provider`,
    );
    assert.equal(
      typeof transport.endpoint.baseUrl,
      'string',
      `${providerDir}: transport.endpoint.baseUrl must be a string`,
    );
    assert.ok(
      transport.endpoint.baseUrl.length > 0,
      `${providerDir}: transport.endpoint.baseUrl must not be empty`,
    );
    // The endpoint must never carry the credential — a structural leak
    // check independent of any single provider's own field names.
    const serialized = JSON.stringify(transport.endpoint);
    assert.ok(
      !serialized.includes('sk-structural-pin-not-a-real-key'),
      `${providerDir}: transport.endpoint must not carry the API key`,
    );
  }
});
