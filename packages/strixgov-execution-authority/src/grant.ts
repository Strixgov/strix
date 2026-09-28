/**
 * Consumer-side verification of a `strix-execution-authority-v1` grant.
 *
 * `verifyGrant` answers one question: does this artifact prove that Strix
 * issued bounded authority for EXACTLY the execution the consumer is about to
 * perform, and is that authority still live under the trust the consumer
 * holds? Every check is fail-closed and the reasons are the corpus's.
 *
 * It does NOT consume the grant. Single use is enforced centrally by Strix at
 * `.../consume` (and, if the consumer keeps one, by the consumer's own durable
 * claim). A locally VALID grant is a precondition for redemption, never a
 * substitute for it.
 */
import { canonicalJson, CANONICALIZATION } from './canonical.js';
import { BOUND_FIELDS, CAPABILITY, CONTRACT, GRANT_PAYLOAD_KEYS, isHex64, isId, isInstant, isLabel, type CurrentExecution, type GrantPayload, type SignedGrant } from './contract.js';
import { publicKeyFromSpki, verifyEd25519, type AuthorityTrust } from './trust.js';

export const GRANT_REFUSALS = [
  'AUTHORITY_MALFORMED',
  'AUTHORITY_ISSUER_MISMATCH',
  'AUTHORITY_KEY_INVALID',
  'AUTHORITY_SIGNATURE_INVALID',
  'AUTHORITY_REVOKED',
  'AUTHORITY_NOT_YET_VALID',
  'AUTHORITY_EXPIRED',
  'AUTHORITY_LIFETIME_EXCEEDED',
  'AUTHORITY_EXECUTION_MISMATCH',
] as const;
export type GrantRefusal = (typeof GRANT_REFUSALS)[number];

export type GrantVerification =
  | { valid: true; payload: GrantPayload; signingKeyId: string }
  | { valid: false; reason: GrantRefusal; detail: string; mismatchedFields?: string[] };

function own(o: object, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;
}

/** Shape only; no cryptography. Returns the first problem, or null. */
export function grantShapeProblem(grant: unknown): string | null {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return 'grant is not an object';
  const g = grant as Record<string, unknown>;
  if (own(g, 'algorithm') !== 'Ed25519') return 'algorithm is not Ed25519';
  if (own(g, 'canonicalization') !== CANONICALIZATION) return `canonicalization is not ${CANONICALIZATION}`;
  const sig = own(g, 'signature');
  if (typeof sig !== 'string' || !/^[A-Za-z0-9_-]{80,100}$/.test(sig)) return 'signature is not base64url Ed25519';
  const p = own(g, 'payload');
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'payload is not an object';
  const keys = Object.keys(p as object);
  if (keys.length !== GRANT_PAYLOAD_KEYS.length || keys.some((k) => !(GRANT_PAYLOAD_KEYS as readonly string[]).includes(k))) {
    return 'payload does not carry exactly the contract fields';
  }
  const o = p as Record<string, unknown>;
  if (o.schemaVersion !== CONTRACT) return 'schemaVersion is not the execution authority contract';
  if (o.strixCapabilityId !== CAPABILITY) return 'strixCapabilityId is not the execution authority capability';
  for (const k of ['grantId', 'signingKeyId', 'proposalId', 'action', 'consequenceId', 'strixDecisionId'] as const) if (!isId(o[k])) return `${k} is malformed`;
  for (const k of ['tenantId', 'principalId', 'executionRoute'] as const) if (!isLabel(o[k])) return `${k} is malformed`;
  for (const k of ['payloadCommitment', 'currentStateCommitment'] as const) if (!isHex64(o[k])) return `${k} is not a 64-hex hash`;
  if (typeof o.issuer !== 'string' || !/^https:\/\/[^\s/]+$/.test(o.issuer)) return 'issuer is not an https origin';
  for (const k of ['issuedAt', 'notBefore', 'expiresAt'] as const) if (!isInstant(o[k])) return `${k} is not an ISO instant`;
  for (const k of ['approvalsRequired', 'approvalsGranted'] as const) {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 20) return `${k} is not a bounded integer`;
  }
  if ((o.approvalsGranted as number) < (o.approvalsRequired as number)) return 'approvalsGranted is below approvalsRequired';
  if (o.singleUse !== true) return 'singleUse is not true';
  if (Date.parse(o.notBefore as string) > Date.parse(o.expiresAt as string)) return 'notBefore is after expiresAt';
  return null;
}

/**
 * Verify a grant against held trust and the execution the consumer is about
 * to perform. Order: shape, issuer, key, signature, key status and window,
 * revocation, lifetime, time window, then the eight bound fields.
 */
export function verifyGrant(grant: unknown, trust: AuthorityTrust, expected: CurrentExecution, asOf: Date = new Date()): GrantVerification {
  const shape = grantShapeProblem(grant);
  if (shape) return { valid: false, reason: 'AUTHORITY_MALFORMED', detail: shape };
  const g = grant as SignedGrant;
  const p = g.payload;
  if (p.issuer !== trust.issuer) return { valid: false, reason: 'AUTHORITY_ISSUER_MISMATCH', detail: `grant names issuer ${p.issuer}` };
  const candidates = trust.keys.filter((k) => k.kid === p.signingKeyId);
  if (candidates.length === 0) return { valid: false, reason: 'AUTHORITY_KEY_INVALID', detail: `no trusted authority key ${p.signingKeyId}` };
  const canonical = canonicalJson(p);
  const key = candidates.find((k) => verifyEd25519(canonical, g.signature, publicKeyFromSpki(k.publicKeySpkiBase64)));
  if (!key) return { valid: false, reason: 'AUTHORITY_SIGNATURE_INVALID', detail: 'signature does not verify under the trusted key' };
  if (trust.revocations.keyIds.includes(key.kid)) return { valid: false, reason: 'AUTHORITY_REVOKED', detail: `signing key ${key.kid} is revoked` };
  if (key.status !== 'active') return { valid: false, reason: 'AUTHORITY_KEY_INVALID', detail: `signing key ${key.kid} is ${key.status}` };
  const issued = Date.parse(p.issuedAt);
  if (issued < Date.parse(key.notBefore) || issued >= Date.parse(key.notAfter)) {
    return { valid: false, reason: 'AUTHORITY_KEY_INVALID', detail: 'grant was issued outside the key window' };
  }
  if (trust.revocations.grantIds.includes(p.grantId)) return { valid: false, reason: 'AUTHORITY_REVOKED', detail: `grant ${p.grantId} is revoked` };
  if (Date.parse(p.expiresAt) - Date.parse(p.notBefore) > trust.maxLifetimeMs) {
    return { valid: false, reason: 'AUTHORITY_LIFETIME_EXCEEDED', detail: `window exceeds ${trust.maxLifetimeMs}ms` };
  }
  const now = asOf.getTime();
  if (now < Date.parse(p.notBefore)) return { valid: false, reason: 'AUTHORITY_NOT_YET_VALID', detail: `valid from ${p.notBefore}` };
  if (now >= Date.parse(p.expiresAt)) return { valid: false, reason: 'AUTHORITY_EXPIRED', detail: `expired ${p.expiresAt}` };
  if (!expected || typeof expected !== 'object') return { valid: false, reason: 'AUTHORITY_EXECUTION_MISMATCH', detail: 'no execution presented', mismatchedFields: [...BOUND_FIELDS] };
  const presented = expected as Record<string, unknown>;
  const extra = Object.keys(presented).filter((k) => !(BOUND_FIELDS as readonly string[]).includes(k));
  const mismatched = BOUND_FIELDS.filter((k) => presented[k] !== p[k]);
  if (extra.length || mismatched.length) {
    return {
      valid: false,
      reason: 'AUTHORITY_EXECUTION_MISMATCH',
      detail: `the presented execution differs from the authorized one on: ${[...mismatched, ...extra].sort().join(',')}`,
      mismatchedFields: [...mismatched, ...extra].sort(),
    };
  }
  return { valid: true, payload: p, signingKeyId: key.kid };
}
