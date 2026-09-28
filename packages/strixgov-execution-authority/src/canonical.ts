/**
 * `strix-canonical-json-v1`: the byte form every Strix authority artifact is
 * signed over. Sorted keys at every depth, no whitespace, JSON string escaping,
 * finite numbers only. Byte-identical to `rcm-canonical-json-v1`.
 *
 * This is an independent implementation. It shares no code with the Strix
 * issuer; the conformance corpus under `conformance/corpus/execution_authority_v1`
 * is what keeps the two in agreement.
 */
import { createHash } from 'node:crypto';

export const CANONICALIZATION = 'strix-canonical-json-v1' as const;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('UNSUPPORTED_CANONICAL_VALUE');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new Error('UNSUPPORTED_CANONICAL_VALUE');
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Content address of any JSON value under the canonical form. */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
