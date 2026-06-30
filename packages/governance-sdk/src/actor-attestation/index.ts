/**
 * Actor Attestation v1 — SDK public surface.
 *
 * Entry points used by the strix-platform side:
 *   - `signActorAttestation` — mints the AA-1 record. Called inside the
 *     SE v1 evidence-write transaction (apps/strix-console/src/lib/aa1/
 *     sign-on-evidence-write.ts).
 *   - `verifyActorAttestation` (1C.3) — evaluates the 8 verifier rules
 *     against a pre-fetched evidence + attestation row. Pure-ish; the
 *     caller (1D) supplies the DB join.
 *   - `signAgentBearerAssertion` / `verifyAgentBearerAssertion` — the
 *     auth-boundary bearer-assertion contract.
 *   - `canonicalizeJSON` (mirror) — exposed for tests; production callers
 *     get this transitively.
 *   - `isCredentialClassConsistent` + `CREDENTIAL_CLASS_MATRIX` — single
 *     source of truth for AA-PRE-2 cross-check. Both signer and verifier
 *     consume.
 */

export * from "./scj-v1-mirror.js";
export * from "./bearer-assertion.js";
export * from "./signer.js";
export * from "./credential-class-matrix.js";
export * from "./revocation-check.js";
export * from "./verifier-types.js";
export {
  verifyActorAttestation,
  ACTOR_CLASS_REASONS,
} from "./verifier.js";
