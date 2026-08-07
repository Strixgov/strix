/**
 * SHA-256 and UUID primitives with a Node-18 fallback.
 *
 * WHY THIS FILE EXISTS. `package.json` declares `engines: { node: ">=18" }`,
 * but `globalThis.crypto` is only exposed on Node 18 under
 * `--experimental-global-webcrypto` — it became available unflagged in Node
 * 19. A bare `crypto.subtle.digest(...)` therefore throws on an ordinary Node
 * 18 process, and every governed call hashes its payload, so the failure is
 * not confined to any one feature: it is the package's primary path. Rather
 * than raise the declared minimum, both helpers here PREFER Web Crypto (so
 * browsers and Node 19+ are unchanged) and fall back to `node:crypto`.
 *
 * The fallback is byte-identical by construction — SHA-256 is SHA-256, and
 * `randomUUID` is RFC 4122 either way — so nothing a hash or id is bound to
 * changes depending on which branch runs. That is the property that makes
 * this safe to put underneath a value that reaches the wire.
 *
 * The `node:crypto` import is dynamic and reached only when `subtle` is
 * absent, matching how `trace-history.ts` already defers its `node:fs` and
 * `node:path` imports so the module stays loadable where they do not exist.
 */

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 over a UTF-8 string, lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  // Structurally typed rather than via the DOM `SubtleCrypto` lib type: this
  // package compiles without `lib: DOM`, and only `digest` is used here.
  const subtle = (
    globalThis.crypto as
      | { subtle?: { digest(alg: string, data: Uint8Array): Promise<ArrayBuffer> } }
      | undefined
  )?.subtle;
  if (subtle) {
    return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

/** An RFC 4122 v4 UUID. */
export async function randomUuid(): Promise<string> {
  const c = globalThis.crypto as
    | { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array }
    | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = toHex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const { randomUUID } = await import('node:crypto');
  return randomUUID();
}
