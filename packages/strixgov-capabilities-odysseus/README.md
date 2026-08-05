# @strixgov/capabilities-odysseus

Pre-classified capability registry for the
[Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) self-hosted
AI workspace. Drop-in starter for `@strixgov/tool-gateway` and
`@strixgov/mcp-proxy`.

This is a **host pack** (namespace `odysseus.<surface>.<action>`, like
`claude.*` in `@strixgov/capabilities-claude-code`) — it classifies the
workspace's own action surface. MCP servers the workspace connects to
are classified by their own packs (e.g.
`@strixgov/capabilities-mcp-common` for Slack/GitHub/Notion/Filesystem/
Postgres/Email).

## The one-line pitch

Keep the workspace local. Put execution control around the actions that
matter.

## Surfaces classified (19 capabilities)

| Surface | Capabilities | Highest risk |
|---|---|---|
| Shell | `shell.execute` | CRITICAL |
| Files | `file.read/list/write/delete` | HIGH |
| Email | `email.read/draft/send` | HIGH (send) |
| Web | `web.search/fetch` | MEDIUM (fetch — a read that can exfiltrate) |
| Scheduler | `schedule.create/delete/execute` | HIGH (authority projected forward in time) |
| Memory | `memory.read/write/delete` | MEDIUM (write — injection-persistence vector) |
| Secrets | `secret.access` | HIGH (the read is the blast radius) |
| Extensions | `mcp.invoke`, `skill.install` | CRITICAL (skill install = deferred code execution) |

These are starters, not policy — override any classification in your
local ruleset.

## Enforcement honesty (read this before quoting the pack)

Every capability carries an `interception` field:

- **`"mcp-proxy"`** — enforceable **today**. Point Odysseus's MCP
  server configuration at `@strixgov/mcp-proxy` and every wrapped tool
  call is intercepted, evaluated, optionally held for approval, and
  receipted **before** the side effect. In v0.1.0 this is exactly one
  entry: `odysseus.mcp.invoke`.
- **`"host-hook"`** — the action uses Odysseus's **native** code path
  (shell, files, email, scheduler, memory, secrets, skills). Until an
  upstream host hook routes that path through the gateway, the surface
  is **OBSERVE-ONLY** and must be labeled
  `OBSERVE ONLY — ACTION NOT ENFORCED` wherever it is rendered.
  Observe-only output is never called governed execution.

`enforceableToday()` / `observeOnlyToday()` expose the partition
programmatically, and `test/enforcement-honesty.test.mjs` pins it —
growing the enforced set requires a real interception path, not a
re-label.

## Usage

```js
import {
  allOdysseusCapabilities,
  odysseusCapabilityMap,
  suggestedPolicy,
  enforceableToday,
} from "@strixgov/capabilities-odysseus";

// Compose with the MCP-server packs for the servers you wrap:
import { mcpCapabilityMap } from "@strixgov/capabilities-mcp-common";

const policy = suggestedPolicy();
// → CRITICAL DENY · LOW READ ALLOW · everything else APPROVAL_REQUIRED · default DENY
```

Suggested policy semantics match `@strixgov/capabilities-mcp-common`:
CRITICAL → `DENY`; LOW READ → `ALLOW`; any other READ →
`APPROVAL_REQUIRED` (web.fetch and secret.access are reads that can
exfiltrate); WRITE/EXECUTE → `APPROVAL_REQUIRED`; default `DENY`.

## Quick start: govern Odysseus's MCP tool calls

See the operator runbook in the strix-platform repo:
`docs/runbooks/odysseus-governed-demo.md`. Short version: wrap each MCP
server in Odysseus's config with `@strixgov/mcp-proxy`, load this pack's
`suggestedPolicy()` plus the relevant mcp-common server pack, and the
approval gate + signed receipts apply to every wrapped tool call.

## Host-version note

Capability `name` values are stable pack-side identifiers. Odysseus is
a fast-moving upstream; when its dispatch identifiers are pinned against
a tested host release, alias entries will be added (the same approach
`@strixgov/capabilities-mcp-common` 0.1.1 took for the Notion `API-*`
rename — old and new names coexist via `name` lookup).

## Program contract

This pack is Phase 1 of the Workspace Governance Adapter Program:
`docs/strategy/workspace-governance-adapter-program-v1.md` in
strix-platform. Receipt format for governed calls is MC-1
(`mcp_proof_v1`, ADR-020 in solo-builder-core) — no workspace-specific
proof schema exists or will exist.

## License

MIT — capability schema contracts are open trust primitives under the
Strix licensing split (`LICENSING_BOUNDARY.md`). The interception
runtime (`@strixgov/mcp-proxy`) is separately licensed under
Elastic-2.0.
