// @strixgov/trust-mark-embed — verdict reducer + fetch (pure, no DOM).
//
// The <strix-trust-mark> badge is RENDER-ONLY (ADR-029 §5 + consumer-trust-mark-v1
// §"Verification UX"): it renders the verdict the public status route produced
// (that route runs the real trust_mark_grant_v1 verifier + the rule-9 coverage
// resolver), it never determines one. The skeptic layer that re-derives the
// verdict independently is `npx @strixgov/verifier trustmark <grantId>`.
//
// Never-fake-GREEN holds by composition: GREEN is rendered ONLY when the route
// returns badge === "GREEN" (which it produces only from a fresh VERIFIED ∧
// ACTIVE ∧ coverage-PASS verdict), and the element auto-refreshes so a stale
// GREEN cannot persist past the route's short cache window.

export const DEFAULT_PROOF_BASE = "https://www.strixgov.com";

const BADGE_STATES = new Set(["GREEN", "RED", "YELLOW", "SLATE"]);

/**
 * Reduce an HTTP outcome from the status route into a render state. Pure.
 *
 * @param {object} input
 * @param {number} [input.httpStatus]
 * @param {object|null} [input.body]
 * @param {boolean} [input.networkError]
 * @returns {{badge:string, grantId:string|null, markClass:string|null,
 *   surfaceOrigin:string|null, verificationStatus:string|null,
 *   verificationReason:string|null, coverage:string|null, note:string|null}}
 */
export function reduceTrustMarkResponse({ httpStatus, body, networkError } = {}) {
  const base = {
    badge: "YELLOW",
    grantId: null,
    markClass: null,
    surfaceOrigin: null,
    verificationStatus: null,
    verificationReason: null,
    coverage: null,
    note: null,
  };

  // Surface unreachable / DNS / TLS — unknowable NOW, never GREEN, never RED.
  if (networkError) return { ...base, badge: "YELLOW", note: "surface unreachable" };

  // 404 is the dormant + genuine-miss body (no existence leak): no grant → SLATE.
  if (httpStatus === 404) return { ...base, badge: "SLATE", note: "no trust mark" };

  // 501: a deployment whose verifier isn't wired yet (pre-item-C). Honest YELLOW,
  // never a fabricated GREEN.
  if (httpStatus === 501) return { ...base, badge: "YELLOW", note: "verifier pending" };

  if (httpStatus !== 200 || body === null || typeof body !== "object") {
    return { ...base, badge: "YELLOW", note: httpStatus ? `http ${httpStatus}` : "unexpected response" };
  }

  // 200: render the route's verdict. An unrecognized badge degrades to YELLOW
  // (never silently GREEN).
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const badge = BADGE_STATES.has(body.badge) ? body.badge : "YELLOW";
  return {
    badge,
    grantId: typeof body.grantId === "string" ? body.grantId : null,
    markClass: typeof payload.mark_class === "string" ? payload.mark_class : null,
    surfaceOrigin: typeof payload.surface_origin === "string" ? payload.surface_origin : null,
    verificationStatus: typeof body.verification_status === "string" ? body.verification_status : null,
    verificationReason: typeof body.verification_reason === "string" ? body.verification_reason : null,
    coverage: typeof body.coverage === "string" ? body.coverage : null,
    note: null,
  };
}

/**
 * Fetch + reduce a grant's live status. Never throws — a network failure
 * resolves to a YELLOW (unknowable) state.
 *
 * @param {string} grantId
 * @param {object} [opts]
 * @param {string} [opts.proofBase]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function fetchTrustMarkState(grantId, opts = {}) {
  const proofBase = opts.proofBase ?? DEFAULT_PROOF_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${proofBase}/api/public/proof/trustmark/${encodeURIComponent(grantId)}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch {
    return reduceTrustMarkResponse({ networkError: true });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return reduceTrustMarkResponse({ httpStatus: res.status, body });
}
