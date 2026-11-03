/**
 * Signed self-hosted evidence (Ed25519).
 *
 * WHY THIS EXISTS. The hash chain in log.mjs is tamper-EVIDENT against a
 * partial edit but not against a rewrite: whoever can edit the file can
 * rebuild a self-consistent chain (`proves: 'INTERNAL_CONSISTENCY_ONLY'`).
 * Signing each record with a key that the people who can edit the file do
 * not hold closes that gap. A record now names the key that signed it
 * (`signingKeyId`, inside the hashed content) and carries an Ed25519
 * `signature` over its own entryHash, so a rebuilt chain fails
 * verification unless the rewriter also holds the private key.
 *
 * THE KEY IS THE CUSTOMER'S. It is generated and held in the customer's
 * environment; Strix never sees it and there is no network call anywhere in
 * signing or verification. That is the point of self-hosting and also the
 * honest limit of what a signature proves, stated as literal fields on every
 * result:
 *
 *   - `proves: 'SIGNED_BY_KEY_HOLDER'` — every record was signed by the
 *     holder of a trusted key and not changed since. It does NOT prove the
 *     key holder was honest, that the detector was right, or anything about
 *     a record's content beyond "this is what the proxy recorded".
 *   - `completeness: 'NOT_PROVEN'` — deleting records from the END of a
 *     file leaves a shorter log that still verifies. Only a head hash the
 *     reader obtained independently (`expectedHeadHash`) turns that into
 *     'HEAD_MATCHED'. Deleting from the middle or the start is detected.
 *
 * FORMAT (frozen as scheme v1 — any change is a new scheme id):
 *   keyId          = 'egress-' + hex(sha256(raw 32-byte public key))[0:32]
 *   signing input  = UTF-8 of `${SCHEME}\n${keyId}\n${entryHash}`
 *   signature      = base64url(Ed25519(signing input))
 * The input is a plain string so a reader can check a signature with
 * nothing but OpenSSL (see README "Signed evidence").
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import { verifyEvidenceChain } from './log.mjs';

export const EVIDENCE_SIGNATURE_SCHEME = 'strix-egress-evidence-ed25519-v1';
export const SIGNED_EVIDENCE_PROVES = 'SIGNED_BY_KEY_HOLDER';

const KEY_ID_PATTERN = /^egress-[0-9a-f]{32}$/;
const ENTRY_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/; // 64 bytes, base64url, unpadded

function rawPublicKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new TypeError('evidence signing key must be Ed25519');
  }
  return Buffer.from(jwk.x, 'base64url');
}

/** The content address of a public key: stable, derived, never chosen. */
export function evidenceKeyIdOf(publicKey) {
  const key = typeof publicKey === 'string' || Buffer.isBuffer(publicKey) ? createPublicKey(publicKey) : publicKey;
  return `egress-${createHash('sha256').update(rawPublicKey(key)).digest('hex').slice(0, 32)}`;
}

export function evidenceSigningInput(keyId, entryHash) {
  return Buffer.from(`${EVIDENCE_SIGNATURE_SCHEME}\n${keyId}\n${entryHash}`, 'utf8');
}

/**
 * Generate a new evidence signing key pair (PEM strings). The caller is
 * responsible for storing the private key where the people who can edit the
 * evidence file cannot read it.
 */
export function generateEvidenceSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyId: evidenceKeyIdOf(publicKey),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
  };
}

/**
 * @param {string|Buffer} privateKeyPem PKCS8 PEM of an Ed25519 key.
 * @returns {{ keyId: string, publicKeyPem: string, sign(entryHash: string): string }}
 */
export function createEvidenceSigner(privateKeyPem) {
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    // Never echo the input: it is key material.
    throw new TypeError('evidence signing key could not be parsed (expected an Ed25519 PKCS8 PEM)');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('evidence signing key must be Ed25519');
  }
  const publicKey = createPublicKey(privateKey);
  const keyId = evidenceKeyIdOf(publicKey);
  return Object.freeze({
    keyId,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
    sign(entryHash) {
      if (!ENTRY_HASH_PATTERN.test(entryHash)) throw new TypeError('entryHash must be 64 lowercase hex characters');
      return edSign(null, evidenceSigningInput(keyId, entryHash), privateKey).toString('base64url');
    },
  });
}

function trustedKeyMap(publicKeys) {
  const map = new Map();
  for (const pem of publicKeys ?? []) {
    let key;
    try {
      key = createPublicKey(pem);
    } catch {
      throw new TypeError('a trusted public key could not be parsed (expected an Ed25519 SPKI PEM)');
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('trusted public keys must be Ed25519');
    map.set(evidenceKeyIdOf(key), key);
  }
  return map;
}

/**
 * Verify a signed evidence log against keys the READER trusts.
 *
 * Order: the hash chain first (an edited, removed or reordered record fails
 * here), then every record's signature. Status vocabulary:
 *   VERIFIED     — chain valid and every record signed by a trusted key.
 *   INVALID      — the log is wrong: broken chain, a missing or malformed
 *                  signature, a signature that does not verify, or a head
 *                  that does not match `expectedHeadHash`.
 *   UNVERIFIABLE — a record names a key the reader was not given. We cannot
 *                  check it; that is not the same as proving it wrong.
 * An empty log is never VERIFIED: a check over nothing proves nothing.
 *
 * @param {Array<object>} records
 * @param {{ publicKeys: Array<string|Buffer>, expectedHeadHash?: string }} options
 */
export function verifySignedEvidence(records, options = {}) {
  const base = { proves: SIGNED_EVIDENCE_PROVES, scheme: EVIDENCE_SIGNATURE_SCHEME };
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const trusted = trustedKeyMap(options.publicKeys);
  if (trusted.size === 0) throw new TypeError('at least one trusted public key is required');

  const fail = (status, index, reasonCode, detail) => ({
    ...base, status, valid: false, index, reasonCode, detail, completeness: 'NOT_PROVEN',
  });

  if (records.length === 0) return fail('INVALID', -1, 'EMPTY_LOG', 'the log has no records; an empty log proves nothing');

  const chain = verifyEvidenceChain(records);
  if (!chain.valid) return fail('INVALID', chain.index, chain.reasonCode, chain.detail);

  const keysUsed = new Set();
  for (let i = 0; i < records.length; i += 1) {
    const { signingKeyId, signature, entryHash } = records[i];
    if (signingKeyId === undefined && signature === undefined) {
      return fail('INVALID', i, 'UNSIGNED_RECORD', `record ${i} carries no signature; a signed log must be signed throughout (start a new file when you enable signing)`);
    }
    if (typeof signingKeyId !== 'string' || !KEY_ID_PATTERN.test(signingKeyId)) {
      return fail('INVALID', i, 'MALFORMED_KEY_ID', `record ${i} has a missing or malformed signingKeyId`);
    }
    if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) {
      return fail('INVALID', i, 'MALFORMED_SIGNATURE', `record ${i} has a missing or malformed signature`);
    }
    const key = trusted.get(signingKeyId);
    if (!key) {
      return fail('UNVERIFIABLE', i, 'KEY_NOT_TRUSTED', `record ${i} was signed by ${signingKeyId}, which is not among the keys supplied to the verifier`);
    }
    const ok = edVerify(null, evidenceSigningInput(signingKeyId, entryHash), key, Buffer.from(signature, 'base64url'));
    if (!ok) {
      return fail('INVALID', i, 'SIGNATURE_INVALID', `record ${i}'s signature does not verify under ${signingKeyId}`);
    }
    keysUsed.add(signingKeyId);
  }

  let completeness = 'NOT_PROVEN';
  if (options.expectedHeadHash !== undefined) {
    if (options.expectedHeadHash !== chain.headHash) {
      return fail('INVALID', records.length - 1, 'HEAD_MISMATCH', `the log ends at ${chain.headHash.slice(0, 12)}…, not the expected head ${String(options.expectedHeadHash).slice(0, 12)}… — records were removed from the end, or added`);
    }
    completeness = 'HEAD_MATCHED';
  }
  return {
    ...base,
    status: 'VERIFIED',
    valid: true,
    length: records.length,
    headHash: chain.headHash,
    keyIds: [...keysUsed],
    completeness,
  };
}

/**
 * Read where an existing log ends so a restarted proxy continues the same
 * chain instead of starting a second 'genesis' inside one file (which would
 * make the whole file fail verification). The existing records must verify
 * as a chain; records signed by `signer` must verify under it. Anything
 * else throws, and the caller should refuse to start rather than append to
 * a log it cannot vouch for.
 *
 * @returns {{ seq: number, headHash: string }}
 */
export function resumePointOf(records, signer) {
  if (records.length === 0) return { seq: 0, headHash: 'genesis' };
  const chain = verifyEvidenceChain(records);
  if (!chain.valid) {
    throw new Error(`existing evidence log does not verify (${chain.reasonCode} at record ${chain.index}); rotate the file rather than appending to it`);
  }
  if (signer) {
    const key = createPublicKey(signer.publicKeyPem);
    for (const r of records) {
      if (r.signingKeyId !== signer.keyId) continue; // an earlier key (rotation) or an unsigned prefix
      const sig = typeof r.signature === 'string' && SIGNATURE_PATTERN.test(r.signature) ? Buffer.from(r.signature, 'base64url') : null;
      if (!sig || !edVerify(null, evidenceSigningInput(r.signingKeyId, r.entryHash), key, sig)) {
        throw new Error(`existing evidence log record ${r.seq} fails signature verification under the current key; rotate the file`);
      }
    }
  }
  const last = records[records.length - 1];
  return { seq: last.seq, headHash: last.entryHash };
}
