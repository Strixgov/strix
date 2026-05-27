# Changelog

All notable changes to `@strixgov/tool-gateway` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1]

### Changed
- Republished from a fresh commit. The `tool-gateway-v0.4.0` git tag was
  created against an outdated commit (six files behind main, predating the
  v0.4 backlog merges) and the registry publish never fired. v0.4.1 is the
  first published artifact; functionally equivalent to the intended v0.4.0
  content with no source changes versus current `main`.

## [0.4.0]

### Added
- v0.4-stable connected-mode wire envelope: `timestamp` + `nonce` for replay
  defense, timing-safe HMAC verification.
- `RateLimiter` unique-actor cap.
- Snapshot canonical-parity test against `@strixgov/verifier`.
- Connected-mode wire-envelope schema test.

### Changed
- Snapshots and registry now dispatch on `schemaVersion`.
- `onSyncError` now invoked via `queueMicrotask` so handler errors cannot
  starve the sync loop.

## [0.3.1]

### Fixed
- Verifier README typos; corrected `KeyRing`/`SigningKey` contradiction.
- Unexpanded `~` paths in storage examples.
- `Gateway.connectedSyncer` type drift between runtime and `.d.ts`.

### Added
- Companion-pack `.d.ts`-↔-runtime parity smoke test.

## [0.3.0]

### Added
- Experimental `connectedMode` (wire format `v0.3-experimental`) for
  upstream sync of receipts and snapshots. Fail-open: local execution
  is never blocked by upstream availability.
- Companion-pack ecosystem: `@strixgov/capabilities-claude-code` and
  `@strixgov/capabilities-mcp-common` ship pre-classified registries.

## [0.2.0]

### Added
- Multi-key `KeyRing` with rotation and doubly-signed chain snapshots
  at every key handoff.
- Per-capability sliding-window rate limits.
- Threshold-based escalation hooks.
- HMAC-signed `webhookApprover`.
- Signature-verified shared capability registry.

## [0.1.1]

### Added
- Receipt schema v2: binds `policyVersion` (content-addressable), `tenantId`,
  `environment`. v1 receipts continue to verify (verifier dispatches on
  `schemaVersion`).
- `Gateway` is an `EventEmitter`.
- `fileApprover` for headless / CI use.
