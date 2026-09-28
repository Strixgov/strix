/**
 * Trust for the authority boundary: which keys may sign a grant, and which
 * grants and keys have since been revoked.
 *
 * Both come from Strix's published documents, never from the grant. The key
 * set is `/.well-known/strix-authority-keys.json` (a SIBLING of the evidence
 * JWKS, never the same keys); the revocation state is the signed
 * `strix-authority-revocation-v1` document at `/api/public/authority/revocations`,
 * re-signed on every fetch with a short `validUntil`.
 *
 * Silence is never "nothing revoked": a consumer that cannot obtain a current
 * revocation document does not hold trust, and a stale one is refused.
 */
import crypto from 'node:crypto';
import { canonicalJson, CANONICALIZATION } from './canonical.js';

export const KEY_PURPOSE = 'strix-authority-grant' as const;
export const REVOCATION_CONTRACT = 'strix-authority-revocation-v1' as const;

export type KeyStatus = 'active' | 'retired' | 'revoked';

export interface TrustedKey {
  kid: string;
  /** SPKI DER, base64. */
  publicKeySpkiBase64: string;
  status: KeyStatus;
  notBefore: string;
  notAfter: string;
}

export interface Revocations {
  keyIds: string[];
  grantIds: string[];
}

/** Everything `verifyGrant` needs, and nothing a grant could supply. */
export interface AuthorityTrust {
  issuer: string;
  keys: TrustedKey[];
  revocations: Revocations;
  /** A grant whose window exceeds this is refused whatever it says. */
  maxLifetimeMs: number;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function spkiFromJwkX(x: string): string {
  const raw = Buffer.from(x, 'base64url');
  if (raw.length !== 32) throw new Error('KEY_MALFORMED: x is not 32 bytes');
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]).toString('base64');
}

export function publicKeyFromSpki(spkiBase64: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
}

export function verifyEd25519(canonical: string, signatureBase64url: string, key: crypto.KeyObject): boolean {
  try {
    return crypto.verify(null, Buffer.from(canonical, 'utf8'), key, Buffer.from(signatureBase64url, 'base64url'));
  } catch {
    return false;
  }
}

/** Parse Strix's published authority key set into trusted keys. Refuses keys published for any other purpose. */
export function keysFromKeySetDocument(doc: unknown): { issuer: string; keys: TrustedKey[] } {
  if (!doc || typeof doc !== 'object') throw new Error('KEY_SET_MALFORMED: not an object');
  const d = doc as Record<string, unknown>;
  if (d.contractVersion !== 1 || d.purpose !== KEY_PURPOSE || typeof d.issuer !== 'string' || !Array.isArray(d.keys)) {
    throw new Error('KEY_SET_MALFORMED: not a strix-authority-grant key set');
  }
  const keys: TrustedKey[] = [];
  for (const k of d.keys as Record<string, unknown>[]) {
    if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || k.purpose !== KEY_PURPOSE || typeof k.x !== 'string' || typeof k.kid !== 'string') {
      throw new Error('KEY_SET_MALFORMED: a key is not an Ed25519 authority key');
    }
    if (k.status !== 'active' && k.status !== 'retired' && k.status !== 'revoked') throw new Error(`KEY_SET_MALFORMED: unknown status for ${k.kid}`);
    if (typeof k.notBefore !== 'string' || typeof k.notAfter !== 'string') throw new Error(`KEY_SET_MALFORMED: ${k.kid} has no validity window`);
    keys.push({ kid: k.kid, publicKeySpkiBase64: spkiFromJwkX(k.x), status: k.status, notBefore: k.notBefore, notAfter: k.notAfter });
  }
  return { issuer: d.issuer, keys };
}

export interface RevocationDocument {
  payload: {
    schemaVersion: typeof REVOCATION_CONTRACT;
    issuer: string;
    signingKeyId: string;
    generation: number;
    publishedAt: string;
    validUntil: string;
    revokedGrantIds: string[];
    revokedKeyIds: string[];
  };
  signature: string;
  algorithm: 'Ed25519';
  canonicalization: string;
}

export type RevocationVerdict =
  | { ok: true; revocations: Revocations; generation: number; validUntil: string }
  | { ok: false; reason: 'REVOCATION_MALFORMED' | 'REVOCATION_ISSUER_MISMATCH' | 'REVOCATION_KEY_UNKNOWN' | 'REVOCATION_SIGNATURE_INVALID' | 'REVOCATION_STALE' | 'REVOCATION_GENERATION_REGRESSED'; detail: string };

const REVOCATION_KEYS = ['schemaVersion', 'issuer', 'signingKeyId', 'generation', 'publishedAt', 'validUntil', 'revokedGrantIds', 'revokedKeyIds'];

/**
 * Verify the signed revocation document under the published keys. A revoked
 * key may still sign the revocation document that revokes it; a key must
 * merely be published, and the document must be current and non-regressing.
 */
export function verifyRevocationDocument(
  doc: unknown,
  trust: { issuer: string; keys: readonly TrustedKey[]; asOf: Date; minGeneration?: number },
): RevocationVerdict {
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'REVOCATION_MALFORMED', detail: 'not an object' };
  const d = doc as Record<string, unknown>;
  if (d.algorithm !== 'Ed25519' || typeof d.signature !== 'string' || typeof d.canonicalization !== 'string') {
    return { ok: false, reason: 'REVOCATION_MALFORMED', detail: 'envelope is not an Ed25519 document' };
  }
  if (d.canonicalization !== 'rcm-canonical-json-v1' && d.canonicalization !== CANONICALIZATION) {
    return { ok: false, reason: 'REVOCATION_MALFORMED', detail: 'unsupported canonicalization' };
  }
  const p = d.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'REVOCATION_MALFORMED', detail: 'payload is not an object' };
  const keys = Object.keys(p);
  if (keys.length !== REVOCATION_KEYS.length || keys.some((k) => !REVOCATION_KEYS.includes(k))) {
    return { ok: false, reason: 'REVOCATION_MALFORMED', detail: 'payload does not carry exactly the contract fields' };
  }
  if (p.schemaVersion !== REVOCATION_CONTRACT) return { ok: false, reason: 'REVOCATION_MALFORMED', detail: 'unsupported schemaVersion' };
  if (typeof p.generation !== 'number' || !Number.isSafeInteger(p.generation) || p.generation < 0) return { ok: false, reason: 'REVOCATION_MALFORMED', detail: 'generation' };
  if (!Array.isArray(p.revokedGrantIds) || !Array.isArray(p.revokedKeyIds)) return { ok: false, reason: 'REVOCATION_MALFORMED', detail: 'lists' };
  if (typeof p.publishedAt !== 'string' || typeof p.validUntil !== 'string' || !Number.isFinite(Date.parse(p.validUntil))) {
    return { ok: false, reason: 'REVOCATION_MALFORMED', detail: 'window' };
  }
  if (p.issuer !== trust.issuer) return { ok: false, reason: 'REVOCATION_ISSUER_MISMATCH', detail: 'document names another issuer' };
  const key = trust.keys.find((k) => k.kid === p.signingKeyId);
  if (!key) return { ok: false, reason: 'REVOCATION_KEY_UNKNOWN', detail: `no published key ${String(p.signingKeyId)}` };
  if (!verifyEd25519(canonicalJson(p), d.signature, publicKeyFromSpki(key.publicKeySpkiBase64))) {
    return { ok: false, reason: 'REVOCATION_SIGNATURE_INVALID', detail: 'signature does not verify' };
  }
  if (trust.asOf.getTime() >= Date.parse(p.validUntil)) return { ok: false, reason: 'REVOCATION_STALE', detail: `validUntil ${p.validUntil}` };
  if (trust.minGeneration !== undefined && p.generation < trust.minGeneration) {
    return { ok: false, reason: 'REVOCATION_GENERATION_REGRESSED', detail: `generation ${p.generation} < ${trust.minGeneration}` };
  }
  return {
    ok: true,
    revocations: { grantIds: (p.revokedGrantIds as string[]).slice(), keyIds: (p.revokedKeyIds as string[]).slice() },
    generation: p.generation,
    validUntil: p.validUntil,
  };
}

export const DEFAULT_MAX_LIFETIME_MS = 60 * 60 * 1000;

/** Compose trust from the two published documents. Throws (never guesses) when either cannot be trusted. */
export function trustFromDocuments(
  keySet: unknown,
  revocationDoc: unknown,
  opts: { expectedIssuer: string; asOf?: Date; minGeneration?: number; maxLifetimeMs?: number },
): { trust: AuthorityTrust; generation: number; validUntil: string } {
  const { issuer, keys } = keysFromKeySetDocument(keySet);
  if (issuer !== opts.expectedIssuer) throw new Error(`KEY_SET_ISSUER_MISMATCH: published issuer ${issuer} is not ${opts.expectedIssuer}`);
  const rv = verifyRevocationDocument(revocationDoc, { issuer, keys, asOf: opts.asOf ?? new Date(), minGeneration: opts.minGeneration });
  if (!rv.ok) throw new Error(`${rv.reason}: ${rv.detail}`);
  return {
    trust: { issuer, keys, revocations: rv.revocations, maxLifetimeMs: opts.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS },
    generation: rv.generation,
    validUntil: rv.validUntil,
  };
}
