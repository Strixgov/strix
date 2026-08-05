# Changelog

All notable changes to `@strixgov/tool-gateway` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-03

Minor, not a patch: this release adds the signed post-execution outcome
surface. Consumers pinning `^0.4.1` will NOT receive it — the four in-repo
`workspace:^0.4.1` ranges (mcp-proxy, capabilities-mcp-common,
capabilities-odysseus, strix-ct-sequencer) were moved to `workspace:^0.5.0` in
the same change, because `pnpm publish` substitutes those ranges verbatim into
the published tarball and `^0.4.1` excludes 0.5.0.

### Added
- Signed post-execution outcome v1, deliberately separate from the existing
  pre-invocation authorization receipt. Outcomes bind the authorization receipt,
  observed `SUCCEEDED` / `FAILED` / `UNKNOWN` state, result hash or error code,
  tenant, environment, signing key ID, algorithm, and outcome hash.
- Append-only memory and JSONL outcome-storage drivers.
- Independent outcome verification helpers and a published JSON Schema.
- Signer/verifier canonical-byte parity tests, tamper tests, wrong-key,
  wrong-algorithm, missing-key, malformed-state, and authorization-link tests.

### Fixed
- `terminalApprove` no longer writes to stdout in a headless process. Its
  non-interactive guard compared `isTTY === false`, but Node marks a TTY with
  `isTTY === true` and leaves the property `undefined` on pipes, files and
  sockets — so the guard never fired for a spawned or piped process. Headless
  callers fell through to a human prompt banner on stdout and then blocked on
  readline for the full timeout (default 60s) before denying. The guard now
  requires both ends to be real TTYs and returns `PROMPT_FAILED` before any
  write. Callers injecting their own streams are unaffected: a stream with
  `isTTY: true` still exercises the prompt path.

### Security
- Outcome verification rejects fields outside the signed schema so unsigned
  display extensions cannot alter apparent execution state.
- A present signature with no resolvable key is reported as `KEY_NOT_FOUND`,
  distinct from an unsigned record.
- The `terminalApprove` fix above matters most for `@strixgov/mcp-proxy`, whose
  MCP JSON-RPC channel **is** stdout: a prompt banner written there corrupted
  the protocol stream a client was parsing. Both the old and new headless paths
  deny, so no action was ever wrongly authorized.

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
