/**
 * Origin-scoped, kid-unique JWKS resolution (ADR-011 + ADR-002).
 *
 * The trust root for AC-1 / AA-1 / AA-2 / proof_bundle_v2 signatures is an
 * origin-scoped JWKS: a verifier resolves `(iss, kid) → public key` by fetching
 * the JWKS published at the issuer's origin
 * (`<iss-origin>/.well-known/jwks.json`). Two invariants:
 *
 *  - **Origin scoping (ADR-011):** keys are namespaced by the issuer origin the
 *    payload names — a `kid` from issuer A can never be silently honored for a
 *    payload claiming issuer B. Trust follows the issuer, not a global table.
 *  - **kid-uniqueness (ADR-002, Gate F):** within one origin's JWKS, a `kid`
 *    resolves to exactly one key. A duplicate `kid` is a collision and fails
 *    closed (the resolver refuses to guess which key signed).
 *
 * Only `OKP` / `Ed25519` keys are parsed; the 32-byte raw length is enforced
 * so a malformed `x` can't slip a short key past the verifier.
 */

import type { JwksResolver } from "../transaction-proof/verifier-types.js";

export interface Jwk {
  kty: string;
  crv?: string;
  kid?: string;
  x?: string;
  [k: string]: unknown;
}

export interface JwksDocument {
  keys: Jwk[];
}

function b64urlToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/** Decode an OKP/Ed25519 JWK to its 32-byte raw public key. Throws on malformed. */
export function jwkToRawEd25519(jwk: Jwk): Uint8Array {
  if (jwk.kty !== "OKP") throw new Error(`JWK kty must be 'OKP', got ${String(jwk.kty)}`);
  if (jwk.crv !== "Ed25519") throw new Error(`JWK crv must be 'Ed25519', got ${String(jwk.crv)}`);
  if (typeof jwk.x !== "string" || !jwk.x) throw new Error("JWK is missing the 'x' public-key coordinate");
  const raw = b64urlToBytes(jwk.x);
  if (raw.length !== 32) throw new Error(`Ed25519 public key must be 32 bytes, got ${raw.length}`);
  return raw;
}

/**
 * Parse one origin's JWKS document into a `kid → key` map, enforcing
 * kid-uniqueness (ADR-002). A duplicate `kid` throws a collision error.
 */
export function parseJwksDocument(doc: JwksDocument): Map<string, Uint8Array> {
  if (!doc || !Array.isArray(doc.keys)) throw new Error("JWKS document missing 'keys' array");
  const out = new Map<string, Uint8Array>();
  for (const jwk of doc.keys) {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") continue; // ignore non-Ed25519 entries
    const kid = jwk.kid;
    if (typeof kid !== "string" || !kid) throw new Error("JWKS entry missing 'kid'");
    if (out.has(kid)) {
      // ADR-002 Gate F: kid-uniqueness. Refuse to guess which key signed.
      throw new Error(`kid collision in JWKS: '${kid}' appears more than once (ADR-002 violation)`);
    }
    out.set(kid, jwkToRawEd25519(jwk));
  }
  return out;
}

function originOf(iss: string): string {
  return new URL(iss).origin;
}

/**
 * Origin-scoped resolver. Register each issuer origin's JWKS document; the
 * resolver answers `publicKey(iss, kid)` only when both the origin and the kid
 * match — never cross-origin.
 */
export class OriginScopedJwksResolver implements JwksResolver {
  private readonly byOrigin = new Map<string, Map<string, Uint8Array>>();

  /** Register an issuer origin's JWKS (enforces kid-uniqueness on parse). */
  addOrigin(iss: string, doc: JwksDocument): this {
    this.byOrigin.set(originOf(iss), parseJwksDocument(doc));
    return this;
  }

  publicKey(iss: string, kid: string): Uint8Array | null {
    let origin: string;
    try {
      origin = originOf(iss);
    } catch {
      return null; // iss is not a valid origin URL → fail closed
    }
    return this.byOrigin.get(origin)?.get(kid) ?? null;
  }
}

/** Build an OKP/Ed25519 JWK (with kid) from a raw 32-byte public key. */
export function rawEd25519ToJwk(kid: string, publicKey: Uint8Array): Jwk {
  return { kty: "OKP", crv: "Ed25519", kid, x: Buffer.from(publicKey).toString("base64url") };
}

/**
 * Fetch + register an origin's published JWKS at
 * `<origin>/.well-known/jwks.json`. `fetchImpl` is injectable (the caller owns
 * SSRF/transport concerns); defaults to global `fetch`. Honors origin scoping:
 * the document is bound to the issuer origin it was fetched from.
 */
export async function loadOriginJwks(
  resolver: OriginScopedJwksResolver,
  iss: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OriginScopedJwksResolver> {
  const url = `${originOf(iss)}/.well-known/jwks.json`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`JWKS fetch failed for ${url}: ${res.status}`);
  return resolver.addOrigin(iss, (await res.json()) as JwksDocument);
}
