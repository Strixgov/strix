# Strix — open-source packages

This repository is the **public release surface** for the open-source
pieces of [Strix](https://www.strixgov.com), an execution-control system
for AI agents. Everything here is MIT-licensed, runs locally, and needs
no Strix account.

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

## Running the test suites

Every package is pure-ESM with no build step and ships its tests:

```bash
# all packages
npm test --workspaces --if-present

# one package
cd packages/strixgov-verifier && npm test
```

## License

MIT. See [LICENSE](LICENSE) and each package's own `LICENSE`.
