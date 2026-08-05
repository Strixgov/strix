# Strix — open-source packages

This repository is the **public release surface** for the open-source
pieces of [Strix](https://www.strixgov.com), an execution-control system
for AI agents. Everything here runs locally and needs no Strix account.
The trust primitives — the verifier, the tool-gateway, and the capability
packs — are **MIT-licensed**; the one MCP runtime adapter
(`@strixgov/mcp-adapter`) is source-available under **Elastic License 2.0**
(free to use, not to resell as a competing managed service). See
[LICENSING_BOUNDARY.md](LICENSING_BOUNDARY.md).

It is a mirror, not the source of truth — the canonical code lives
upstream in the Strix monorepo and synchronizes here at release time.
See [MIRROR.md](MIRROR.md) for the model and [CONTRIBUTING.md](CONTRIBUTING.md)
for how changes flow.

## Packages

| Package | What it is | npm |
|---|---|---|
| [`@strixgov/verifier`](packages/strixgov-verifier/) | Offline verifier for Ed25519-signed Strix evidence + receipts. Zero runtime deps; `node:crypto` + `fetch` only. The cryptographic primitive everything else is checked against. | [`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier) |
| [`@strixgov/tool-gateway`](packages/tool-gateway/) | Governed tool execution for AI agents at the action boundary: classify → evaluate → allow / deny / hold, with an Ed25519-signed append-only receipt for every decision. Local-first. | [`@strixgov/tool-gateway`](https://www.npmjs.com/package/@strixgov/tool-gateway) |
| [`@strixgov/capabilities-claude-code`](packages/strixgov-capabilities-claude-code/) | Pre-classified capability registry for Claude Code's built-in tools. Drop-in starter for the tool-gateway. | [`@strixgov/capabilities-claude-code`](https://www.npmjs.com/package/@strixgov/capabilities-claude-code) |
| [`@strixgov/capabilities-mcp-common`](packages/strixgov-capabilities-mcp-common/) | Pre-classified capability registry for popular MCP servers (Slack, GitHub, Linear, Notion, Filesystem, Postgres, Email). Drop-in starter for the tool-gateway. | [`@strixgov/capabilities-mcp-common`](https://www.npmjs.com/package/@strixgov/capabilities-mcp-common) |
| [`@strixgov/mcp-adapter`](packages/strixgov-mcp-adapter/) | One-call governance wrapper for any MCP server. Wraps every `callTool` with policy evaluation, signed execution receipts, and an optional approval gate — five-line integration, no changes to your tool implementations. `npx @strixgov/mcp-adapter demo` shows the full round-trip in under 20 seconds. | [`@strixgov/mcp-adapter`](https://www.npmjs.com/package/@strixgov/mcp-adapter) |
| [`@strixgov/mcp-proxy`](packages/strixgov-mcp-proxy/) | Standalone governed proxy that wraps any stdio MCP server — no code change to the server. Persistent signing key, configurable approval gate, and a signed receipt per tool call. | [`@strixgov/mcp-proxy`](https://www.npmjs.com/package/@strixgov/mcp-proxy) |
| [`@strixgov/sdk`](packages/governance-sdk/) | The open proof surface: verifiers and signers for the signed-evidence schemas (SE v1, MC-1, AC-1, AA-1, swarm, proof bundles) plus JWKS resolution. Verification helpers only — policy decisions and token minting stay in the control plane. | [`@strixgov/sdk`](https://www.npmjs.com/package/@strixgov/sdk) |
| [`@strixgov/governed-action`](packages/strixgov-governed-action/) | `governedAction()` wraps any async function and `governedFetch()` wraps an HTTP call, so an arbitrary REST mutation becomes a governed action with an `npm install`-and-go path. Canonicalization is imported from `@strixgov/sdk`, never re-implemented. | [`@strixgov/governed-action`](https://www.npmjs.com/package/@strixgov/governed-action) |
| [`@strixgov/swarm-adapter`](packages/strixgov-swarm-adapter/) | Governance binding for in-process orchestration frameworks (LangGraph first): a signed `delegate()` and a `governedTool()` that routes through the real swarm boundary. Imports nothing from LangChain. | [`@strixgov/swarm-adapter`](https://www.npmjs.com/package/@strixgov/swarm-adapter) |
| [`@strixgov/guard`](packages/strixgov-guard/) | The seatbelt for MCP agents — one command wraps your MCP servers with Strix governance: writes require human approval, reads pass, and every action produces a signed receipt. | [`@strixgov/guard`](https://www.npmjs.com/package/@strixgov/guard) |
| [`@strixgov/mcp-token-validator`](packages/strixgov-mcp-token-validator/) | Independent validator for Strix `execution_authorization_v1` tokens. Drop into your own MCP server, proxy, or credential broker to enforce capability-scoped governance — no Strix runtime dependency, no network calls, Ed25519 against your trusted JWKS using only `node:crypto`. | [`@strixgov/mcp-token-validator`](https://www.npmjs.com/package/@strixgov/mcp-token-validator) |
| [`@strixgov/rcm-reference`](packages/strixgov-rcm-reference/) | Canonical governed-agent **reference architecture** for healthcare revenue-cycle management. The same prior-auth agent runs the same task ungoverned vs. governed across six real-world failure modes, on a real X12 278 surface, synthetic patients only. Dependency-free ESM; `node --test`, no install. | [`@strixgov/rcm-reference`](https://www.npmjs.com/package/@strixgov/rcm-reference) |

### Source-available here, not yet on npm

These ship their full source and tests in this repo so they can be read and
run, but they are **not published to the npm registry** — `npm install` will
not resolve them yet. Listed so the set is complete rather than flattering.

| Package | What it is |
|---|---|
| [`@strixgov/claude-code`](packages/strixgov-claude-code/) | Claude Code Governance Pack. `npx @strixgov/claude-code init` adds a PreToolUse hook that governs the tool-execution surfaces Claude Code exposes and emits signed decision receipts — no fork, no workflow change. |
| [`@strixgov/verify-embed`](packages/strixgov-verify-embed/) | One-line `<strix-verify>` web component — a browser WebCrypto SE v1 verifier. One of three independent SE v1 implementations held in conformance against a shared golden-vector corpus. |
| [`@strixgov/visual-receipts`](packages/visual-receipts/) | Human-readable projection of a verification result. Renders **from** signed evidence after verification; never the source of truth. |
| [`@strixgov/trust-mark-embed`](packages/strixgov-trust-mark-embed/) | One-line `<strix-trust-mark>` web component rendering the four-state Consumer Trust Mark (TM-1) from a licensee's public status surface. Render-only — re-derive independently with `npx @strixgov/verifier trustmark`. |
| [`@strixgov/capabilities-odysseus`](packages/strixgov-capabilities-odysseus/) | Pre-classified capability registry for the Odysseus self-hosted AI workspace (shell, files, email, web, scheduler, memory, secrets, MCP passthrough). |
| [`@strixgov/mcp-credentials`](packages/strixgov-mcp-credentials/) | OS-keychain credential store for upstream MCP server tokens. Store once, never re-paste. |
| [`@strixgov/healthcare-demo`](packages/strixgov-healthcare-demo/) | Healthcare governance demo surface. Synthetic data only. |

Each package is self-contained under `packages/<name>/`, at the exact
path its published `package.json` declares in `repository.directory`, so
the "Repository" link on every npm page resolves here.

## How they fit together

```
        AI agent (Claude Code, Cursor, MCP client, autonomous coder)
                              │
                  @strixgov/tool-gateway          ← classify + evaluate + sign
              (+ capabilities-* registries)         every tool call
                              │
                         Tool / MCP server
                              │
                  Ed25519-signed receipt  ──────► @strixgov/verifier
                                                   (anyone, offline, no account)
```

The tool-gateway produces receipts; the verifier proves them. The two
capability packs are starter risk classifications you hand to the
gateway. The verifier is also what proves Strix's hosted governance
evidence — the same primitive, whether the record came from the local
gateway or the platform.

## Quick start

```bash
# Verify a Strix-governed record offline (no install needed)
npx @strixgov/verifier@latest <evidenceId>

# Govern an agent's tool calls locally
npm install @strixgov/tool-gateway
npx strix-gateway init
```

See each package's own README for the full story.

## Verify in Claude Code (plugin)

A Claude Code plugin wraps the same verifier as a `/strix-verify` slash
command, an MCP server, and an opt-in stop hook — so you can verify a
Strix-governed record from inside a session. It vendors
`@strixgov/verifier`, so it launches offline; Strix is never on the trust
path, and nothing in the plugin decides a verdict (it shells out to the
verifier and relays its exit code).

```
/plugin marketplace add Strixgov/strix
/plugin install strix-verifier@strixgov
/strix-verify 5686
```

The marketplace manifest is at this repo's root
(`.claude-plugin/marketplace.json`) and the plugin lives at
[`plugins/strix-verifier/`](plugins/strix-verifier/). Live verification
fetches the proof record + JWKS from `www.strixgov.com`; see the
[plugin README](plugins/strix-verifier/) for fully-offline and
restricted-environment (egress-blocked) options.

## Marketing assets

Public-source bundles for the launch material that demonstrates these
packages. Pure static HTML + JSX + media — no build step, MIT-licensed,
clone-and-host.

| Bundle | What it is |
|---|---|
| [`marketing/mcp-tool-gateway/`](marketing/mcp-tool-gateway/) | 55-second branded video that wraps the `@strixgov/tool-gateway` CLI walkthrough (init, capabilities, allow, deny, receipts, chain) with six animated scenes. ~13 MB. |
| [`marketing/enforcement-story/`](marketing/enforcement-story/) | Scroll-driven 2-act story page: clinical-data submission (allowed + signed) and adversarial prompt (denied + audited). Shows the same kernel evaluating both. Pure static HTML/CSS/JS, no build step. |

See [MIRROR.md](MIRROR.md#repo-root) for how the marketing surface relates to upstream.

## Running the test suites

Every package is pure-ESM with no build step and ships its tests:

```bash
# all packages
npm test --workspaces --if-present

# one package
cd packages/strixgov-verifier && npm test
```

## License

Two-tier, and frozen in CI (`scripts/lint-license-parity.mjs`). The open
trust primitives — `@strixgov/verifier`, `@strixgov/tool-gateway`, and the
two `@strixgov/capabilities-*` packs — are **MIT**; the MCP runtime adapter
`@strixgov/mcp-adapter` is **Elastic License 2.0** (source-available; free
to use, not to resell as a competing managed service). The repository root
is MIT. Each package declares its own license — see [LICENSE](LICENSE), each
package's own `LICENSE`, and [LICENSING_BOUNDARY.md](LICENSING_BOUNDARY.md).
