/**
 * Content addressing for governed egress.
 *
 * One internal form, one wire form, explicit conversion points — the
 * connectorManifestHash prefixed-vs-bare lesson: a hash that can be pasted
 * between surfaces in two spellings and still "validate" is how a content
 * binding silently stops binding. Internally every hash is BARE 64-hex;
 * receipts and other wire surfaces carry the `sha256:`-prefixed form via
 * prefixedHash(). Nothing in this package compares a prefixed form to a bare
 * form.
 */
import { createHash } from 'node:crypto';

const BARE_SHA256 = /^[0-9a-f]{64}$/;

/** sha256 over UTF-8 text or raw bytes; returns bare lowercase hex. */
export function sha256Hex(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('sha256Hex: input must be a string or Buffer');
  }
  return createHash('sha256').update(buf).digest('hex');
}

/** Bare hex -> the `sha256:<hex>` wire form. Refuses anything else. */
export function prefixedHash(bareHex) {
  if (typeof bareHex !== 'string' || !BARE_SHA256.test(bareHex)) {
    throw new TypeError('prefixedHash: expected bare 64-hex sha256');
  }
  return `sha256:${bareHex}`;
}

/** True iff the value is a bare 64-hex sha256. */
export function isBareHash(value) {
  return typeof value === 'string' && BARE_SHA256.test(value);
}
