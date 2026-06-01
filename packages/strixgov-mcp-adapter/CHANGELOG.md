# Changelog

All notable changes to `@strixgov/mcp-adapter` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1]

### Fixed
- **`SECURITY.md` cross-reference** rewritten to remove a link into the
  maintainer's internal source tree. The broader-threat-model pointer
  now directs reviewers to `security@strixgov.com` instead of an
  internal repo URL. Static text only — no API, no behavior, no tests
  changed.
- **`demo` no longer prints a literal verifier command that points at a
  file it never wrote.** Prior to this fix `bin/demo.mjs` ran with
  `MemoryStorage` and ended with the hint `npx @strixgov/verifier chain
  ./receipts.jsonl` — pasting that command produced `ENOENT` because
  the demo never persisted anything. The demo now wires `storagePath`
  to a unique temp directory (`<tmpdir>/strix-mcp-adapter-demo-<pid>-<ts>`),
  writes the gateway's public JWKS to `public-jwks.json` alongside, and
  prints the **literal** `npx @strixgov/verifier chain <receipts> --jwks
  <jwks>` command with the real paths substituted in. Copy/paste from
  the demo output now reproduces the verification in a separate process
  without further setup. Regression-pinned in `test/cli-demo.test.mjs`:
  the printed command is parsed, both files are asserted to exist on
  disk, and the JSONL file is asserted to contain exactly 3 receipt
  rows.
- README API table for `storagePath` clarified: it is a **directory**
  path (wired into `JsonlStorage({ dir: storagePath })`), and receipts
  land at `<storagePath>/receipts.jsonl`. Passing a `*.jsonl` filename
  here creates a directory of that name — the most-common first-time-
  user mistake. New unit test pins the actual on-disk layout
  (`test/governed-server.test.mjs` — "storagePath is a directory").

- `init --companion-pack=none` no longer produces a broken scaffold.
  Previously the CLI accepted the `none` escape hatch in validation but
  passed the literal string into `renderScaffold`, which took the
  with-pack branch and generated
  `import { noneCapabilities } from "@strixgov/capabilities-mcp-common/none"`
  — a module that does not exist, so the scaffolded file failed
  immediately at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The CLI
  now normalises `"none"` to `null` before dispatching to the render
  layer, so `--companion-pack=none` correctly forces the no-pack branch
  (inlined starter capabilities) on a known server name. Help text + the
  unknown-pack error message now document `none` as a valid value.
  Caught in Codex review on PR #1131 (P2). Regression-pinned by two new
  tests in `test/init-scaffold.test.mjs`: a static-shape check and an
  end-to-end "scaffold + spawn node + assert signed receipts" run.

### Added
- **`npx @strixgov/mcp-adapter demo` — the canonical first-touch
  experience.** New `bin/demo.mjs` CLI spins up an in-process stub MCP
  server, drives three governed tool calls covering all three policy
  outcomes (ALLOW for a LOW READ, APPROVAL_REQUIRED for a CRITICAL
  irreversible merge, DENY for an out-of-pack tool via heuristic +
  fail-closed default), prints three Ed25519-signed receipts, then
  verifies the chain with `@strixgov/verifier` and prints `✓ VERIFIED`.
  End-to-end well under 20 seconds, no env vars, no clone. The signing
  key, policy engine, and receipt format are the *exact same code
  paths* every production deployment runs — no demo-only signing
  shortcut. Wired via `bin.strixgov-mcp-adapter` so `npx @strixgov/
  mcp-adapter demo` works directly. Regression-pinned by
  `test/cli-demo.test.mjs` (exit 0, "VERIFIED" present, 3 receipts,
  3/3 signatures, chain intact).
- **`@strixgov/verifier` is now a regular runtime dependency** of the
  adapter (was a workspace-only dev dep). Required so the `demo`
  command can complete the verification round-trip under `npx` without
  asking the user to install anything else. Strix is still not on the
  trust path of the verifier itself — the verifier package retains its
  zero-Strix-imports invariant.

## [0.1.0]

Initial release. One-call governance for any MCP server.

Pre-first-publish discipline: this version was never on npm under any
other shape; the contents below are the state going into the first
publish — including the ELv2 license posture.

### Licensed under Elastic License 2.0
- **License: [Elastic License 2.0](./LICENSE).** Source-available with
  one operational restriction (no hosted-service offering to third
  parties). Free for internal production use. The trust primitives
  this adapter depends on (`@strixgov/verifier`,
  `@strixgov/tool-gateway`, `@strixgov/mcp-token-validator`) remain
  MIT — Strix is not on the trust path of receipt verification,
  unchanged by this license boundary. See `COMMERCIAL.md` for the
  Community / Commercial / Enterprise tier definitions and how to
  obtain a commercial license. Rationale: per
  `docs/strategy/mcp-adapter-packaging-v1.md`, the adapter is the
  commercial product in the Strix bundle; ELv2 preserves the 5-line
  install moat while gating hosted-service redistribution.
- **Verify the bundled LICENSE text before tagging.** The shipped
  `LICENSE` file is the agent's best reproduction of the canonical
  Elastic License 2.0 from
  https://www.elastic.co/licensing/elastic-license. Legal counsel
  should review against the canonical source before tagging
  `mcp-adapter-v0.1.0`.

### Added
- `npx @strixgov/mcp-adapter init <server-name>` — single-command
  scaffolder that writes a runnable governed-server `.mjs` file into the
  current directory. Detects known companion packs (`notion`, `github`,
  `slack`, `linear`, `filesystem`, `postgres`, `email`) and auto-imports
  the right one; falls back to an inlined starter capabilities array
  for unknown server names. Generated file runs immediately in stub
  mode and prints 3 signed receipts — the "magic moment" loop is
  reachable in one command, with no edits. Five `TODO(strix):` blocks
  mark the integration points (handlers, policy, approver, optional
  connected-mode, real sample calls) so a developer can grep their way
  to production. Flags: `--companion-pack=<n>`,
  `--with-connected-mode`, `--out=<path>`, `--force`. Implementation:
  `src/scaffold.mjs` (pure render function) + `src/cli-init.mjs`
  (argv parsing + I/O) dispatched from `bin/demo.mjs` as a sibling
  subcommand to `demo`. 22 tests across `test/init-scaffold.test.mjs`,
  including end-to-end "scaffold + spawn node + assert signed receipts"
  coverage that locks the runnability promise.
- `COMMERCIAL.md` — plain-English summary of the ELv2 boundary, what's
  free vs what needs a license, how to obtain one
  (`sales@strixgov.com`). Now leads with a 6-question decision tree
  (30-second self-serve answer for evaluating developers) and a 10-row
  scenarios table designed for legal / procurement review. Each
  scenario maps a concrete deployment to one of three outcomes
  (✅ Free / 💰 License required / ⚠️ Email us) with citation-friendly
  row numbers. Ships in the npm tarball via the `files` allowlist.
- README §"Connected Mode (Commercial)" replaces the older "Free
  Connected Tier" framing — Connected Mode requires a commercial
  license; local mode (in-memory + JSONL receipts) is the free tier
  under ELv2.
- `governMCPServer(tools, opts)` — wraps a plain handler map or an
  `{ handler, listTools }` interface and routes every `callTool` through
  `@strixgov/tool-gateway` for policy evaluation and signed receipts.
- `createGovernedServer(opts)` — convenience alias that takes `tools`
  alongside other options in a single object.
- `loadConnectedModeFromEnv()` — reads `STRIX_API_KEY` / `STRIX_TENANT_ID`
  / `STRIX_KERNEL_URL` and returns connected-mode config (or `null` to
  stay local). Auto-detected when `connectedMode` is unset.
- Companion-pack pass-through: capabilities provided via `opts.capabilities`
  are indexed by canonical id, by the bare tool name, and by `cap.name`
  (the on-the-wire MCP tool name), so server-prefixed tool names like
  `notion-fetch` / `notion-create-comment` match the companion pack.
- Heuristic fallback: tools not in the companion pack are classified by
  name prefix (`get_*` → LOW READ, `delete_*` → CRITICAL WRITE, etc.).
  Unknown tools default to CRITICAL EXECUTE so a `default: "DENY"` policy
  blocks them.
- Fail-closed construction: if a signing key cannot be obtained, the
  constructor throws — there is no "governance degraded but tool still
  runs" state.
- Runnable example at `examples/notion.mjs`: offline-stub by default,
  auto-promotes to a real `@notionhq/notion-mcp-server` over stdio when
  `NOTION_TOKEN` and `@modelcontextprotocol/sdk` are present.

### Verification
- 41 tests under `node --test` (up from 19), including:
  - Tarball-install smoke (`test/installed-tarball.test.mjs`) that packs
    `@strixgov/tool-gateway` + `@strixgov/mcp-adapter`, installs both into
    a throwaway consumer project, and exercises a real ALLOW path — the
    only test that catches bare-specifier regressions in the published
    artifact.
  - Server-prefixed companion-pack regression
    (`test/companion-pack-prefixed-name.test.mjs`) covering both
    per-id rules and risk-override-driven policy for Notion-style names.
  - `@strixgov/verifier` round-trip
    (`test/verifier-round-trip.test.mjs`) — every receipt this adapter
    produces verifies under the public verifier without modification.
