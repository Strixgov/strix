# Changelog — @strixgov/capabilities-odysseus

## 0.1.0 (2026-06-12)

Initial release — Phase 1 of the Workspace Governance Adapter Program
(`docs/strategy/workspace-governance-adapter-program-v1.md`).

- 19 capabilities across 8 surfaces: shell, files, email, web,
  scheduler, persistent memory, secrets, extensions (MCP passthrough +
  skill install). Namespace `odysseus.<surface>.<action>` (host pack).
- `interception` field on every capability (`"mcp-proxy"` |
  `"host-hook"`) + `enforceableToday()` / `observeOnlyToday()` —
  encodes which surfaces pre-execution interception can actually reach
  today. v0.1.0 ships exactly one enforceable entry
  (`odysseus.mcp.invoke`); all native surfaces are observe-only until
  upstream host hooks exist.
- `suggestedPolicy()` with mcp-common semantics (CRITICAL DENY · LOW
  READ ALLOW · everything else APPROVAL_REQUIRED · default DENY).
- 21 tests (`node --test`): registry shape, risk-model pins
  (shell CRITICAL, email.send HIGH, skill.install CRITICAL,
  secret.access HIGH READ, scheduler re-evaluation contract), and the
  enforcement-honesty ratchet.
