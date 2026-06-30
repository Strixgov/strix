/**
 * `@strixgov/sdk` proof_bundle_v2 outer-envelope verifier.
 *
 * The outer signed envelope the attestation/commerce capabilities (AA-1,
 * AA-2, AC-1, MC-1) nest inside. TS port of `solo_builder.bundle_verifier`
 * (ADR-001 / ADR-005). A TS verifier built to this contract accepts a
 * Python-signed bundle: byte-identical canonicalization, the committed-hash
 * chain, and the 5-step verdict (VERIFIED / INVALID / LEGACY_UNSIGNED).
 */

export * from "./types.js";
export * from "./verifier.js";
export { canonicalize as bundleCanonicalize, hashCanonical } from "./canonical.js";
