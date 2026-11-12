// Evidence completeness (2026-11-11). A signature proves each record present
// was written by the key holder; it says nothing about records that are NOT
// present. These tests pin that a truncated log is never reported complete
// without an anchor obtained outside the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInMemoryEvidenceLog,
  createEvidenceSigner,
  generateEvidenceSigningKey,
  verifySignedEvidence,
} from '../src/index.mjs';

const VERIFY_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'strix-egress-verify-evidence.mjs');

function signedLog(n, key = generateEvidenceSigningKey()) {
  const log = createInMemoryEvidenceLog({ signer: createEvidenceSigner(key.privateKeyPem) });
  for (let i = 0; i < n; i += 1) log.append({ type: 'egress_attempt', n: i });
  return { key, log, records: log.list() };
}

test('a log missing its final record still verifies signatures but is NOT reported complete', () => {
  const { key, records } = signedLog(5);
  const truncated = records.slice(0, 4);
  const r = verifySignedEvidence(truncated, { publicKeys: [key.publicKeyPem] });
  assert.equal(r.status, 'VERIFIED');
  assert.equal(r.completeness, 'NOT_PROVEN');
  assert.equal(r.proves, 'SIGNED_BY_KEY_HOLDER', 'signature validity is never relabelled as completeness');
});

test('the missing final record is caught by the expected head and by the expected length', () => {
  const { key, records } = signedLog(5);
  const truncated = records.slice(0, 4);
  const byHead = verifySignedEvidence(truncated, { publicKeys: [key.publicKeyPem], expectedHeadHash: records[4].entryHash });
  assert.equal(byHead.status, 'INVALID');
  assert.equal(byHead.reasonCode, 'HEAD_MISMATCH');
  const byLength = verifySignedEvidence(truncated, { publicKeys: [key.publicKeyPem], expectedLength: 5 });
  assert.equal(byLength.status, 'INVALID');
  assert.equal(byLength.reasonCode, 'LENGTH_MISMATCH');
  assert.equal(byLength.completeness, 'NOT_PROVEN');
});

test('a tail truncated by several records is caught by either anchor', () => {
  const { key, records } = signedLog(8);
  const truncated = records.slice(0, 3);
  assert.equal(verifySignedEvidence(truncated, { publicKeys: [key.publicKeyPem], expectedHeadHash: records[7].entryHash }).reasonCode, 'HEAD_MISMATCH');
  assert.equal(verifySignedEvidence(truncated, { publicKeys: [key.publicKeyPem], expectedLength: 8 }).reasonCode, 'LENGTH_MISMATCH');
});

test('records appended after the anchor was taken are also refused', () => {
  const { key, log, records } = signedLog(3);
  const anchorHead = records[2].entryHash;
  log.append({ type: 'egress_attempt', n: 99 });
  const longer = log.list();
  assert.equal(verifySignedEvidence(longer, { publicKeys: [key.publicKeyPem], expectedHeadHash: anchorHead }).reasonCode, 'HEAD_MISMATCH');
  assert.equal(verifySignedEvidence(longer, { publicKeys: [key.publicKeyPem], expectedLength: 3 }).reasonCode, 'LENGTH_MISMATCH');
});

test('a complete log with both anchors reports the stronger one', () => {
  const { key, records } = signedLog(4);
  const len = verifySignedEvidence(records, { publicKeys: [key.publicKeyPem], expectedLength: 4 });
  assert.equal(len.completeness, 'LENGTH_MATCHED');
  const both = verifySignedEvidence(records, { publicKeys: [key.publicKeyPem], expectedLength: 4, expectedHeadHash: records[3].entryHash });
  assert.equal(both.completeness, 'HEAD_MATCHED');
});

test('a malformed expected length is a usage error, never a silent pass', () => {
  const { key, records } = signedLog(2);
  for (const bad of [0, -1, 1.5, '2', NaN]) {
    assert.throws(() => verifySignedEvidence(records, { publicKeys: [key.publicKeyPem], expectedLength: bad }), /positive integer/);
  }
});

function cli(args) {
  return spawnSync(process.execPath, [VERIFY_BIN, ...args], { encoding: 'utf8' });
}

test('the verifier CLI reports an unanchored truncated log as VERIFIED but NOT_PROVEN, and fails it with an anchor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-completeness-'));
  const { key, records } = signedLog(5);
  const pub = join(dir, 'key.pub.pem');
  writeFileSync(pub, key.publicKeyPem);
  const log = join(dir, 'truncated.jsonl');
  writeFileSync(log, records.slice(0, 4).map((r) => JSON.stringify(r)).join('\n') + '\n');

  const plain = cli([log, '--public-key', pub]);
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /completeness:\s+NOT_PROVEN/);

  const length = cli([log, '--public-key', pub, '--expect-length', '5']);
  assert.equal(length.status, 1);
  assert.match(length.stdout, /LENGTH_MISMATCH/);

  const head = cli([log, '--public-key', pub, '--expect-head', records[4].entryHash]);
  assert.equal(head.status, 1);
  assert.match(head.stdout, /HEAD_MISMATCH/);

  assert.equal(cli([log, '--public-key', pub, '--expect-length', '0']).status, 2);
});
