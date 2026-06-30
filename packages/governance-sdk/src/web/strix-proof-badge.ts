/**
 * `<strix-proof-badge>` — embeddable proof badge (ADR-017 visual contract).
 *
 * The verdict is reproduced CLIENT-SIDE by the SDK verifier, not trusted from
 * the server: the badge fetches the signed AC-1 bundle + the issuer's published
 * JWKS, resolves the key origin-scoped, and runs `verifyTransactionProof` in
 * the browser. The server is only transport — a tampered bundle or a swapped
 * server verdict cannot make the badge say VERIFIED.
 *
 *   <strix-proof-badge evidence-id="ev-ac1-1"
 *                      endpoint="https://www.strixgov.com/api/transaction-proof/verify">
 *   </strix-proof-badge>
 *
 * Crypto is WebCrypto Ed25519 (available in browsers and Node ≥20), so the
 * component carries zero Node-only dependencies. Because WebCrypto is async and
 * the SDK verifier is synchronous, the badge runs an async pre-pass that
 * resolves every signature, then verifies through a memoized sync adapter.
 */

import { renderTransactionBlock, type TransactionBlock } from "../transaction-proof/transaction-block.js";
import { recordFromView } from "../transaction-proof/parse.js";
import { verifyTransactionProof } from "../transaction-proof/verifier.js";
import { canonicalize } from "../transaction-proof/canonical.js";
import { actorPayloadToDict } from "../transaction-proof/actor-attestation.js";
import { devicePayloadToDict } from "../transaction-proof/device-attestation.js";
import { payloadCanonicalBytes } from "../transaction-proof/types.js";
import { OriginScopedJwksResolver, type JwksDocument } from "../jwks/index.js";
import type { SignatureVerifier } from "../transaction-proof/verifier-types.js";
import type { PlanResolver } from "../transaction-proof/types.js";

const subtle = (globalThis as { crypto?: { subtle?: any } }).crypto?.subtle;

async function webcryptoVerify(payload: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
  if (!subtle) return false;
  try {
    const key = await subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, signature, payload);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function memoKey(payload: Uint8Array, signatureHex: string): string {
  return `${signatureHex}|${Buffer.from(payload).toString("hex")}`;
}

/** Tri-state → presentation (ADR-017: four tri-state colors). */
export function badgeView(block: TransactionBlock | null): { label: string; state: string } {
  if (block === null) return { label: "No proof", state: "none" };
  if (block.verified === true) return { label: "Verified", state: "verified" };
  if (block.verified === null) return { label: "Unavailable", state: "unavailable" };
  return { label: "Not verified", state: "invalid" };
}

/**
 * Verify a bundle entirely client-side and return the public transaction block.
 * Independently unit-testable (no DOM required). `jwksByOrigin` maps an issuer
 * origin → its published JWKS document.
 */
export async function verifyBundleClientSide(
  record: unknown,
  jwksByOrigin: Record<string, JwksDocument>,
  planResolver: PlanResolver,
  opts: { boundEvidenceOccurredAt?: string | null } = {},
): Promise<TransactionBlock | null> {
  const resolver = new OriginScopedJwksResolver();
  for (const [origin, doc] of Object.entries(jwksByOrigin)) resolver.addOrigin(origin, doc);

  const parsed = recordFromView(record as Record<string, any>);

  // Async pre-pass: resolve every signature the verifier will check.
  const memo = new Map<string, boolean>();
  const p = parsed.payload;
  const checks: Array<[Uint8Array, string, string, string]> = [
    [canonicalize(actorPayloadToDict(p.principal_attestation.payload)), p.principal_attestation.signature, p.principal_attestation.payload.iss, p.principal_attestation.kid],
    [canonicalize(actorPayloadToDict(p.agent_attestation.payload)), p.agent_attestation.signature, p.agent_attestation.payload.iss, p.agent_attestation.kid],
    [payloadCanonicalBytes(p), parsed.signature, p.iss, parsed.kid],
  ];
  if (p.device_attestation) {
    checks.push([canonicalize(devicePayloadToDict(p.device_attestation.payload)), p.device_attestation.signature, p.device_attestation.payload.iss, p.device_attestation.kid]);
  }
  for (const [payload, sigHex, iss, kid] of checks) {
    const pub = resolver.publicKey(iss, kid);
    memo.set(memoKey(payload, sigHex), pub ? await webcryptoVerify(payload, hexToBytes(sigHex), pub) : false);
  }

  // Sync adapter the verifier consults (keyed by the exact bytes it passes).
  const signatureVerifier: SignatureVerifier = {
    verify: (payload, signature) => memo.get(memoKey(payload, Buffer.from(signature).toString("hex"))) ?? false,
  };

  const result = verifyTransactionProof(parsed, {
    signatureVerifier,
    jwksResolver: resolver,
    planResolver,
    boundEvidenceOccurredAt: opts.boundEvidenceOccurredAt ?? null,
  });
  return renderTransactionBlock(parsed, result);
}

/**
 * Register the `<strix-proof-badge>` custom element. No-op outside a DOM. The
 * caller supplies the `PlanResolver` (a public verify endpoint typically pins
 * the plan envelope's allowed-intents/cap so the client can re-check scope).
 */
export function defineStrixProofBadge(planResolver: PlanResolver): void {
  const g = globalThis as any;
  if (typeof g.customElements === "undefined" || typeof g.HTMLElement === "undefined") return;
  if (g.customElements.get("strix-proof-badge")) return;

  class StrixProofBadge extends g.HTMLElement {
    async connectedCallback(): Promise<void> {
      const evidenceId = this.getAttribute("evidence-id");
      const endpoint = this.getAttribute("endpoint");
      this.paint({ label: "Verifying…", state: "pending" });
      if (!evidenceId || !endpoint) return this.paint({ label: "Misconfigured", state: "invalid" });
      try {
        const res = await g.fetch(`${endpoint}?evidenceId=${encodeURIComponent(evidenceId)}`);
        const { record, jwksByOrigin, boundEvidenceOccurredAt } = await res.json();
        const block = await verifyBundleClientSide(record, jwksByOrigin, planResolver, { boundEvidenceOccurredAt });
        this.paint(badgeView(block));
      } catch {
        this.paint({ label: "Unavailable", state: "unavailable" });
      }
    }
    paint(view: { label: string; state: string }): void {
      this.setAttribute("data-state", view.state);
      this.textContent = `Strix · ${view.label}`;
    }
  }

  g.customElements.define("strix-proof-badge", StrixProofBadge);
}
