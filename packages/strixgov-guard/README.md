# @strixgov/guard

**The seatbelt for MCP agents.** One command wraps the MCP servers your
AI agent already uses with Strix execution control: reads pass, writes
block until a human approves, and every action produces a signed,
independently verifiable receipt.

```bash
npx @strixgov/guard init
```

That's the whole install. Guard detects your MCP client config
(Claude Code `./.mcp.json`, Claude Desktop, Cursor), backs it up, and
re-points each server through [`@strixgov/mcp-proxy`](https://www.npmjs.com/package/@strixgov/mcp-proxy)
— the governed proxy that applies policy before the tool call reaches
the real server.

## The five-minute loop

```bash
# 1. Wrap your agent's MCP servers (config is backed up first)
npx @strixgov/guard init

# 2. Restart your MCP client, let the agent work.
#    Reads pass. The first write BLOCKS and waits for you.

# 3. See what's waiting
npx @strixgov/guard pending

# 4. Approve it (or deny it)
npx @strixgov/guard approve <requestId>

# 5. The call runs and mints a signed receipt in ~/.strix-guard/receipts/
```

Want the ping where you actually live? Point approvals at Slack:

```bash
npx @strixgov/guard init --webhook https://hooks.slack.com/services/T…/B…/x…
```

Each blocked call posts a Slack-compatible message with the request id
and the exact approve/deny commands. The decision still happens on your
machine — a lost notification can never approve anything, and never
silently denies a legitimate call (the request just keeps waiting until
you decide or it times out to DENY).

## Defaults (never silent-allow)

| Server | Policy |
|---|---|
| Known servers (Notion, GitHub, Slack, Linear, Postgres, filesystem, email) | Pre-classified capability pack: low-risk reads **ALLOW**, everything else **APPROVAL_REQUIRED** |
| Unknown servers | **APPROVAL_REQUIRED** for every call until classified |

Timeout without a decision → **DENY**. Guard never defaults a write to
silent-allow.

## What Guard writes (and nothing else)

```
~/.strix-guard/
  servers/<id>.json    per-server proxy config (your upstream command moves here verbatim)
  approvals/           request/response files — the decision channel
  receipts/<id>/       Ed25519-signed receipts per server
  state.json           local-only activation timestamps
<your-client-config>.bak-strix-guard-<ts>   backup of the original config
```

**No network telemetry.** Guard sends nothing anywhere except the
approval notifications you explicitly configure with `--webhook`.

## Uninstall

Restore the backup file over your client config and delete
`~/.strix-guard`. Receipts you keep remain verifiable offline.

## License

MIT. The proxy Guard configures (`@strixgov/mcp-proxy`) is Elastic-2.0 —
free to use, source-available.
