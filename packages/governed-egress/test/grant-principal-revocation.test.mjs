// Principal binding, revocation, and the cross-process store (2026-11-11).
// Every refusal is proven by counting transport invocations, never by
// reading a status alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  releaseThroughGate,
  mintEgressAuthorization,
  createInMemoryAuthorizationStore,
  createFileAuthorizationStore,
  createInMemoryEvidenceLog,
  principalAddress,
  sha256Hex,
  EGRESS_REFUSAL_CODES,
} from '../src/index.mjs';

const DEST = { provider: 'anthropic', service: 'claude' };
const TEXT = 'Sanitized note: [PATIENT_001] seen for follow-up.';
const PROMPT = 'Summarize.';
const AUTHORIZE_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'authorization', 'authorize.mjs')).href;

function counter() {
  const sent = [];
  return { sent, transport: { name: 'counting', async send({ documentText }) { sent.push(documentText); return { responseText: 'ok' }; } } };
}

function grant(store, principal) {
  return mintEgressAuthorization({
    store, artifactHash: sha256Hex(TEXT), promptHash: sha256Hex(PROMPT), destination: DEST, purpose: 'document_analysis', principal,
  });
}

function gate(store, transport, authorizationId, principal) {
  return releaseThroughGate({
    store, evidence: createInMemoryEvidenceLog(), transport, authorizationId,
    artifactText: TEXT, prompt: PROMPT, destination: DEST, purpose: 'document_analysis', principal,
  });
}

test('the refusal vocabulary names the two new refusals', () => {
  assert.ok(EGRESS_REFUSAL_CODES.includes('PRINCIPAL_MISMATCH'));
  assert.ok(EGRESS_REFUSAL_CODES.includes('AUTHORIZATION_REVOKED'));
});

test('a grant minted for one actor is refused for another, unspent, then released to the right one', async () => {
  const store = createInMemoryAuthorizationStore();
  const { sent, transport } = counter();
  const auth = grant(store, { tenant: 'tenant-a', actor: 'alice@example.test' });
  const wrong = await gate(store, transport, auth.authorizationId, { tenant: 'tenant-a', actor: 'mallory@example.test' });
  assert.equal(wrong.reasonCode, 'PRINCIPAL_MISMATCH');
  assert.equal(sent.length, 0);
  assert.equal(store.get(auth.authorizationId).consumedAt, undefined, 'a mismatch must not burn the grant');
  const right = await gate(store, transport, auth.authorizationId, { tenant: 'tenant-a', actor: 'alice@example.test' });
  assert.equal(right.released, true);
  assert.equal(sent.length, 1);
});

test('a grant minted for one tenant is refused under another tenant with the same actor', async () => {
  const store = createInMemoryAuthorizationStore();
  const { sent, transport } = counter();
  const auth = grant(store, { tenant: 'tenant-a', actor: 'alice@example.test' });
  const r = await gate(store, transport, auth.authorizationId, { tenant: 'tenant-b', actor: 'alice@example.test' });
  assert.equal(r.reasonCode, 'PRINCIPAL_MISMATCH');
  assert.equal(sent.length, 0);
});

test('presenting no principal for a bound grant is refused, and a malformed principal never throws past the gate', async () => {
  const store = createInMemoryAuthorizationStore();
  const { sent, transport } = counter();
  const auth = grant(store, { actor: 'alice@example.test' });
  assert.equal((await gate(store, transport, auth.authorizationId, undefined)).reasonCode, 'PRINCIPAL_MISMATCH');
  assert.equal((await gate(store, transport, auth.authorizationId, { actor: 42 })).reasonCode, 'PRINCIPAL_MISMATCH');
  assert.equal((await gate(store, transport, auth.authorizationId, { actor: '' })).reasonCode, 'PRINCIPAL_MISMATCH');
  assert.equal(sent.length, 0);
});

test('a grant with no principal keeps working for a caller that has none', async () => {
  const store = createInMemoryAuthorizationStore();
  const { sent, transport } = counter();
  const auth = grant(store, undefined);
  assert.equal(auth.principalHash, principalAddress(null));
  assert.equal((await gate(store, transport, auth.authorizationId, undefined)).released, true);
  assert.equal(sent.length, 1);
});

test('the principal address is a collision-free tuple, not a concatenation', () => {
  assert.notEqual(principalAddress({ tenant: 'ab', actor: 'c' }), principalAddress({ tenant: 'a', actor: 'bc' }));
  assert.notEqual(principalAddress({ tenant: 'a', actor: null }), principalAddress({ tenant: null, actor: 'a' }));
});

test('the attempt evidence records the bound principal hash', async () => {
  const store = createInMemoryAuthorizationStore();
  const evidence = createInMemoryEvidenceLog();
  const auth = grant(store, { actor: 'alice@example.test' });
  await releaseThroughGate({
    store, evidence, transport: counter().transport, authorizationId: auth.authorizationId,
    artifactText: TEXT, prompt: PROMPT, destination: DEST, purpose: 'document_analysis', principal: { actor: 'alice@example.test' },
  });
  const attempt = evidence.list().find((e) => e.type === 'egress_attempt');
  assert.equal(attempt.principalHash, auth.principalHash);
});

test('a revoked grant is refused before transport and cannot then be claimed', async () => {
  const store = createInMemoryAuthorizationStore();
  const { sent, transport } = counter();
  const auth = grant(store, undefined);
  assert.equal(store.revoke(auth.authorizationId, { reason: 'operator incident' }), true);
  const r = await gate(store, transport, auth.authorizationId, undefined);
  assert.equal(r.reasonCode, 'AUTHORIZATION_REVOKED');
  assert.equal(sent.length, 0);
  assert.equal(store.claim(auth.authorizationId, new Date().toISOString()), false);
  assert.equal(store.revoke(auth.authorizationId), false, 'a second revoke reports it already ended');
});

test('the gate refuses a revoked grant even when a custom store forgets revocation in claim', async () => {
  const inner = createInMemoryAuthorizationStore();
  const auth = grant(inner, undefined);
  inner.revoke(auth.authorizationId);
  // A third-party store whose claim ignores revocation: the gate's own check
  // must be what stops it, not the store's discipline.
  const careless = {
    get: (id) => inner.get(id),
    put: (a) => inner.put(a),
    claim: () => true,
  };
  const { sent, transport } = counter();
  const r = await gate(careless, transport, auth.authorizationId, undefined);
  assert.equal(r.reasonCode, 'AUTHORIZATION_REVOKED');
  assert.equal(sent.length, 0);
});

test('a consumed grant cannot be revoked: the transport may already have run', async () => {
  const store = createInMemoryAuthorizationStore();
  const { transport } = counter();
  const auth = grant(store, undefined);
  assert.equal((await gate(store, transport, auth.authorizationId, undefined)).released, true);
  assert.equal(store.revoke(auth.authorizationId), false);
  assert.equal(store.get(auth.authorizationId).revokedAt, undefined);
});

test('a claim that loses to a concurrent revoke is reported as REVOKED, with the transport untouched', async () => {
  const inner = createInMemoryAuthorizationStore();
  const auth = grant(inner, undefined);
  // The store reports the grant spendable to the gate's read, then revokes it
  // inside the claim: the window between check and claim.
  const racing = {
    get: (id) => inner.get(id),
    put: (a) => inner.put(a),
    claim: (id, at) => { inner.revoke(id); return inner.claim(id, at); },
    revoke: (id, o) => inner.revoke(id, o),
  };
  const { sent, transport } = counter();
  const r = await gate(racing, transport, auth.authorizationId, undefined);
  assert.equal(r.reasonCode, 'AUTHORIZATION_REVOKED');
  assert.equal(sent.length, 0);
});

test('the file store persists the terminal state across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-store-'));
  const a = createFileAuthorizationStore({ directory: dir });
  assert.equal(a.topology, 'SINGLE_HOST_MULTI_PROCESS');
  const auth = grant(a, { actor: 'alice@example.test' });
  const { sent, transport } = counter();
  assert.equal((await gate(a, transport, auth.authorizationId, { actor: 'alice@example.test' })).released, true);
  const b = createFileAuthorizationStore({ directory: dir });
  assert.equal(b.get(auth.authorizationId).principalHash, auth.principalHash);
  assert.notEqual(b.get(auth.authorizationId).consumedAt, undefined);
  const replay = await gate(b, transport, auth.authorizationId, { actor: 'alice@example.test' });
  assert.equal(replay.reasonCode, 'AUTHORIZATION_CONSUMED');
  assert.equal(sent.length, 1);
});

test('the file store refuses ids that could leave its directory and rejects collisions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-store-'));
  const s = createFileAuthorizationStore({ directory: dir });
  assert.equal(s.get('../../etc/passwd'), null);
  assert.equal(s.claim('../x', new Date().toISOString()), false);
  assert.equal(s.revoke('..'), false);
  assert.throws(() => s.put({ authorizationId: '../evil' }), /32 lowercase hex/);
  const auth = grant(s, undefined);
  assert.throws(() => s.put(auth), /collision/);
  assert.deepEqual(readdirSync(dir).sort(), [`${auth.authorizationId}.grant.json`]);
});

function runWorkers(n, script) {
  return Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`worker exit ${code}: ${err}`))));
  })));
}

test('across separate processes, exactly one claim wins a grant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-race-'));
  const auth = grant(createFileAuthorizationStore({ directory: dir }), undefined);
  const script = `import { createFileAuthorizationStore } from ${JSON.stringify(AUTHORIZE_URL)};
const s = createFileAuthorizationStore({ directory: ${JSON.stringify(dir)} });
process.stdout.write(String(s.claim(${JSON.stringify(auth.authorizationId)}, new Date().toISOString())));`;
  const results = await runWorkers(8, script);
  assert.equal(results.filter((r) => r === 'true').length, 1, `results: ${results.join(',')}`);
  assert.equal(results.filter((r) => r === 'false').length, 7);
});

test('across separate processes, a revoke and a claim never both succeed', async () => {
  for (let round = 0; round < 5; round += 1) {
    const dir = mkdtempSync(join(tmpdir(), 'egress-revoke-race-'));
    const auth = grant(createFileAuthorizationStore({ directory: dir }), undefined);
    const op = (verb) => `import { createFileAuthorizationStore } from ${JSON.stringify(AUTHORIZE_URL)};
const s = createFileAuthorizationStore({ directory: ${JSON.stringify(dir)} });
const ok = ${verb === 'claim' ? `s.claim(${JSON.stringify(auth.authorizationId)}, new Date().toISOString())` : `s.revoke(${JSON.stringify(auth.authorizationId)})`};
process.stdout.write('${verb}:' + ok);`;
    const results = await Promise.all([runWorkers(3, op('claim')), runWorkers(3, op('revoke'))]);
    const flat = results.flat();
    assert.equal(flat.filter((r) => r.endsWith(':true')).length, 1, `round ${round}: ${flat.join(',')}`);
  }
});

// Regression (found by the RC2 clean room, 2026-11-11): the adapters passed
// `tenant` to the gate at release but not to the pipeline at mint, so every
// caller that named a tenant was refused PRINCIPAL_MISMATCH.
test('both governed adapters release when the caller names a tenant and an actor', async () => {
  const {
    governedAnthropicDocumentRequest, governedOpenAiDocumentRequest,
    createPatternDetector, createTokenizingTransformer, HEALTHCARE_REFERENCE_POLICY,
  } = await import('../src/index.mjs');
  const policy = {
    ...HEALTHCARE_REFERENCE_POLICY, policyId: 'principal-adapter-test',
    dataEgress: { externalAI: { ...HEALTHCARE_REFERENCE_POLICY.dataEgress.externalAI,
      destinations: { ...HEALTHCARE_REFERENCE_POLICY.dataEgress.externalAI.destinations, openai: { enabled: true, allowedData: ['deidentified', 'non_sensitive'] } } } },
  };
  for (const request of [governedAnthropicDocumentRequest, governedOpenAiDocumentRequest]) {
    const { sent, transport } = counter();
    const r = await request({
      source: { bytes: Buffer.from('Quarterly throughput: 412 specimens processed.'), mimeType: 'text/plain', filename: 'n.txt' },
      prompt: 'Summarize.', actor: 'alice@example.test', tenant: 'tenant-a', policy,
      deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer(), store: createInMemoryAuthorizationStore(), evidence: createInMemoryEvidenceLog() },
      transport,
    });
    assert.equal(r.released, true, `${request.name}: ${r.reasonCode ?? ''}`);
    assert.equal(sent.length, 1);
  }
});
