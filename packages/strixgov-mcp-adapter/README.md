# @strixgov/mcp-adapter

**Governance for every MCP tool call — at the action boundary, in five lines of code.**

Most AI governance tools operate upstream of the action (prompt filters,
evals) or downstream (audit logs, observability). The MCP adapter operates
at the action itself: every `callTool` your MCP server receives is
classified, evaluated against policy, and either allowed, denied, or held
for approval **before** it runs. Same enforcement applies regardless of
whether the actor is the agent, a human, or an automation. No changes to
your tool implementations required.

```
npm install @strixgov/mcp-adapter
```

Every call produces an Ed25519-signed receipt that anyone can verify with
[`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier).
Strix is not on the trust path of those receipts — the verifier depends
only on public JWKS (RFC 7517) and standard cryptographic primitives.

## Contents

- [See it in 20 seconds](#see-it-in-20-seconds) — `npx @strixgov/mcp-adapter demo`
- [NSA MCP report alignment](#nsa-mcp-report-alignment) — what CWE classes this addresses (and what it doesn't)
- [What it does](#what-it-does) — the five-layer wrap
- [5-line integration](#5-line-integration) — drop into your existing MCP server
- [API](#api) — `governMCPServer(tools, opts)` reference
- [Listening to receipts](#listening-to-receipts) — `onReceipt` callback + event hooks
- [Risk classification](#risk-classification) — heuristic vs companion-pack
- [Companion packs](#companion-packs) — do I need a pack for my MCP server?
- [Scaffold a governed server](#scaffold-a-governed-server-for-your-own-mcp--one-command) — `npx ... init <name>`
- [Try it (real MCP servers)](#try-it) — Notion, Filesystem, GitHub, Slack
- [Policy examples](#policy-examples) — allow/deny rules + risk overrides
- [Connected Mode (Commercial)](#connected-mode-commercial)
- [Verifying receipts](#verifying-receipts) — `npx @strixgov/verifier`
- [Standards alignment](#standards-alignment) — AARM, NSA MCP guidance

## See it in 20 seconds

```
npx @strixgov/mcp-adapter demo
```

One command. No clone, no install, no env vars. Spins up an in-process
stub MCP server, drives three governed tool calls covering all three
policy outcomes (ALLOW / APPROVAL_REQUIRED / DENY), prints three
Ed25519-signed receipts, then hands the chain to `@strixgov/verifier`
— an independent package with zero Strix dependencies — and prints
`✓ VERIFIED`.

Same code path every production deployment runs. No demo-only signing
shortcut. The receipts the demo produces would verify under any
third-party verifier that speaks the public JWKS contract.

The demo persists its receipts and public JWKS into a unique temp
directory and prints the literal `npx @strixgov/verifier chain <path>
--jwks <path>` command at the end — copy/paste and you re-verify the
same chain from a separate process, exactly as an external auditor
would.

## NSA MCP report alignment

NSA Cybersecurity Information [`U/OO/6030316-26 | PP-26-1834 | May 2026 Ver. 1.0`](https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/4192261/nsa-releases-cybersecurity-information-on-security-considerations-for-the-model/)
names arbitrary code execution under CWE-77, CWE-78, CWE-94, and CWE-95
as a concrete (not hypothetical) MCP attack class — driven by
implementations that let actor-controlled inputs reach execution
environments without appropriate constraints. The adapter interposes at
exactly that boundary: every `callTool` is classified, evaluated against
policy, and either allowed, denied, or held for approval **before**
it runs. The durable map from each NSA-named concern to the file +
invariant that addresses it lives at
[`docs/launch/2026-05-23-nsa-mcp-technical-companion.md`](https://github.com/Strixgov/strix/blob/main/docs/launch/2026-05-23-nsa-mcp-technical-companion.md).
What this package does **not** address: prompt injection of the LLM
itself (Strix prevents the unauthorized action from executing; it does
not prevent the agent from being tricked into trying — see
[`docs/security/AA-2-OUT-OF-SCOPE.md`](https://github.com/Strixgov/strix/blob/main/docs/security/AA-2-OUT-OF-SCOPE.md)).

## What it does

Wraps your MCP server's `callTool` path with:

- **Policy enforcement** — ALLOW / DENY / APPROVAL_REQUIRED per tool
- **Signed execution receipts** — Ed25519 signature on every call (allowed or denied)
- **Companion-pack classification** — pre-classified risk levels for 40+ common tools (GitHub, Slack, Notion, Linear)
- **Heuristic fallback** — auto-classifies any unknown tool by name pattern (`get_*` → LOW READ, `delete_*` → CRITICAL WRITE, etc.)
- **Fail-closed guarantee** — unknown tools default to CRITICAL EXECUTE → DENY unless explicitly allowed

## 5-line integration

```js
import { governMCPServer } from "@strixgov/mcp-adapter";
import { githubCapabilities } from "@strixgov/capabilities-mcp-common/github";

const governed = governMCPServer(myToolHandlers, {
  serverId: "github",
  capabilities: githubCapabilities,
  policy: {
    rules: {
      "mcp.github.get_file_contents":   "ALLOW",
      "mcp.github.merge_pull_request":  "APPROVAL_REQUIRED",
      "mcp.github.delete_repository":   "DENY",
    },
    default: "DENY",
  },
});

// Drop-in for your MCP request handler:
const result = await governed.callTool(name, args, { actorId: "agent-1" });
```

`myToolHandlers` is your existing tool map — no changes required.

## API

### `governMCPServer(tools, opts)`

**`tools`** — either:
- `Record<string, async (args) => result>` — plain handler map (most common)
- `{ handler(name, args), listTools() }` — MCP server interface

**`opts`**:
| Field | Type | Description |
|-------|------|-------------|
| `serverId` | string | Namespace prefix for capability IDs (`mcp.<serverId>.<toolName>`) |
| `capabilities` | `McpCapability[]` | Companion-pack capability list (optional — heuristics used if omitted) |
| `policy.rules` | `Record<string, "ALLOW"\|"DENY"\|"APPROVAL_REQUIRED">` | Per-capability overrides |
| `policy.riskOverrides` | `Record<string, "ALLOW"\|"DENY"\|"APPROVAL_REQUIRED">` | Policy by risk level |
| `policy.default` | `"ALLOW"\|"DENY"` | Catch-all (default: `"DENY"`) |
| `signingKey` | object | Ed25519 key for receipts (auto-generated if omitted) |
| `storagePath` | string (directory) | **Directory** to persist receipts in. Receipts land at `<storagePath>/receipts.jsonl` (the file is appended to, not overwritten). In-memory only if omitted. Note: passing a `*.jsonl` filename here creates a directory of that name — pass the parent dir. |
| `connectedMode` | object | Sync receipts to strixgov.com (opt-in) |
| `rateLimits` | object | Per-capability rate limits |

**Returns:**
```ts
{
  callTool(name, args, ctx?): Promise<unknown>
  listTools(): Promise<Array<{ name: string }>>
  gateway: Gateway  // emit "receipt" events here
  signingKey: object
}
```

### `createGovernedServer(opts)`

Convenience alias — pass `tools` alongside the other opts in a single object:

```js
const server = createGovernedServer({
  serverId: "github",
  capabilities: githubCapabilities,
  policy: { default: "DENY" },
  tools: {
    get_file_contents: async (args) => octokit.repos.getContent(args),
    merge_pull_request: async (args) => octokit.pulls.merge(args),
  },
});
```

## Listening to receipts

Every call (allowed or denied) emits a signed receipt:

```js
governed.gateway.on("receipt", (receipt) => {
  console.log(receipt.decision);    // "ALLOW" | "DENY"
  console.log(receipt.signature);   // Ed25519 hex
  console.log(receipt.actorId);     // forwarded from ctx
  console.log(receipt.capabilityId); // e.g. "mcp.github.get_file_contents"
});
```

## Risk classification

Without a companion pack, tools are classified by name:

| Pattern | Risk | Mode |
|---------|------|------|
| `get_*`, `list_*`, `read_*`, `fetch_*`, `search_*` | LOW | READ |
| `create_*`, `update_*`, `edit_*`, `post_*`, `send_*` | HIGH | WRITE |
| `delete_*`, `remove_*`, `destroy_*` | CRITICAL | WRITE |
| `exec_*`, `run_*`, `execute_*` | CRITICAL | EXECUTE |
| (anything else) | CRITICAL | EXECUTE |

Unknown tools default CRITICAL EXECUTE — policy `default: "DENY"` blocks them.

## Companion packs

Pre-classified capability lists are available in `@strixgov/capabilities-mcp-common`:

```js
import { githubCapabilities } from "@strixgov/capabilities-mcp-common/github";
import { slackCapabilities }  from "@strixgov/capabilities-mcp-common/slack";
import { notionCapabilities } from "@strixgov/capabilities-mcp-common/notion";
import { linearCapabilities } from "@strixgov/capabilities-mcp-common/linear";
```

## Scaffold a governed server for your own MCP — one command

`npx @strixgov/mcp-adapter init <server-name>` writes a runnable
single-file governed server into your current directory. It runs
immediately in offline stub mode (3 sample calls → 3 signed receipts)
and marks the 5 blocks you need to fill in with `TODO(strix):` so you
can grep your way to production.

```sh
# A known companion pack — auto-imports @strixgov/capabilities-mcp-common/notion
npx @strixgov/mcp-adapter init notion

# Your own server — inlines a starter capabilities array you fill in
npx @strixgov/mcp-adapter init my-internal-server

# With the connected-mode env-var block scaffolded in
npx @strixgov/mcp-adapter init github --with-connected-mode
```

Known packs: `notion`, `github`, `slack`, `linear`, `filesystem`,
`postgres`, `email`. Anything else gets the "starter inline" branch with
two placeholder capability entries.

The generated file is the same shape as the seven examples below — your
own MCP server, governed at the action boundary, in five lines of code.

## Try it

Seven runnable end-to-end examples ship with the package; each defaults
to an offline stub (zero config) and auto-promotes to the real MCP
server over stdio when the optional peers are present. Pick the one
that matches the MCP your prospect already uses.

| Example | What it demonstrates |
|---|---|
| [`examples/notion.mjs`](./examples/notion.mjs) | Server-prefixed tool names (`notion-fetch`, `notion-create-comment`); MEDIUM-write approval flow; explicit `notion-create-database` DENY |
| [`examples/filesystem.mjs`](./examples/filesystem.mjs) | Highest blast radius; LOW/MEDIUM/HIGH outcomes plus a heuristic-CRITICAL DENY for out-of-pack `delete_file` |
| [`examples/github.mjs`](./examples/github.mjs) | The marquee procurement story — `merge_pull_request` (CRITICAL irreversible) held for approval, bound cryptographically to the signed receipt |
| [`examples/slack.mjs`](./examples/slack.mjs) | CISO-legible "agent posted to a channel" story; also exercises the cap.name lookup path for hyphen/underscore server-prefixed names |
| [`examples/postgres.mjs`](./examples/postgres.mjs) | Enterprise-depth story — MEDIUM-classified SELECTs (exfiltration discipline) gated for approval; query preview surfaced to the approver; out-of-pack `drop_table` DENY'd via heuristic |
| [`examples/email.mjs`](./examples/email.mjs) | High-adoption story — `send_email` / `reply_all` / `forward` are HIGH WRITE (irreversible once delivered); to/subject surfaced to the approver; out-of-pack `purge_mailbox` blocked |
| [`examples/linear.mjs`](./examples/linear.mjs) | Team-operations wrap rounding out Notion + Slack — `delete_issue` HIGH, out-of-pack `archive_team` heuristic-CRITICAL DENY |

### Notion — `examples/notion.mjs`

```sh
node examples/notion.mjs            # offline stub — zero config

# Live mode against the real Notion MCP server (optional peers):
npm install --no-save @modelcontextprotocol/sdk @notionhq/notion-mcp-server
NOTION_TOKEN=secret_… node examples/notion.mjs
```

Wraps Notion's full tool surface, allows every read, gates every write
behind an approval prompt (auto-approved for the demo), and hard-denies
`notion-create-database`. Every call — allowed or denied — produces a
signed receipt printed at the end.

### Filesystem — `examples/filesystem.mjs`

```sh
node examples/filesystem.mjs        # offline stub — zero config

# Live mode against the reference @modelcontextprotocol/server-filesystem:
npm install --no-save @modelcontextprotocol/sdk @modelcontextprotocol/server-filesystem
mkdir -p /tmp/strix-fs-demo
STRIX_FS_LIVE_ROOT=/tmp/strix-fs-demo node examples/filesystem.mjs
```

Highest-blast-radius wrap in the bundle. Demonstrates four policy
outcomes against real filesystem ops — LOW READ ALLOW
(`list_directory`, `read_file`), MEDIUM WRITE APPROVAL_REQUIRED
(`write_file`), HIGH WRITE APPROVAL_REQUIRED (`move_file`), and a
heuristic-classified CRITICAL DENY for an unknown `delete_file` tool
that isn't in the pack — proving the fail-closed default works for
out-of-pack tools.

### GitHub — `examples/github.mjs`

```sh
node examples/github.mjs            # offline stub — zero config

# Live mode against the official @modelcontextprotocol/server-github:
npm install --no-save @modelcontextprotocol/sdk @modelcontextprotocol/server-github
export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…
node examples/github.mjs
```

The strongest narrative wrap. The companion pack classifies ~30
GitHub tools including `merge_pull_request` (CRITICAL — irreversible
from the gate's perspective; revert is a *new* commit). The demo
holds the merge for approval rather than denying it outright, and
binds the approver's identity cryptographically to the signed
receipt. This is the cleanest "Strix held the irreversible action
for a known approver" demo for procurement conversations. Also
shows an out-of-pack `delete_repository` failing closed via
heuristic CRITICAL → DENY.

### Slack — `examples/slack.mjs`

```sh
node examples/slack.mjs             # offline stub — zero config

# Live mode requires a Slack MCP server + a workspace token:
npm install --no-save @modelcontextprotocol/sdk @modelcontextprotocol/server-slack
export SLACK_MCP_XOXP_TOKEN=xoxp-…
node examples/slack.mjs
```

CISO-legible governance story. The Slack pack uses
**server-prefixed** tool names (`slack_send_message`,
`slack_read_channel`) — different from GitHub's bare convention. The
example also includes an in-line regression check: if any in-pack
Slack tool produces a heuristic-derived receipt id instead of the
pack-canonical id, the demo exits non-zero. That pins the cap.name
lookup path against accidental regression.

## Policy examples

### Allow reads, block writes
```js
policy: {
  riskOverrides: { LOW: "ALLOW" },
  default: "DENY",
}
```

### Allowlist specific tools
```js
policy: {
  rules: {
    "mcp.github.get_file_contents": "ALLOW",
    "mcp.github.list_pull_requests": "ALLOW",
  },
  default: "DENY",
}
```

### Require approval for destructive actions
```js
policy: {
  rules: {
    "mcp.github.delete_repository": "APPROVAL_REQUIRED",
    "mcp.github.merge_pull_request": "APPROVAL_REQUIRED",
  },
  riskOverrides: { LOW: "ALLOW" },
  default: "DENY",
}
```

## Connected Mode (Commercial)

By default the adapter operates locally — receipts go to memory or
JSONL on disk via `storagePath`. For production deployments that need
centralized approvals, multi-tenant isolation, 2-year retention (EU AI
Act Article 12), or compliance evidence packs, Strix offers Connected
Mode via the `strixgov.com` platform.

**Connected Mode requires a commercial license.** Once provisioned,
the adapter detects two env vars and starts forwarding signed
receipts to the platform in the background:

```sh
export STRIX_API_KEY="<from your strixgov.com tenant settings>"
export STRIX_TENANT_ID="<your tenant slug>"
# STRIX_KERNEL_URL defaults to https://www.strixgov.com
```

To obtain a commercial license + API key, see [COMMERCIAL.md](./COMMERCIAL.md)
or email `sales@strixgov.com`.

Local execution is never blocked by network availability — Connected
Mode is a *forward* of locally-signed receipts, not a *gate* on them.
To opt out of auto-detection (even with the env vars set), pass
`connectedMode: false` explicitly.

```js
import { governMCPServer, loadConnectedModeFromEnv } from "@strixgov/mcp-adapter";

const srv = governMCPServer(tools, {
  serverId: "github",
  policy: { default: "DENY" },
  connectedMode: loadConnectedModeFromEnv(), // null → stays local
});
```

## Verifying receipts

The receipts this adapter produces are byte-compatible with
[`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier).
To verify a chain end-to-end you need two artifacts on disk: the
receipts JSONL (produced by passing `storagePath` to the adapter) and
the public JWKS (the public half of the gateway's Ed25519 signing key).

```js
// 1) Wire the adapter with storagePath — receipts land at
//    <storagePath>/receipts.jsonl, one JSONL row per callTool.
const governed = governMCPServer(myTools, {
  serverId: "github",
  storagePath: "./strix-receipts",  // directory, NOT a *.jsonl file
  policy: { default: "DENY" },
});
```

```bash
# 2) Export the gateway's public JWKS (Strix is not on the trust path —
#    the verifier only needs the public keys, not the gateway itself).
npx strix-gateway keys jwks > ./public-jwks.json

# 3) Verify a single receipt
npx @strixgov/verifier receipt path/to/receipt.json --jwks ./public-jwks.json

# 4) Verify the whole chain
npx @strixgov/verifier chain ./strix-receipts/receipts.jsonl --jwks ./public-jwks.json
```

> `npx @strixgov/mcp-adapter demo` exercises this exact round-trip end
> to end: it persists receipts to a unique temp directory, writes the
> JWKS alongside, and prints the literal `chain <path> --jwks <path>`
> command on success — so you can paste it into a separate shell and
> reproduce the verification without trusting anything the demo itself
> printed.

The verifier has **zero Strix dependencies** — just Ed25519 + SHA-256 from
`node:crypto` and the public JWKS contract. **Strix is not on the trust
path** of receipt verification: any third party can confirm an action was
authorized at execution time without trusting Strix at all.

## Standards alignment

Strix is listed in the [Cloud Security Alliance AARM Builders
Registry](https://cloudsecurityalliance.org/research/working-groups/ai-systems-management)
with status **Aligned**. AARM (Autonomous Action Runtime Management) is the
CSA-led specification for runtime governance of autonomous AI actions.

This adapter is the **MCP-specific drop-in** for Strix's AARM coverage. It
implements AARM Core R1–R3 (runtime authorization, deterministic policy
evaluation, fail-closed enforcement) at the MCP boundary, on top of
[`@strixgov/tool-gateway`](https://www.npmjs.com/package/@strixgov/tool-gateway).
The signed receipts it produces are tamper-evident under
[`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier)
— the public reference implementation of AARM Core R6.

See the [strixgov.com AARM mapping](https://www.strixgov.com/partners/aarm)
for the per-requirement breakdown.

## Requirements

- Node.js ≥ 18
- `@strixgov/tool-gateway` ≥ 0.4.1 (peer dependency)

## Security posture

See [`SECURITY.md`](./SECURITY.md) for the security-team-facing
posture, including:

- **Credential boundary** — three deployment positions (host holds /
  per-call passthrough / never crosses the host) with the audit-
  posture trade-off of each.
- **What the adapter stores** — only signed receipts (with
  `invocationHash`, NOT raw args), the gateway signing key, and
  policy config. Never auth credentials. Never raw tool args.
- **Runtime model** — what happens on host crash / mid-approval /
  disk full. Fail-closed at every boundary; `governMCPServer(...)`
  throws at construction if the signing key isn't loadable.
- **Multi-tenant boundary** — single-tenant per `governMCPServer(...)`
  instance in v0.1.0; instantiate once per tenant for isolation.
- **What the adapter does NOT govern** — direct handler calls that
  bypass the gateway, the agent's internal state, the upstream
  tool's own argument handling (SQL/command injection inside the
  upstream is the upstream's responsibility).

Report security issues via GitHub Security Advisory on
`github.com/Strixgov/strix`.

## License

`@strixgov/mcp-adapter` is distributed under the [Elastic License
2.0](./LICENSE). You may use, modify, and self-host the adapter
internally — including in production — provided you do not offer it
as a hosted or managed service to third parties.

If you run the adapter in a commercial product or want hosted
Connected Mode, retention, approvals, or compliance evidence packs,
see [COMMERCIAL.md](./COMMERCIAL.md) or email `sales@strixgov.com`.

The trust primitives the adapter depends on
([`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier),
[`@strixgov/tool-gateway`](https://www.npmjs.com/package/@strixgov/tool-gateway),
[`@strixgov/mcp-token-validator`](https://www.npmjs.com/package/@strixgov/mcp-token-validator))
remain MIT-licensed. Strix is not on the trust path of receipt
verification or token validation — that property is unchanged by
this license boundary.
