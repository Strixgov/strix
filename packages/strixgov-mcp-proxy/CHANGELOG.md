# Changelog

All notable changes to `@strixgov/mcp-proxy` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0]

Minor, not a patch: this release carries the already-merged shadow-discovery
feature (below) to npm for the first time, alongside a dependency-range fix.
Neither has shipped to npm before this release — `0.1.8` predates both.

### Added
- **Shadow discovery (GSD-1 Phase 4)** — `src/shadow-discovery.mjs`,
  on by default (opt out with `shadowDiscovery: false`). The proxy
  already sits on the live tool-call path; this module records what the
  upstream actually advertises and what the agent actually calls, and
  reports the delta against the classified capability set — the action
  surfaces static discovery (source scanners, Semgrep pack) structurally
  cannot see. Strictly observation: it never changes a verdict and never
  touches the policy / approval / receipt pipeline. Output is a
  `snapshot()` on the `startProxy` handle plus an append-only JSONL log
  at `<storagePath>/shadow-discovery.jsonl`; every snapshot and log line
  carries the mandatory `measurement` disclaimer (**unsigned
  measurement, never proof**) and nothing receipt-shaped. New exports:
  `createShadowDiscovery`, `SHADOW_LOG_BASENAME`,
  `SHADOW_MEASUREMENT_DISCLAIMER`; new handle fields `shadowDiscovery`,
  `shadowDiscoveryLogPath`. Program doc:
  `solo-builder-core/docs/proposals/governed-surface-discovery-v1.md`.

### Fixed
- `dependencies["@strixgov/tool-gateway"]` was published (in `0.1.8`) as
  `^0.4.1` — a hard, non-optional dependency, so a fresh `npm install
  @strixgov/mcp-proxy` resolved the highest matching version, `0.4.1`,
  never `0.5.0`. `0.5.0` fixed a real defect in `tool-gateway`'s
  `terminalApprove()`: a non-interactive-session guard that could never
  fire (`isTTY === false` — Node marks a real TTY `true` and leaves
  everything else `undefined`, never `false`), so a headless approval
  request fell through to writing a prompt banner onto `stdout`. For
  this package specifically, `stdout` **is** the live MCP JSON-RPC
  channel, so the stray banner corrupted the protocol stream a client
  was mid-parse on. The in-repo dependency range was corrected to
  `^0.5.0` when `tool-gateway@0.5.0` shipped, but this package was never
  republished against it — every `npm install` of `0.1.8` (and, by the
  same defect, of `0.1.5`–`0.1.7`) still pulled the buggy range. This
  release is the republish; no other code changed for this fix.

## [0.1.8]

Republish of 0.1.7 with correct dependency specifiers — code is
byte-identical. `0.1.7` was published with `npm publish`, which ships the
monorepo's raw `workspace:^…` specifiers in the tarball's package.json;
consumer installs (`npx -y @strixgov/mcp-proxy`) fail with
`EUNSUPPORTEDPROTOCOL`. `pnpm publish` rewrites them to real semver at
pack time (how 0.1.5/0.1.6 shipped correctly). 0.1.7 is deprecated on
the registry.

### Fixed
- Published dependency specifiers (`@strixgov/mcp-adapter`,
  `@strixgov/tool-gateway`, `@strixgov/capabilities-mcp-common`) resolve
  again for consumers.

### Added
- `prepublishOnly` guard: publishing this package with npm now aborts
  with instructions to use pnpm, so this defect class cannot ship again.

## [0.1.7] — published 2026-07-06, DEPRECATED (broken consumer installs)

Adds the webhook approval channel. No change to the receipt format or the
signing flow. **Do not install this version** — see 0.1.8 above.

(Version note: this feature was originally staged under 0.1.6, but
`0.1.6` had already been published to npm on 2026-06-09 as the
documentation + license-fidelity patch below — so the webhook channel
ships as 0.1.7.)

### Added
- **`approval.type: "webhook"`** — Slack-compatible approval notifications
  layered on the existing file approver (`src/webhook-approver.mjs`). Each
  APPROVAL_REQUIRED call still writes the request file and awaits the
  response file (timeout → DENY, unchanged); the webhook POSTs a
  `{ text, strix }` payload telling a human what is blocked and how to
  decide (`npx @strixgov/guard approve <requestId>`). Failure semantics are
  load-bearing and tested: a failed notification never approves and never
  auto-denies; a missing/invalid `webhookUrl` fails at startup, not at first
  call. New config keys: `approval.webhookUrl` (required for the type),
  `approval.requestDir`, `approval.pollIntervalMs`.

## [0.1.6] — published 2026-06-09

Documentation + license-fidelity patch. No functional change to the proxy,
the receipt format, the signing flow, or any runtime behavior.

### Fixed
- **`LICENSE` corrected to canonical Elastic License 2.0.** The Limitations
  clause read "provide the software to **others** as a hosted or managed
  service"; the canonical ELv2 wording is "to **third parties**." Corrected
  byte-for-byte against Elastic's published license. The `0.1.0` release note
  flagged this exact verification ("verify the bundled LICENSE against
  canonical ELv2 before tagging") — the deviation shipped anyway in 0.1.0 and
  0.1.5. Legal-text fidelity only; no change to intent or the MIT/ELv2 split.
  **Counsel should confirm before publish.**
- **README version labels.** Notes describing *current* behavior were tagged
  `v0.1.0` (the floor where they were first true); a reader on npm sees
  `0.1.5+`. Relabeled the current-behavior notes (transport scope, env-var
  substitution, feature-table column, Mode-3 seam, single-tenant boundary) to
  `v0.1.x`. Genuinely historical references (the `v0.1.0–v0.1.3` ephemeral-key
  known issue, `v0.1.4+` default `storagePath`) are unchanged.

### Note
- Closes findings F-3 and F-4 of
  `docs/reviews/mcp-proxy-publish-readiness-2026-06-07.md`. Repeatable
  publish gate: `scripts/mcp-proxy-preflight.mjs`.

## [0.1.5]

Documentation-hygiene patch. No functional change to the proxy, the
receipt format, the signing flow, or any runtime behavior.

### Fixed
- **`SECURITY.md`, `README.md`, and `CHANGELOG.md` cross-references**
  rewritten to remove links into the maintainer's internal source tree.
  The threat-model cross-reference in `SECURITY.md` now points reviewers
  at `security@strixgov.com`; runbook cross-references and an internal
  development-branch name embedded in a 0.1.0 release note have been
  removed. Static text only — no API, no behavior, no tests changed.

### Note
- Operators on 0.1.0 are encouraged to upgrade. v0.1.0 has been
  deprecated on npm to surface this guidance on install; `npm install
  @strixgov/mcp-proxy@0.1.0` continues to work but emits a deprecation
  warning pointing here.

## [0.1.4]

Fixes the silent-ephemeral-key footgun surfaced by the same dogfood that
produced 0.1.1–0.1.3. With `storagePath` unset, pre-0.1.4 left
`governMCPServer` to default both halves of persistence wrong:
`MemoryStorage` (so the proxy's receipts vanished on exit) AND
`generateSigningKey()` ephemeral (so the kid embedded in every on-disk
receipt pointed at a key that didn't exist anywhere). Operators who
worked around the storage half by pointing `storagePath` at
`~/.strix-gateway` saw receipts they could `strix-gateway receipts list`
but never `verify` — `kid not in keyring: strix-<serverId>` on every
record. This release makes "the receipts I wrote yesterday are
verifiable today" the default.

### Changed
- **Default `storagePath`** when `opts.storagePath` is undefined: now
  resolves to `path.join(os.homedir(), ".strix-mcp-proxy", serverId)`
  instead of leaving the value unset. Receipts persist as JSONL under
  that path; the Ed25519 signing key persists at
  `<storagePath>/keys/{signing-key.pem, public-jwk.json}` and is reused
  across restarts. The default is intentionally **not**
  `~/.strix-gateway`: the gateway CLI uses a multi-kid keyring layout
  (`active` pointer + `<kid>/` subdirs) while the proxy uses
  `loadOrCreateSigningKey`'s flat single-key layout, and sharing the
  same `keys/` directory produces silently-broken receipts (the proxy's
  flat key files are invisible to the keyring loader, or the v0.1 auto-
  migration clobbers the gateway's `active` pointer to the proxy's kid).
- **Audit event `signing.key.resolved`** now distinguishes
  `source: "persistent"` (operator-supplied `storagePath`) from
  `source: "persistent-default"` (auto-resolved per-serverId default).

### Added
- **`storagePath: null` opt-out.** Callers who genuinely want the pre-
  0.1.4 ephemeral behavior (CI smoke runs, demos that intentionally
  produce throwaway receipts) pass `storagePath: null` explicitly.
  Receipts within the session remain chain-coherent; signatures are
  unverifiable across restarts.

### Test
- `startTestProxy` helper now defaults to a per-test tmpdir so the
  suite never writes to the developer's home directory.
- Old `"no storagePath ⇒ in-memory ephemeral key (preserves pre-0.1.2
  default)"` test removed and replaced with two tests pinning the new
  default behavior + the explicit-`null` opt-out path.

### Migration notes for existing operators
- If your `notion-proxy-config.json` (or equivalent) sets
  `"storagePath": "~/.strix-gateway"` to share storage with the
  gateway CLI, **change it** — point at
  `"~/.strix-mcp-proxy/<serverId>"` instead (or any path you control
  that isn't aliased to `~/.strix-gateway`). Existing receipts at the
  old location remain readable but their kid is unverifiable because
  the proxy's old ephemeral key is gone. Future receipts written
  under the new default ARE verifiable end-to-end.
- If your code passes no `storagePath` and depended on receipts
  vanishing on exit, add `storagePath: null` to your `startProxy`
  call to preserve that behavior.

## [0.1.3]

Closes the headless-approval gap surfaced by the same dogfood run that
produced 0.1.1 / 0.1.2. With `approval.enabled: false` (the default)
every `APPROVAL_REQUIRED` call is silently denied; turning approval on
defaults to `terminalApprove`, which fails closed in any non-TTY context
including Claude Desktop's headless spawn. `@strixgov/tool-gateway`
already shipped a `fileApprover` that works in headless contexts, but
the proxy couldn't wire it up from JSON config because the gateway's
`approval.prompt` field expects a function — and JSON can't carry one.

### Added
- **`approval.type` JSON config field** with three accepted values:
  - **`"auto"`** — auto-approves every `APPROVAL_REQUIRED` call with a
    signed `approval.approved: true` audit trail. Convenient for demos
    where you want to show the approval-loop fires; **defeats real
    governance** for non-trivial environments.
  - **`"file"`** — wires up `fileApprover` from `@strixgov/tool-gateway`.
    The proxy writes `<requestDir>/<requestId>.request.json` per
    approval-pending call; an out-of-band approver writes
    `<requestId>.response.json` with `{approved: true|false, approvedBy?, reason?}`.
    Works under Claude Desktop spawn, CI, or any headless context.
    `requestDir` defaults to `<storagePath>/approvals` when `storagePath`
    is set, or `./.strix-approvals` otherwise. `~` and `~/` are expanded
    to `os.homedir()` consistent with `storagePath`'s tilde handling.
    Optional `timeoutMs` (default 5min) and `pollIntervalMs` (default
    250ms) tunables.
  - **`"terminal"`** — explicit alias for the legacy default. Useful
    when an operator is testing the proxy directly from a TTY and wants
    to see the y/N prompt.
- Resolution order pinned and tested:
  1. Programmatic `approval.prompt` function (always wins)
  2. `approval.enabled === false`
  3. `approval.autoApprove === true` (long form of `type: "auto"`)
  4. `approval.type === "auto" | "file" | "terminal"`
  5. Unknown `type` ⇒ startup error (fail-fast, not silent fail-closed)
- 8 new tests covering each resolution branch.

### Fixed
- Unknown `approval.type` values now throw at startup with the message
  `unknown approval.type 'X' — expected "terminal", "file", or "auto"`,
  instead of silently falling through to a deny-everything state.

### Migration
- **`{enabled: false}`** (the docs-example default) is unchanged.
- **`{enabled: true}`** (no `type`) preserves the v0.1.2 behavior
  (defaults to `terminalApprove`, fails closed in non-TTY contexts).
- New JSON-config-friendly shapes for headless deployments:
  ```jsonc
  "approval": {
    "enabled": true,
    "type": "file",
    "requestDir": "~/.strix-gateway/approvals",
    "timeoutMs": 300000
  }
  ```
  or for demos:
  ```jsonc
  "approval": { "enabled": true, "type": "auto" }
  ```

### Verification
- 37 tests pass under `node --test`; 1 skipped (network-gated tarball
  install gate, opt in via `STRIX_RUN_TARBALL_INSTALL=1`).

## [0.1.2]

Closes the verifiability gap surfaced by a fresh dogfood run on Windows
(May 25 2026): receipts were correctly signed and written to JSONL on
disk, but the signing key was discarded the instant the proxy exited.
Every receipt produced under v0.1.0 / v0.1.1 carried a `signingKeyId`
(e.g. `strix-notion`) pointing at a key that no longer existed
anywhere — so `@strixgov/verifier` reported `KEY_NOT_FOUND` for every
local-mode receipt. Trust property was "tamper-evident at write time"
but not "externally re-verifiable after restart."

### Fixed
- **`startProxy` now persists the signing keypair to disk when
  `storagePath` is set.** Files land at:
  - `<storagePath>/keys/signing-key.pem` (PKCS8 PEM, mode 0600)
  - `<storagePath>/keys/public-jwk.json` (public JWK with `kid`, `kty`,
    `crv`, `x` — mode 0644)
  The same `kid` (e.g. `strix-notion`) is reused across restarts via
  `loadOrCreateSigningKey()` from `@strixgov/tool-gateway`, so JSONL
  receipts are independently verifiable after the proxy exits:
  ```sh
  npx @strixgov/verifier chain ~/.strix-gateway/receipts.jsonl \
    --jwks ~/.strix-gateway/keys/public-jwk.json
  ```
  Caller-supplied `opts.signingKey` still wins over disk persistence —
  operators integrating with a KMS or secrets manager are unaffected.
  When neither `signingKey` nor `storagePath` is set, behavior matches
  v0.1.1 (in-memory ephemeral key) — preserved as the default for tests
  and embedded use cases.
- A new `signing.key.resolved` audit event fires on the persistent
  path with `{source: "persistent", kid, keyPath}` so operators can
  confirm the disk-load happened.

### Breaking changes
- None. `startProxy` is already async; the new `loadOrCreateSigningKey`
  call slots into the existing async flow without changing the
  `governMCPServer` (synchronous) contract.

### Notes for existing users
- **Receipts produced under v0.1.0 / v0.1.1 remain unverifiable.** Their
  signing keys were ephemeral and are not recoverable. Starting with
  0.1.2, every new receipt written under a `storagePath` deployment is
  verifiable for the life of the persisted key.
- The first start under 0.1.2 generates a fresh keypair. Subsequent
  starts reuse it. To force key rotation, delete `<storagePath>/keys/`
  before restart; the next start will regenerate.

### Verification
- 4 new tests in `test/proxy-end-to-end.test.mjs`:
  - Disk files (PEM + JWK) created with correct shape + kid
  - kid survives a restart (the demo-story invariant)
  - Caller-supplied `signingKey` bypasses disk persistence
  - No-`storagePath` path preserves v0.1.1 in-memory default

## [0.1.1]

Bug-fix release that closes the gap surfaced when a fresh user ran the
"5-line integration (Claude Desktop)" path end-to-end and the proxy
exited at startup with `Cannot find package '@strixgov/capabilities-mcp-common'`.

### Fixed
- **`@strixgov/capabilities-mcp-common` is now a runtime `dependencies`
  entry, not a `devDependencies`-only listing.** Previously, every user
  who installed the proxy globally (`npm install -g @strixgov/mcp-proxy`)
  also had to discover and run a second `npm install -g
  @strixgov/capabilities-mcp-common` before the example config in the
  README would load — because npm doesn't install devDependencies for
  globally-installed packages. The README documents the companion pack
  as the default capability source, so it's a hard runtime dependency.
  This was a release blocker for the "zero-friction first run" claim
  in the README.
- **Clearer error when a `capabilities` import path can't be resolved.**
  `resolveCapabilities()` now catches `ERR_MODULE_NOT_FOUND` (and the
  related `Cannot find package` shape) and re-throws with an actionable
  hint pointing the operator at `npm install -g <pack>`. Previously
  the operator saw the bare Node loader error, which doesn't tell them
  how to fix it.

### Verification
- All 25 tests under `node --test` continue to pass.
- Manual dogfood: `npm install -g @strixgov/mcp-proxy@0.1.1` followed
  by `strix-mcp-proxy --config <path>` resolves
  `@strixgov/capabilities-mcp-common/notion` without a second install.

## [0.1.0]

Initial release. The Strix MCP Proxy — a standalone process that
wraps any upstream MCP server with governance, with **zero changes**
to the upstream's tool implementations.

This is the **distribution wedge** for governed agent tool execution
per [`docs/strategy/mcp-mode-ladder-v1.md`](https://github.com/Strixgov/strix/tree/main/docs/strategy/mcp-mode-ladder-v1.md):
fastest path to "Strix governs every MCP call on this machine,"
designed so Mode 3 (Capability-Enforced) is the v0.2.0 upgrade path
rather than a v1.0 rewrite.

### Added
- `COMMERCIAL.md` — plain-English summary of the ELv2 boundary,
  designed for both the developer evaluating the proxy (30-second
  decision tree) and the legal / procurement team reviewing it
  (10-row scenarios table with ✅ / 💰 / ⚠️ outcomes). Mirrors the
  posture of `@strixgov/mcp-adapter`'s COMMERCIAL.md with
  proxy-specific deployment scenarios (multi-tenant gateway, MSP,
  on-prem appliance). Ships in the npm tarball via the `files`
  allowlist.
- `strix-mcp-proxy` CLI — spawn over stdio in place of any upstream
  MCP server; configure via flags or a JSON config file. Compatible
  with Claude Desktop, mcp-cli, IDE integrations, and any other
  MCP-aware client that spawns its servers as child processes.
- `startProxy(opts)` programmatic API in `src/index.mjs` for
  embedding the proxy in a host process or test harness.
- `loadConfig(filePath)` + `resolveCapabilities(spec)` config-loader
  helpers — validated config-file shape, ~`/` expansion in
  `storagePath`, dynamic import of companion-pack capability arrays.
- Companion-pack-aware classification — accepts any
  `@strixgov/capabilities-mcp-common/*` import path via the
  `capabilities` config field. Heuristic fallback for unknown tools.
- Local-mode (in-memory + JSONL) signed Ed25519 receipts; opt-in
  connected mode (sync to `strixgov.com`) via `STRIX_API_KEY` +
  `STRIX_TENANT_ID` per the mcp-adapter contract.
- Approval gate plumbing — wired to `@strixgov/tool-gateway`'s
  approver interface; consumers supply their own
  Slack / webhook / web UI / terminal approver.
- Actor context forwarding — clients that put
  `_meta.strix_actor_id` / `_meta.strix_actor_role` on a callTool
  request get those fields bound into the receipt.
- Test mode (`transport: { kind: "test", ... }`) — caller supplies
  an `InMemoryTransport` pair so the full proxy pipeline can be
  exercised in-process without spawning subprocesses. Used by the
  end-to-end test suite.

### Verification
- 25 tests pass under `node --test` (+1 skipped: the network-gated
  tarball install smoke; opt in with `STRIX_RUN_TARBALL_INSTALL=1`):
  - `test/proxy-end-to-end.test.mjs` — full pipeline with linked
    InMemoryTransport pairs; ALLOW round-trip, DENY blocks the
    upstream + still emits signed receipt, companion-pack canonical
    receipt ids, actor-context forwarding, audit-event lifecycle,
    riskOverrides batch gating, startProxy validation errors.
  - `test/config.test.mjs` — config-file loader validation, ~/
    expansion, companion-pack dynamic import resolution.
  - `test/cli.test.mjs` — `--help`, `--version`, missing-arg errors,
    missing-file errors.
- Companion-pack lookup uses `cap.name` indexing so server-prefixed
  tool names (`notion-fetch`, `slack_send_message`) match the pack
  rather than falling through to the MEDIUM EXECUTE heuristic.

### Mode coverage
- **Mode 1 (Observed)** — every call produces a signed receipt.
- **Mode 2 (Approval-Gated)** — HIGH / CRITICAL or rule-targeted
  calls held at the action boundary; approver identity bound to
  the receipt; non-retroactive.
- **Mode 3 (Capability-Enforced)** — explicitly deferred to v0.2.0.
  The design seam (`buildUpstreamIface()` in `src/proxy.mjs`) is the
  single place where `execution_authorization_v1` token mint +
  transport will attach. The cryptographic primitive is already
  shipped at `@strixgov/mcp-token-validator`.

### License
- Source-available under [Elastic License 2.0](./LICENSE) — per the
  packaging spec at `docs/strategy/mcp-adapter-packaging-v1.md`,
  every commercial-tier package in the Strix bundle ships under
  ELv2; the trust primitives stay MIT.
- **NOTE for first publish:** verify the bundled `LICENSE` text
  against the canonical Elastic License 2.0 at
  https://www.elastic.co/licensing/elastic-license before tagging
  `mcp-proxy-v0.1.0`. The bundled text is the agent's best
  reproduction of the canonical license and should be reviewed by
  legal counsel before going live.
