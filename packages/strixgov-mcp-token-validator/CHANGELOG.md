# Changelog

All notable changes to `@strixgov/mcp-token-validator` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

Initial release. Reference implementation of the validator half of
Strix Mode 3 — Capability-Enforced — governance for MCP servers, per
[`docs/architecture/mcp-mode-3-enforcement-v1.md`](https://github.com/Strixgov/strix/tree/main/docs/architecture/mcp-mode-3-enforcement-v1.md).

### Added
- `validateAuthorization(token, opts)` — verifies a parsed
  `execution_authorization_v1` object. For Postures A (credential-broker)
  and C (first-party MCP).
- `validateAuthorizationFromHeader(headerValue, opts)` — verifies a
  token presented as the `Strix-Execution-Authorization` HTTP header
  per arch spec §6.2. For Posture B (network egress gating / proxy).
- Vendored `canonical-json.mjs` (SCJ v1) and `rfc3339.mjs` (strict
  RFC 3339) so the validator has zero Strix runtime dependency. Both
  are byte-identical to `solo-builder-core/src/canonical-json.ts` and
  `solo-builder-core/src/rfc3339.ts`; drift is pinned by
  `test/canonical-json-parity.test.mjs` against locked golden vectors.
- `VALIDATION_REASONS` — stable reason-string exports. Additive only;
  rename/removal is a breaking change.
- 50 tests under `node --test`, covering: happy-path round-trip with
  replay rejection, every stable reason code, rule ordering (TOKEN_MALFORMED
  before SIGNATURE_INVALID; SIGNATURE_INVALID before EXPIRED; NONCE_REUSED
  last for audit distinguishability), header-transport same-JSON-different-bytes
  defence, and `burnNonce`-throws-is-fail-closed.

### Spec rules implemented in v0.1.0
Rules 1, 2, 3, 6, 7, 8, 9, 10 of `docs/architecture/mcp-mode-3-enforcement-v1.md` §8:
- TOKEN_MALFORMED / CANONICALIZATION_DRIFT
- SCHEMA_VERSION_UNSUPPORTED
- KEY_NOT_FOUND
- SIGNATURE_INVALID
- EXPIRED
- TENANT_MISMATCH
- ENVIRONMENT_MISMATCH
- ACTOR_CLASS_MISMATCH
- NONCE_REUSED

### Spec rules deferred to v0.2.0
- Rule 4 — KEY_NOT_ATTESTED (operational-key attestation chain to a
  pinned root via OB-1).
- Rule 5 — KEY_REVOKED (signed-revocation-list check).

In v0.1.0 the JWKS the caller passes IS the trust boundary; both
reason strings are reserved in `VALIDATION_REASONS` so callers can
pre-handle them. v0.2.0 will add pluggable `isKeyAttested` and
`isKeyRevoked` callbacks. See README "What v0.1.0 does NOT yet check"
and the spec for the deferred-rule discipline.

### Verification
- 50/50 tests pass under `node --test`.
- Canonicalizer locked to byte-identical behavior with
  `solo-builder-core/src/canonical-json.ts` (CJ-1 invariant).
- Header-form byte-equality check defends against the "semantically
  equal, byte-different" canonicalization attack class.
- Fail-closed on every error path; `burnNonce` throw returns
  `NONCE_REUSED` (no "couldn't check, allowed" path).
