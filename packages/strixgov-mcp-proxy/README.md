# @strixgov/mcp-proxy

**The distribution wedge for governed agent tool execution. Point your MCP client at the proxy instead of the underlying server — every `callTool` becomes intercepted, evaluated against policy, and emits a signed Ed25519 receipt. Designed so Mode 3 enforcement is the v0.2.0 upgrade path, not a rewrite.**

```sh
npm install -g @strixgov/mcp-proxy
strix-mcp-proxy --config ./proxy-config.json
```

Compared to `@strixgov/mcp-adapter`, which is a library you integrate into
your own MCP server code: the proxy is a **standalone process** you run in
front of any existing MCP server, with **zero changes** to your tool
implementations. It's the "change your MCP endpoint" path — the lowest-friction
way to put Strix governance in front of an agent in production.

## What it does

```
MCP Client ──stdio──▶ [strix-mcp-proxy] ──stdio──▶ Upstream MCP Server (Notion, GitHub, Filesystem, …)
                            ▲
                            │
                    governMCPServer:
                    classify → policy → approval → receipt
```

For every incoming `callTool`:

1. **Classify** the tool via the configured companion pack (heuristic fallback for unknown).
2. **Evaluate** policy — `ALLOW` / `DENY` / `APPROVAL_REQUIRED`.
3. **Hold** for an approver when policy demands it.
4. **Execute** via the upstream MCP server (only on `ALLOW`).
5. **Sign** an Ed25519 receipt — allowed or denied — verifiable against the public JWKS by `@strixgov/verifier`.

Tool implementations are untouched. The MCP client (Claude Desktop, mcp-cli,
IDE integration, your own code) doesn't need to know Strix exists — it just
spawns this proxy in place of the upstream server.

> **Transport scope (v0.1.x):** the proxy wraps MCP servers that speak
> the **stdio transport** — the `command` / `args` pattern in
> `claude_desktop_config.json`. It does **not** intercept HTTP-based
> hosted MCP servers (e.g. Notion's `https://mcp.notion.com/mcp`
> Claude Desktop "Connector" pattern). If your MCP server is reachable
> only over HTTPS, the proxy cannot govern it today; that's
> [Posture B](https://github.com/Strixgov/strix/tree/main/docs/architecture/mcp-mode-3-enforcement-v1.md)
> in the Mode 3 architecture and is deferred to a future release. Use
> the local stdio version of the upstream MCP server in the meantime.

## 5-line integration (Claude Desktop)

Claude Desktop's config file lives at:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json` (resolves to `C:\Users\<you>\AppData\Roaming\Claude\claude_desktop_config.json` — outside any OneDrive Known Folder Move)
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```jsonc
{
  "mcpServers": {
    "notion": {
      "command": "strix-mcp-proxy",
      "args": ["--config", "/absolute/path/to/notion-proxy-config.json"],
      // Env vars set here propagate to the proxy and on to the upstream
      // MCP server via process.env (the proxy passes them through by
      // default — see `upstream.env` below to override explicitly).
      "env": {
        "NOTION_TOKEN": "secret_..."
      }
    }
  }
}
```

The config file at `notion-proxy-config.json` points the proxy at the
real Notion MCP server and sets your policy. See
[`examples/notion-proxy-config.json`](./examples/notion-proxy-config.json)
for a complete example.

## Config file shape

```jsonc
{
  "serverId": "notion",                         // namespace for capability ids
  "upstream": {
    "command": "npx",
    "args": ["-y", "@notionhq/notion-mcp-server"],
    // Optional. If omitted, the proxy passes process.env through to
    // the upstream (so env vars set in Claude Desktop's `env` block
    // reach the upstream automatically). Setting `upstream.env`
    // overrides that default — only the keys you list are passed.
    "env": {
      "NOTION_TOKEN": "secret_..."
    }
  },
  "capabilities": "@strixgov/capabilities-mcp-common/notion",  // import path
  "policy": {
    "rules": {
      "mcp.notion.create_database": "DENY"      // per-capability override
    },
    "riskOverrides": {
      "LOW": "ALLOW",
      "MEDIUM": "APPROVAL_REQUIRED",
      "HIGH": "APPROVAL_REQUIRED",
      "CRITICAL": "DENY"
    },
    "default": "DENY"
  },
  "approval": {
    "enabled": true,
    "type": "file",                             // headless-friendly approver (see "Approval modes" below)
    "requestDir": "~/.strix-mcp-proxy/notion/approvals",
    "timeoutMs": 300000                         // 5 minutes
  },
  "storagePath": "~/.strix-mcp-proxy/notion",   // optional (this IS the default for serverId="notion"); set to `null` for ephemeral

  // Optional. Explicit directory for the persistent Ed25519 signing key,
  // independent of storagePath. When set, the proxy generates or loads
  // the key from this path on startup (PKCS8 PEM at 0600 / public JWK
  // at 0644). Tilde is expanded via os.homedir().
  //
  // Useful when you want the signing key in a fixed, predictable location
  // (e.g. a secrets volume) that is separate from the receipts store.
  // Takes precedence over the storagePath-derived key location when both
  // are set. If neither keyPath nor storagePath is set the key is generated
  // in memory and not persisted.
  "keyPath": "~/.strix-mcp-proxy/my-server/keys"
}
```

`capabilities` can be either:
- a bare import path (`@strixgov/capabilities-mcp-common/notion`,
  `@strixgov/capabilities-mcp-common/github`, etc.) — resolved at startup
- an inline array of `McpCapability` objects (caller-managed classification)

### Where the upstream's secrets should live

v0.1.x does **no env-var substitution inside the config file** — there
is no `${NOTION_TOKEN}` template syntax. Two supported patterns for
upstream secrets:

1. **Set in Claude Desktop's `env` block** (recommended for
   first-time setup) — the MCP client passes them to the proxy
   process; the proxy passes `process.env` to the upstream by
   default. Token never appears in `notion-proxy-config.json`, so
   the config file is safe to check into source control (without the
   policy values that depend on environment, of course).
2. **Set in `upstream.env`** (recommended when the proxy is the
   only consumer of the upstream) — explicit, narrower exposure
   surface. Only the keys you list reach the upstream; everything
   else from `process.env` is filtered out.

On Windows specifically, prefer placing `storagePath` outside any
OneDrive Known Folder Move directory. The default `~/.strix-mcp-proxy/`
resolves to `C:\Users\<you>\.strix-mcp-proxy\` (a dotfile-style
directory under the user root), which is **not** covered by Known
Folder Move and stays local.

## Approval modes

The proxy's `approval` config field accepts a `type` string that maps to
the appropriate approver from `@strixgov/tool-gateway`. The gateway's
underlying `approval.prompt` field expects a function, which JSON config
can't carry — `type` is the JSON-friendly bridge.

| `approval.type` | What it does | When to use it |
|---|---|---|
| omitted, `approval.enabled: false` | No prompt — every `APPROVAL_REQUIRED` decision becomes `DENY` with `reason: "PROMPT_FAILED"`. | Default; safest if you haven't built an approval pathway yet. |
| `"auto"` | Auto-approves every call that hits the gate. Receipt records `approval.approved: true, approvedBy: "auto"`. | Demos; smoke tests; environments where you want to show the approval-loop wired up without a real human in the loop. **Defeats meaningful governance** for production. |
| `"file"` | Wires up `fileApprover`: proxy writes `<requestDir>/<requestId>.request.json`; an out-of-band approver writes `<requestId>.response.json` with `{approved, approvedBy?, reason?}`. | Production-leaning headless deployments — Claude Desktop, CI, containerised agents. Pair with whatever notification channel you want (Slack bot, GitHub Actions check, on-call rotation script) that ultimately writes the response file. |
| `"terminal"` | Interactive `y/N` prompt on stdin. Fails closed (`PROMPT_FAILED → DENY`) in any non-TTY context. | Direct-CLI testing where you're running the proxy yourself and want to manually approve. **Not viable under Claude Desktop spawn** — Claude Desktop owns the stdio channel; there's no terminal to prompt to. |

**Example: file-based approval under Claude Desktop.** In your
`notion-proxy-config.json`:

```jsonc
"approval": {
  "enabled": true,
  "type": "file",
  "requestDir": "~/.strix-gateway/approvals",
  "timeoutMs": 300000        // 5 minutes
}
```

Then write a tiny watcher that approves or denies. Example PowerShell
sketch (one approval at a time):

```powershell
$watchDir = "$env:USERPROFILE\.strix-gateway\approvals"
while ($true) {
  Get-ChildItem $watchDir -Filter "*.request.json" | ForEach-Object {
    $req = Get-Content $_.FullName | ConvertFrom-Json
    Write-Host "PENDING: $($req.invocation.capabilityId)  actor=$($req.invocation.actorId)"
    $answer = Read-Host "Approve? [y/N]"
    $approved = $answer -in @("y","Y","yes")
    $respPath = $_.FullName -replace ".request.json$", ".response.json"
    @{ approved = $approved; approvedBy = $env:USERNAME } | ConvertTo-Json | Set-Content $respPath
  }
  Start-Sleep -Milliseconds 500
}
```

Operator + audit channels (Slack, PagerDuty, ServiceNow, etc.) replace
the `Read-Host` line — same file-shape on both ends.

Resolution order if multiple approval fields are set (caller-supplied
programmatic config wins):

1. `approval.prompt` is a function ⇒ pass through (caller intent wins)
2. `approval.enabled === false` ⇒ pass through (gate disabled)
3. `approval.autoApprove === true` ⇒ pass through (long form of `type: "auto"`)
4. `approval.type ∈ {"auto","file","terminal"}` ⇒ resolved
5. Unknown `type` ⇒ startup error (fail-fast)

## CLI flags (no config file needed for simple cases)

```sh
strix-mcp-proxy \
  --upstream-command npx \
  --upstream-arg "-y" --upstream-arg "@notionhq/notion-mcp-server" \
  --server-id notion \
  --capabilities @strixgov/capabilities-mcp-common/notion \
  --policy-default DENY \
  --risk-low ALLOW \
  --risk-medium APPROVAL_REQUIRED \
  --risk-critical DENY \
  --storage-path ~/.strix-mcp-proxy/notion
```

Run `strix-mcp-proxy --help` for the full flag list.

## What ships with the proxy

| Feature | v0.1.x (shipped) | v0.2.0 (planned) |
|---|---|---|
| MCP stdio transport (consumer side) | ✓ | — |
| MCP stdio transport (upstream side) | ✓ | — |
| MCP HTTP transport (either side) | — | ✓ |
| Companion-pack classification | ✓ | — |
| Heuristic fallback for unknown tools | ✓ | — |
| Fail-closed default policy | ✓ | — |
| Per-capability rules + risk overrides | ✓ | — |
| Approval gate (any approver implementation) | ✓ | — |
| Local-mode signed receipts (in-memory or JSONL) | ✓ | — |
| Connected mode (sync receipts to `strixgov.com`) | ✓ programmatic only via `startProxy({ connectedMode })` | ✓ JSON config |
| Mode 1 (Observed) | ✓ | — |
| Mode 2 (Approval-Gated) | ✓ | — |
| **Mode 3 (Capability-Enforced) — `execution_authorization_v1` token mint + transport** | — | ✓ |
| **Posture B reference impl (HTTP outbound enforcement)** | — | ✓ |

See [`docs/strategy/mcp-mode-ladder-v1.md`](https://github.com/Strixgov/strix/tree/main/docs/strategy/mcp-mode-ladder-v1.md)
for the framing of Mode 1 / 2 / 3 and the exact public claim available
at each enforcement strength.

## The upgrade path to Mode 3

Mode 3 — Capability-Enforced — is the upgrade, not a rewrite. The
v0.1.x proxy already routes every outbound call through a single
`buildUpstreamIface()` seam in `src/proxy.mjs`. In v0.2.0 a new option
(`mode: "enforced"`) will wrap that seam with the
`execution_authorization_v1` token mint + transport step per
[`docs/architecture/mcp-mode-3-enforcement-v1.md`](https://github.com/Strixgov/strix/tree/main/docs/architecture/mcp-mode-3-enforcement-v1.md).

Operators turn on Mode 3 by adding `"mode": "enforced"` to the config
file. Upstream MCP servers that opt in to validation (via
[`@strixgov/mcp-token-validator`](https://www.npmjs.com/package/@strixgov/mcp-token-validator))
refuse to act on sensitive tools unless the token is present.

The cryptographic primitive is already shipped — see
[`@strixgov/mcp-token-validator`](https://www.npmjs.com/package/@strixgov/mcp-token-validator).
v0.1.x of the proxy does not mint these tokens yet; what it does is
make sure the *seam* exists so v0.2.0 plugs in cleanly.

## Listening to receipts (programmatic embedding)

For embedded use cases (your own MCP host, custom orchestration, etc.)
where you want a callback on every signed decision rather than
polling the JSONL file:

```js
import { startProxy } from "@strixgov/mcp-proxy";

const handle = await startProxy({
  upstream: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
  serverId: "notion",
  capabilities: notionCapabilities,
  policy: { default: "DENY", riskOverrides: { LOW: "ALLOW" } },
  onReceipt: (r) => {
    console.log(r.decision, r.capabilityId, r.signature);
  },
});
```

For verifying those receipts independently, see the next section.

## Verifying receipts

Every receipt the proxy emits is byte-compatible with
[`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier)
— a zero-Strix-dependency package. The verifier needs two inputs: the
receipt JSONL file AND the public JWK that signed those receipts. How
you get the JWK depends on whether you set `storagePath` in your config.

### Default (v0.1.4+)

As of v0.1.4, **`storagePath` defaults to `~/.strix-mcp-proxy/<serverId>`
when unset**. Receipts persist as JSONL under that path; the Ed25519
signing key persists at `<storagePath>/keys/{signing-key.pem,
public-jwk.json}` on first start (PKCS8 PEM at `0600` / public JWK at
`0644`) and is reused across restarts. The default partitions per
`serverId` so multiple wrapped upstreams (notion + github + filesystem,
say) each get their own receipts file and signing key.

The verification command is one line:

```sh
# macOS / Linux
npx @strixgov/verifier chain ~/.strix-mcp-proxy/notion/receipts.jsonl \
  --jwks ~/.strix-mcp-proxy/notion/keys/public-jwk.json

# Windows PowerShell
npx '@strixgov/verifier' chain "$env:USERPROFILE\.strix-mcp-proxy\notion\receipts.jsonl" `
  --jwks "$env:USERPROFILE\.strix-mcp-proxy\notion\keys\public-jwk.json"
```

The verifier resolves `signingKeyId` against the JWKS, recomputes the
canonical bytes, verifies the Ed25519 signature, walks the proof chain,
and prints `N/N receipts VERIFIED`. The verifier uses only `node:crypto`;
no Strix-operated service is in the trust path.

> **Do not alias `storagePath` to `~/.strix-gateway`.** That directory
> is owned by the `strix-gateway` CLI's keyring, which uses a multi-kid
> layout (`active` pointer file + `<kid>/` subdirectories). The proxy
> writes a flat single-key layout (`signing-key.pem` + `public-jwk.json`
> at the keys/ root) — sharing the same `keys/` dir collides silently:
> the proxy's flat key files are invisible to the keyring loader, or
> the v0.1 auto-migration clobbers the gateway's active pointer to the
> proxy's kid. The default keeps these stores cleanly separated.

### Explicit ephemeral mode (`storagePath: null`)

If you want the pre-v0.1.4 behavior — fresh Ed25519 keypair in memory
at every startup, never persisted — pass `storagePath: null` explicitly
to `startProxy`. Receipts within a single proxy session remain chain-
coherent (each receipt links to the previous one's `proofChainHash`),
but signatures cannot be verified across restarts.

For a single-session demo, extract the JWK via the programmatic
`startProxy` handle before the proxy exits:

```js
import { startProxy } from "@strixgov/mcp-proxy";
import fs from "node:fs/promises";

const handle = await startProxy({ storagePath: null, /* …your config… */ });
await fs.writeFile(
  "./public-jwks.json",
  JSON.stringify({ keys: [handle.signingKey.publicKeyJwk] }, null, 2),
);
```

Then point the verifier at that JWKS file. **For any operational use,
let `storagePath` default (or set it explicitly) instead** — persistent
keys are strictly better in every dimension that isn't a one-off demo.

## What this proxy is NOT

- **Not an MCP server you call directly.** It's a *wrap* of an
  existing MCP server. You need an upstream.
- **Not a replacement for `@strixgov/mcp-adapter`.** The adapter is
  the library; the proxy is the standalone process. They share the
  same governance core (`@strixgov/tool-gateway`) and produce
  byte-identical receipts.
- **Not an interceptor of HTTP-transport MCP servers.** v0.1.x wraps
  the stdio transport only. Hosted HTTP MCP servers (the Claude
  Desktop "Add Connector" URL pattern, e.g.
  `https://mcp.notion.com/mcp`) are not in scope — the client talks
  to them over HTTPS directly and no local process exists to wrap.
  Use the upstream's local stdio server in the meantime; the
  HTTP-transport story is Posture B in
  [`docs/architecture/mcp-mode-3-enforcement-v1.md`](https://github.com/Strixgov/strix/tree/main/docs/architecture/mcp-mode-3-enforcement-v1.md).
- **Not Mode 3 today.** v0.1.x ships Mode 1 + Mode 2. Mode 3
  enforcement is the v0.2.0 upgrade path, designed for, but not
  implemented in, this release.
- **Not a credential vault.** Upstream tokens (`NOTION_TOKEN`,
  `GITHUB_TOKEN`, etc.) flow through `process.env` or
  `upstream.env` and reach the upstream MCP server as-is. The
  proxy does not store them, and they never appear in signed
  receipts — receipts carry only the `invocationHash` (SHA-256 of
  the canonical-JSON of the args), not the raw args themselves.
  Token persistence is on the roadmap — a stopgap OS-keychain
  integration and a full OAuth credential broker are both tracked.

## Known issues from real-world dogfood

A handful of failure modes that real first-run integrations have hit.
Each one has a one-line fix below.

| Symptom | Root cause | Fix |
|---|---|---|
| Proxy exits at startup with `[strix-proxy] startup failed: Cannot find package '@strixgov/capabilities-mcp-common'` | Companion pack not installed alongside globally-installed proxy. Fixed in `0.1.1+`. | Upgrade: `npm install -g @strixgov/mcp-proxy@latest`. On older versions, install the pack the same way: `npm install -g @strixgov/capabilities-mcp-common`. |
| Proxy starts, lists tools, but every Notion tool call gets `"decision":"DENY"` even for benign reads | Upstream is the modern `@notionhq/notion-mcp-server` (emits `API-*` tool names), but `@strixgov/capabilities-mcp-common` is at `0.1.0` (only knew the older `notion-*` names). Every call falls through to the heuristic MEDIUM classifier and gets gated. | Upgrade the pack: `npm install -g @strixgov/capabilities-mcp-common@latest` — `0.1.1+` covers both naming conventions (38 Notion tools). |
| Proxy starts cleanly, exposes the tools list, but tool invocations silently fail (no `tools/call` in Claude Desktop logs, no receipt written) | Observed on Windows + nvm: the upstream MCP server can stall when `@modelcontextprotocol/sdk` isn't resolvable from the proxy's working directory. Cause is environmental (npx + nvm + the upstream's peer-dep resolution), not a proxy bug, but the symptom is opaque enough to be worth documenting. | Belt-and-braces: `cd <storagePath dir> && npm install @modelcontextprotocol/sdk`, then full-quit + relaunch Claude Desktop. |
| `npx @strixgov/verifier` prints `KEY_NOT_FOUND` for a local-mode receipt | The proxy generates a local signing key (e.g. `signingKeyId: "strix-notion"`) that's not in the public JWKS at `well-known.strixgov.com`. Local mode is intentionally self-rooted. From v0.1.4+ the public JWK is persisted by default at `~/.strix-mcp-proxy/<serverId>/keys/public-jwk.json`. | Point the verifier at the persisted JWK: `npx @strixgov/verifier chain ~/.strix-mcp-proxy/<serverId>/receipts.jsonl --jwks ~/.strix-mcp-proxy/<serverId>/keys/public-jwk.json`. Receipts written under v0.1.0–v0.1.3 with `storagePath` unset (or aliased to `~/.strix-gateway`) are NOT recoverable — their keys were ephemeral. For JWKS-resolvable kids set `STRIX_API_KEY` + `STRIX_TENANT_ID` (connected mode). |
| `strix-gateway verify` prints `kid not in keyring: strix-<serverId>` for every proxy receipt | You're running `strix-gateway` (gateway CLI) against receipts written by `@strixgov/mcp-proxy`. They are separate stores with incompatible key layouts: the gateway uses a multi-kid keyring (`active` pointer + `<kid>/` subdirs); the proxy writes a flat single-key file. If you also pointed the proxy's `storagePath` at `~/.strix-gateway`, the proxy's key was never registered in the keyring. | Use the package-matched verifier: `npx @strixgov/verifier chain ~/.strix-mcp-proxy/<serverId>/receipts.jsonl --jwks ~/.strix-mcp-proxy/<serverId>/keys/public-jwk.json`. Going forward, leave `storagePath` at its v0.1.4 default (or set it to a path you control that is NOT `~/.strix-gateway`). |
| Proxy starts, exposes tools, allows reads, but every write or otherwise `APPROVAL_REQUIRED`-tier call returns `"decision":"DENY"` with `reason:"PROMPT_FAILED"` even though `approval.enabled` is `true` | The gateway's default approver is `terminalApprove`, which needs a TTY on stdin. Under Claude Desktop spawn the proxy's stdio is owned by the MCP protocol — there's no terminal, so the prompt fails closed. Fixed in `0.1.3+` via `approval.type: "file"` / `"auto"`. | Upgrade: `npm install -g @strixgov/mcp-proxy@latest` and set `"approval": { "enabled": true, "type": "file", "requestDir": "~/.strix-gateway/approvals" }` (real approval, headless) or `"approval": { "enabled": true, "type": "auto" }` (demo only — auto-approves everything). See "Approval modes" above. |

## Security posture

See [`SECURITY.md`](./SECURITY.md) for the security-team-facing
posture, including:

- **Credential boundary** — three deployment positions (proxy holds /
  proxy passes through / proxy never sees the credential) with the
  audit-posture trade-off of each.
- **What the proxy stores** — only signed receipts (with
  `invocationHash`, NOT raw args), the gateway signing key, and
  policy config. Never auth credentials. Never raw tool args.
- **Process model** — what happens on crash / mid-approval / disk
  full. Fail-closed at every boundary; the proxy will not start
  without a loadable signing key.
- **Multi-tenant boundary** — single-tenant by design in v0.1.x;
  run one proxy process per tenant for isolation.
- **What the proxy does NOT govern** — out-of-wrapper traffic, the
  agent's internal state, the upstream's own argument handling
  (SQL/command injection inside the upstream is the upstream's
  responsibility).

Report security issues via GitHub Security Advisory on
`github.com/Strixgov/strix`.

## License

Source-available under the [Elastic License 2.0](./LICENSE).

You may use, modify, and self-host the proxy internally — including
in production — provided you do not offer it as a hosted or managed
service to third parties.

If you run the proxy in a commercial product or want hosted approvals,
connected mode, retention, or compliance evidence packs, email
`sales@strixgov.com`.

The trust primitives the proxy depends on
([`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier),
[`@strixgov/tool-gateway`](https://www.npmjs.com/package/@strixgov/tool-gateway),
[`@strixgov/mcp-token-validator`](https://www.npmjs.com/package/@strixgov/mcp-token-validator))
remain MIT-licensed. Strix is not on the trust path of receipt
verification or token validation — that property is unchanged by
this license boundary.

## Requirements

- Node.js ≥ 18
- An upstream MCP server (stdio transport)
