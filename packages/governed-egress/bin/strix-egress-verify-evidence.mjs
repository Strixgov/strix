#!/usr/bin/env node
/**
 * strix-egress-verify-evidence — check a signed evidence log offline.
 *
 *   strix-egress-verify-evidence evidence.jsonl --public-key key.pub.pem
 *       [--public-key older.pub.pem] [--expect-head <entryHash>] [--json]
 *
 * Needs only the log and the public key(s) YOU trust — no network, no
 * Strix account. Exit codes:
 *   0  VERIFIED      chain intact and every record signed by a trusted key
 *   1  INVALID       the log is wrong (edited, reordered, re-chained,
 *                    unsigned, bad signature, or not the expected head)
 *   3  UNVERIFIABLE  a record is signed by a key you did not supply
 *   2  usage error
 *
 * What VERIFIED does not mean is printed on every run: the key holder
 * recorded these entries, not that the detector was right or that nothing
 * was cut off the end (unless --expect-head matched).
 */
import { readFileSync } from 'node:fs';
import { verifySignedEvidence } from '../src/evidence/signing.mjs';

const USAGE = 'usage: strix-egress-verify-evidence <evidence.jsonl> --public-key <pem> [--public-key <pem>...] [--expect-head <hash>] [--json]';

function parseArgs(argv) {
  const out = { publicKeys: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--public-key') out.publicKeys.push(next());
    else if (a === '--expect-head') out.expectHead = next();
    else if (a === '--json') out.json = true;
    else if (a.startsWith('--')) throw new Error(`unknown argument ${a}`);
    else if (out.file) throw new Error('only one evidence file');
    else out.file = a;
  }
  if (!out.file) throw new Error('an evidence file is required');
  if (out.publicKeys.length === 0) throw new Error('at least one --public-key is required: a signature checked against a key taken from the log itself proves nothing');
  return out;
}

let args;
let records;
let publicKeys;
try {
  args = parseArgs(process.argv.slice(2));
  publicKeys = args.publicKeys.map((p) => readFileSync(p));
  records = readFileSync(args.file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`line ${i + 1} is not JSON`);
      }
    });
} catch (err) {
  process.stderr.write(`${err.message}\n${USAGE}\n`);
  process.exit(2);
}

let result;
try {
  result = verifySignedEvidence(records, { publicKeys, expectedHeadHash: args.expectHead });
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}

if (args.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (result.valid) {
  process.stdout.write(
    [
      `VERIFIED  ${result.length} records, head ${result.headHash}`,
      `signed by ${result.keyIds.join(', ')}`,
      `proves:        ${result.proves} (these entries were recorded by the key holder and not changed since)`,
      `completeness:  ${result.completeness}${result.completeness === 'NOT_PROVEN' ? ' (records cut off the end would go unnoticed; pass --expect-head with a head you obtained separately)' : ''}`,
      'not proven:    that the detector found every identifier, or that the key holder was honest',
      '',
    ].join('\n'),
  );
} else {
  process.stdout.write(`${result.status}  ${result.reasonCode} at record ${result.index}\n${result.detail}\n`);
}
process.exit(result.valid ? 0 : result.status === 'UNVERIFIABLE' ? 3 : 1);
