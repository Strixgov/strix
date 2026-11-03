import test from 'node:test';
import assert from 'node:assert/strict';
import { signalsFromConfig } from '../src/detection/signal-config.mjs';

const TOKEN = 'x'.repeat(40);
const expected = {
  name: 'w', version: '1', model: 'm', revision: 'r', weightsSha256: 'a'.repeat(64), threshold: 0.5,
};

test('builds one pinned signal from a valid config', () => {
  const s = signalsFromConfig({ url: 'http://127.0.0.1:8765', expected }, { token: TOKEN });
  assert.equal(s.length, 1);
  assert.equal(s[0].info.model, 'm');
});

test('refuses a missing token, url, identity or non-object config', () => {
  assert.throws(() => signalsFromConfig({ url: 'http://127.0.0.1:1', expected }, {}), /STRIX_SIGNAL_TOKEN/);
  assert.throws(() => signalsFromConfig({ expected }, { token: TOKEN }), /url/);
  assert.throws(() => signalsFromConfig({ url: 'http://127.0.0.1:1' }, { token: TOKEN }), /identity/);
  assert.throws(() => signalsFromConfig([], { token: TOKEN }), /object/);
});

test('refuses a non-loopback http worker and a short token', () => {
  assert.throws(() => signalsFromConfig({ url: 'http://10.0.0.5:1', expected }, { token: TOKEN }), /loopback/);
  assert.throws(() => signalsFromConfig({ url: 'http://127.0.0.1:1', expected }, { token: 'short' }), /32/);
});
