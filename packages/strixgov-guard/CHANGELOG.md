# Changelog

All notable changes to `@strixgov/guard` are documented here.

## [0.2.0] - unreleased

### Changed (breaking)
- **Signed approvals are the default.** `init` requires an approver key and
  writes proxy configs that refuse any approval not signed by it. In a
  terminal, `init` creates the key if there is none (passphrase typed twice,
  never read from arguments, the environment or a pipe). Outside a terminal it
  refuses and says how to proceed. `--unsigned-approvals` opts out explicitly
  and prints a warning: unsigned approvals are files that any process running
  as you can write. `--signed-approvals` is still accepted and does nothing new.
- Re-running `init` upgrades what an older Guard wrote: entries it wrapped are
  re-pointed at the newly pinned proxy (their proxy configs are kept), and with
  an approver key their proxy configs are made to require signed approvals.
  Entries that launch the proxy with a config outside the Guard home are left
  alone.
- Generated entries launch `@strixgov/mcp-proxy@0.2.4`, which pins its Strix
  dependencies (tool-gateway, mcp-adapter, capabilities-mcp-common) exactly.
  Before this, a proxy pinned by Guard still resolved tool-gateway within a
  range, so a new tool-gateway release changed what existing installs ran.
- `engines.node` is `>=20` (Node 18 is end of life).

### Added
- `strix-guard uninstall [--config <path>] [--dry-run]`: restores each wrapped
  server's original command, args and env from its Guard proxy config, keeps
  any edits made to the client config after `init`, backs the config up first,
  and leaves `~/.strix-guard` (and its receipts) in place. Entries that launch
  the proxy with a config outside the Guard home, or whose proxy config is
  missing, are reported and left alone.
- On Windows, generated entries launch the proxy through `cmd /c npx …`,
  because MCP clients spawn commands without a shell and Node cannot spawn the
  `npx.cmd` shim that way. The coverage audit and `init` recognise both forms.
- `npm test` runs `scripts/run-tests.mjs`, which lists the test files itself
  (no shell glob, so it works on Windows) and exits non-zero on no tests, an
  unreadable summary or fewer than 45 tests (54 at 0.2.0).

## [0.1.4] - 2026-11-08
- Signed approvals (opt in): `approver init|show`, `init --signed-approvals`,
  signed `approve`. Pinned proxy version, structural wrapped-entry detection,
  verified proxy routes in the coverage audit, owner-only backups.
