// Signed self-hosted evidence: the property that matters is that a
// rewritten-and-re-chained log, which the unsigned chain cannot tell from
// the real one, FAILS once signatures are checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInMemoryEvidenceLog,
  verifyEvidenceChain,
  createEvidenceSigner,
  generateEvidenceSigningKey,
  verifySignedEvidence,
  resumePointOf,
  evidenceSigningInput,
  evidenceKeyIdOf,
  EVIDENCE_SIGNATURE_SCHEME,
  createEgressProxy,
  HEALTHCARE_REFERENCE_POLICY,
} from '../src/index.mjs';
import { SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_BIN = join(pkg, 'bin/strix-egress-verify-evidence.mjs');
const PROXY_BIN = join(pkg, 'bin/strix-egress-proxy.mjs');

function signedLog(n, key = generateEvidenceSigningKey()) {
  const signer = createEvidenceSigner(key.privateKeyPem);
  const log = createInMemoryEvidenceLog({ signer });
  for (let i = 0; i < n; i += 1) log.append({ kind: 'egress_authorized', artifactHash: `h${i}`, findingsCount: i });
  return { key, signer, records: log.list().map((r) => ({ ...r })) };
}

// Same private canonicalization as log.mjs, re-implemented here so the
// attacker below needs nothing from the package.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
function rechain(records, mutateSig) {
  let prev = 'genesis';
  return records.map((r) => {
    const { entryHash: _e, prevHash: _p, signature, ...content } = r;
    const entryHash = createHash('sha256').update(`${prev}\n${canonical(content)}`, 'utf8').digest('hex');
    const out = { ...content, prevHash: prev, entryHash, signature: mutateSig ? mutateSig(content, entryHash) : signature };
    prev = entryHash;
    return out;
  });
}

test('a signed log verifies, and says what it does not prove', () => {
  const { key, records } = signedLog(3);
  assert.equal(verifyEvidenceChain(records).valid, true, 'signatures do not disturb the chain');
  const r = verifySignedEvidence(records, { publicKeys: [key.publicKeyPem] });
  assert.equal(r.status, 'VERIFIED');
  assert.equal(r.length, 3);
  assert.deepEqual(r.keyIds, [key.keyId]);
  assert.equal(r.proves, 'SIGNED_BY_KEY_HOLDER');
  assert.equal(r.completeness, 'NOT_PROVEN');
  for (const rec of records) assert.equal(rec.signingKeyId, key.keyId);
});

test('THE ATTACK: an edited record, re-chained without the key, passes the unsigned chain and fails signed verification', () => {
  const { key, records } = signedLog(3);
  records[1] = { ...records[1], findingsCount: 0 };
  const forged = rechain(records);
  assert.equal(verifyEvidenceChain(forged).valid, true, 'the unsigned chain cannot see this rewrite');
  const r = verifySignedEvidence(forged, { publicKeys: [key.publicKeyPem] });
  assert.equal(r.status, 'INVALID');
  assert.equal(r.reasonCode, 'SIGNATURE_INVALID');
  assert.equal(r.index, 1);
});

test('re-signed with the attacker\'s own key: UNVERIFIABLE; claiming the real key id: INVALID', () => {
  const { key, records } = signedLog(2);
  const attacker = generateEvidenceSigningKey();
  const attackerSigner = createEvidenceSigner(attacker.privateKeyPem);
  // Own key id inside the content, own signature.
  const ownId = rechain(records.map((r) => ({ ...r, signingKeyId: attacker.keyId, findingsCount: 9 })),
    (_c, h) => attackerSigner.sign(h));
  const a = verifySignedEvidence(ownId, { publicKeys: [key.publicKeyPem] });
  assert.equal(a.status, 'UNVERIFIABLE');
  assert.equal(a.reasonCode, 'KEY_NOT_TRUSTED');
  // Real key id, attacker's signature.
  const priv = generateKeyPairSync('ed25519').privateKey;
  const claimed = rechain(records.map((r) => ({ ...r, findingsCount: 9 })),
    (c, h) => edSign(null, evidenceSigningInput(c.signingKeyId, h), priv).toString('base64url'));
  const b = verifySignedEvidence(claimed, { publicKeys: [key.publicKeyPem] });
  assert.equal(b.status, 'INVALID');
  assert.equal(b.reasonCode, 'SIGNATURE_INVALID');
});

test('stripping signatures is detected; so are malformed fields', () => {
  const { key, records } = signedLog(2);
  const stripped = records.map(({ signature: _s, signingKeyId: _k, ...rest }) => rest);
  const s = verifySignedEvidence(rechain(stripped), { publicKeys: [key.publicKeyPem] });
  assert.equal(s.reasonCode, 'UNSIGNED_RECORD');
  const noSig = records.map(({ signature: _s, ...rest }) => rest);
  assert.equal(verifySignedEvidence(noSig, { publicKeys: [key.publicKeyPem] }).reasonCode, 'MALFORMED_SIGNATURE');
  const badSig = records.map((r) => ({ ...r, signature: 'x' }));
  assert.equal(verifySignedEvidence(badSig, { publicKeys: [key.publicKeyPem] }).reasonCode, 'MALFORMED_SIGNATURE');
});

test('deleting from the middle breaks the chain; deleting from the end is only caught with an expected head', () => {
  const { key, records } = signedLog(4);
  const mid = [records[0], records[2], records[3]];
  assert.equal(verifySignedEvidence(mid, { publicKeys: [key.publicKeyPem] }).reasonCode, 'CHAIN_LINK_BROKEN');
  const tail = records.slice(0, 2);
  const noHead = verifySignedEvidence(tail, { publicKeys: [key.publicKeyPem] });
  assert.equal(noHead.status, 'VERIFIED');
  assert.equal(noHead.completeness, 'NOT_PROVEN');
  const realHead = records[3].entryHash;
  const withHead = verifySignedEvidence(tail, { publicKeys: [key.publicKeyPem], expectedHeadHash: realHead });
  assert.equal(withHead.status, 'INVALID');
  assert.equal(withHead.reasonCode, 'HEAD_MISMATCH');
  const full = verifySignedEvidence(records, { publicKeys: [key.publicKeyPem], expectedHeadHash: realHead });
  assert.equal(full.completeness, 'HEAD_MATCHED');
});

test('an empty log is never VERIFIED, and a verifier with no key refuses to run', () => {
  const { key } = signedLog(0);
  assert.equal(verifySignedEvidence([], { publicKeys: [key.publicKeyPem] }).reasonCode, 'EMPTY_LOG');
  assert.throws(() => verifySignedEvidence([], { publicKeys: [] }), /at least one trusted public key/);
});

test('key rotation: a restarted log continues the chain under a new key', () => {
  const first = signedLog(2);
  const next = generateEvidenceSigningKey();
  const nextSigner = createEvidenceSigner(next.privateKeyPem);
  const resume = resumePointOf(first.records, nextSigner);
  assert.deepEqual(resume, { seq: 2, headHash: first.records[1].entryHash });
  const log = createInMemoryEvidenceLog({ signer: nextSigner, resume });
  log.append({ kind: 'egress_authorized' });
  const all = [...first.records, ...log.list()];
  const both = verifySignedEvidence(all, { publicKeys: [first.key.publicKeyPem, next.publicKeyPem] });
  assert.equal(both.status, 'VERIFIED');
  assert.equal(both.keyIds.length, 2);
  assert.equal(verifySignedEvidence(all, { publicKeys: [next.publicKeyPem] }).status, 'UNVERIFIABLE');
});

test('resumePointOf refuses a log it cannot vouch for', () => {
  const { signer, records } = signedLog(2);
  const edited = records.map((r, i) => (i === 0 ? { ...r, findingsCount: 7 } : r));
  assert.throws(() => resumePointOf(edited, signer), /does not verify/);
  const reSigned = rechain(records.map((r) => ({ ...r, findingsCount: 7 })));
  assert.throws(() => resumePointOf(reSigned, signer), /fails signature verification/);
  assert.deepEqual(resumePointOf([], signer), { seq: 0, headHash: 'genesis' });
});

test('entries cannot smuggle their own signature fields; bad keys are refused without echoing them', () => {
  const { signer } = signedLog(0);
  const log = createInMemoryEvidenceLog({ signer });
  assert.throws(() => log.append({ signature: 'x' }), /may not carry signature fields/);
  assert.throws(() => createEvidenceSigner('not-a-key-SECRET'), (e) => !String(e.message).includes('SECRET'));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  assert.throws(() => createEvidenceSigner(rsa), /must be Ed25519/);
});

test('independent check: OpenSSL verifies a record signature with no Strix code', { skip: spawnSync('openssl', ['version']).status !== 0 }, () => {
  const { key, records } = signedLog(1);
  const dir = mkdtempSync(join(tmpdir(), 'egress-openssl-'));
  const rec = records[0];
  writeFileSync(join(dir, 'pub.pem'), key.publicKeyPem);
  writeFileSync(join(dir, 'input'), `${EVIDENCE_SIGNATURE_SCHEME}\n${rec.signingKeyId}\n${rec.entryHash}`);
  writeFileSync(join(dir, 'sig'), Buffer.from(rec.signature, 'base64url'));
  const ok = spawnSync('openssl', ['pkeyutl', '-verify', '-pubin', '-inkey', join(dir, 'pub.pem'), '-rawin', '-in', join(dir, 'input'), '-sigfile', join(dir, 'sig')]);
  assert.equal(ok.status, 0, ok.stderr.toString());
  writeFileSync(join(dir, 'input'), `${EVIDENCE_SIGNATURE_SCHEME}\n${rec.signingKeyId}\n${'0'.repeat(64)}`);
  const bad = spawnSync('openssl', ['pkeyutl', '-verify', '-pubin', '-inkey', join(dir, 'pub.pem'), '-rawin', '-in', join(dir, 'input'), '-sigfile', join(dir, 'sig')]);
  assert.notEqual(bad.status, 0);
  // And the key id is reproducible from the public key alone.
  assert.equal(evidenceKeyIdOf(key.publicKeyPem), rec.signingKeyId);
});

test('CLI: keygen writes a 0600 private key and refuses to overwrite; verify exits 0 / 1 / 3 / 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-cli-'));
  const priv = join(dir, 'k.pem');
  const pub = join(dir, 'k.pub.pem');
  const out = execFileSync('node', [PROXY_BIN, 'keygen', '--private-key-out', priv, '--public-key-out', pub], { encoding: 'utf8' });
  assert.match(out, /^egress-[0-9a-f]{32}\n/);
  if (process.platform !== 'win32') assert.equal(statSync(priv).mode & 0o777, 0o600);
  const again = spawnSync('node', [PROXY_BIN, 'keygen', '--private-key-out', priv, '--public-key-out', pub]);
  assert.equal(again.status, 1, 'refuses to overwrite a key');

  const signer = createEvidenceSigner(readFileSync(priv));
  const log = createInMemoryEvidenceLog({ signer });
  log.append({ kind: 'egress_authorized' });
  log.append({ kind: 'egress_refused' });
  const file = join(dir, 'e.jsonl');
  writeFileSync(file, log.list().map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ok = spawnSync('node', [VERIFY_BIN, file, '--public-key', pub], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /VERIFIED/);
  assert.match(ok.stdout, /NOT_PROVEN/);

  const other = join(dir, 'o.pub.pem');
  writeFileSync(other, generateEvidenceSigningKey().publicKeyPem);
  assert.equal(spawnSync('node', [VERIFY_BIN, file, '--public-key', other]).status, 3);

  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  lines[0].kind = 'edited';
  const tampered = join(dir, 't.jsonl');
  writeFileSync(tampered, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(spawnSync('node', [VERIFY_BIN, tampered, '--public-key', pub]).status, 1);
  assert.equal(spawnSync('node', [VERIFY_BIN, file]).status, 2, 'no key: usage error, never a pass');
});

test('proxy: every record is signed, a restart continues the chain, no identifier leaks', async () => {
  const key = generateEvidenceSigningKey();
  const signer = createEvidenceSigner(key.privateKeyPem);
  const TOKEN = 'signed-evidence-test-token-0123456789abcdef';
  const records = [];
  const sent = [];
  const start = (resume) => createEgressProxy({
    policy: HEALTHCARE_REFERENCE_POLICY,
    provider: 'anthropic',
    token: TOKEN,
    model: 'fake-model',
    transportFor: () => ({
      name: 'fake',
      async send(payload) { sent.push(payload); return { responseText: 'ok [PATIENT_001]' }; },
    }),
    evidenceSigner: signer,
    evidenceResume: resume,
    onEvidence: (r) => records.push(r),
    log: () => {},
  });
  const p = SYNTHETIC_PHI;
  const doc = `Patient: ${p.patientName}\nMRN: ${p.mrn}\nEncounter ${p.encounterDate}.`;
  const call = async (proxy) => {
    const server = await proxy.listen({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ model: 'fake-model', max_tokens: 50, messages: [{ role: 'user', content: doc }] }),
      });
      await res.text();
      return res.status;
    } finally {
      server.close();
    }
  };
  assert.equal(await call(start()), 200);
  const firstRun = records.length;
  assert.ok(firstRun > 0);
  assert.equal(await call(start(resumePointOf(records, signer))), 200);
  assert.ok(records.length > firstRun);
  const r = verifySignedEvidence(records, { publicKeys: [key.publicKeyPem] });
  assert.equal(r.status, 'VERIFIED', JSON.stringify(r));
  const haystack = JSON.stringify(records) + JSON.stringify(sent);
  for (const v of Object.values(p)) assert.ok(!haystack.includes(v), 'no synthetic identifier in evidence or provider payload');
});

test('proxy CLI: a signing key without an evidence file refuses to start; so does a tampered existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-bin-'));
  const k = generateEvidenceSigningKey();
  const keyFile = join(dir, 'k.pem');
  writeFileSync(keyFile, k.privateKeyPem, { mode: 0o600 });
  const policy = join(dir, 'policy.json');
  writeFileSync(policy, JSON.stringify(HEALTHCARE_REFERENCE_POLICY));
  const env = { ...process.env, STRIX_EGRESS_PROXY_TOKEN: 'x'.repeat(40), ANTHROPIC_API_KEY: 'test-key-not-real' };
  delete env.STRIX_EGRESS_SIGNING_KEY;
  const noFile = spawnSync('node', [PROXY_BIN, '--policy', policy, '--provider', 'anthropic', '--signing-key-file', keyFile], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(noFile.status, 1);
  assert.match(noFile.stderr, /needs --evidence-file/);

  const signer = createEvidenceSigner(k.privateKeyPem);
  const log = createInMemoryEvidenceLog({ signer });
  log.append({ kind: 'egress_authorized' });
  const recs = log.list().map((r) => ({ ...r }));
  const forged = rechain([{ ...recs[0], kind: 'edited' }]);
  const evFile = join(dir, 'e.jsonl');
  writeFileSync(evFile, `${JSON.stringify(forged[0])}\n`);
  const tampered = spawnSync('node', [PROXY_BIN, '--policy', policy, '--provider', 'anthropic', '--signing-key-file', keyFile, '--evidence-file', evFile], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /fails signature verification/);
  assert.ok(existsSync(evFile));
});

test('a log survives the round trip through a JSONL file (undefined fields were hashed and then lost)', () => {
  const key = generateEvidenceSigningKey();
  const log = createInMemoryEvidenceLog({ signer: createEvidenceSigner(key.privateKeyPem) });
  log.append({ type: 'egress_refused', purpose: undefined, nested: { a: undefined, b: 1 }, list: [1, undefined] });
  log.append({ type: 'egress_authorized', count: 2 });
  const fromFile = log.list().map((r) => JSON.parse(JSON.stringify(r)));
  assert.equal(verifyEvidenceChain(fromFile).valid, true, 'the unsigned chain verifies from the file');
  assert.equal(verifySignedEvidence(fromFile, { publicKeys: [key.publicKeyPem] }).status, 'VERIFIED');
});

test('a real proxy refusal verifies from the file it was written to', async () => {
  const key = generateEvidenceSigningKey();
  const dir = mkdtempSync(join(tmpdir(), 'egress-file-'));
  const file = join(dir, 'e.jsonl');
  const TOKEN = 'file-roundtrip-test-token-0123456789abcdef';
  const proxy = createEgressProxy({
    policy: HEALTHCARE_REFERENCE_POLICY, provider: 'anthropic', token: TOKEN, model: 'fake-model',
    transportFor: () => ({ name: 'fake', async send() { return { responseText: 'ok' }; } }),
    evidenceSigner: createEvidenceSigner(key.privateKeyPem),
    onEvidence: (r) => writeFileSync(file, `${JSON.stringify(r)}\n`, { flag: 'a' }),
    log: () => {},
  });
  const server = await proxy.listen({ port: 0 });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model: 'fake-model', max_tokens: 5, system: `Note on MRN ${SYNTHETIC_PHI.mrn}.`, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  server.close();
  assert.equal(res.status, 422);
  const out = spawnSync('node', [VERIFY_BIN, file, '--public-key', (() => { const p = join(dir, 'k.pub'); writeFileSync(p, key.publicKeyPem); return p; })()], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
});
