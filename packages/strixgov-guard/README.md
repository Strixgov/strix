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
# 1. Wrap your agent's MCP servers (config is backed up first).
#    The first run creates your approver key: you type a passphrase (12+ characters).
npx @strixgov/guard init

# 2. Restart your MCP client, let the agent work.
#    Reads pass. The first write BLOCKS and waits for you.

# 3. See what's waiting
npx @strixgov/guard pending

# 4. Approve it (shows the request, asks "yes", asks your passphrase) or deny it
npx @strixgov/guard approve <requestId>
npx @strixgov/guard deny <requestId>

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

## What Guard covers — and what it does not

Guard governs calls that pass **through its proxy**, i.e. the servers in
the client configs it wrapped. It does not stop a client that launches
the same MCP server directly (another config, another client), and it
does not control direct APIs or other credentials to the same resource.
Installing the proxy is not the same as covering every route.

After `init`, Guard runs a read-only **coverage audit** of the client
configs it knows about (`./.mcp.json`, Claude Desktop, `~/.cursor/mcp.json`,
`./.cursor/mcp.json`) and warns about any server still launched directly:

```bash
npx @strixgov/guard coverage [--audit-config <path>]... [--json] [--strict]
```

The audit always includes the config `init` just wrapped, even outside the
known locations. Guard cannot discover siblings it is not told about: if you
wrapped a config in some other location, name the others with
`--audit-config <path>` (repeatable on `init` and `coverage`).

- `COVERAGE_INCOMPLETE` — a direct or unknown route was found. Guard does
  not modify other configs; re-run `init --config <path>` to wrap them.
- `COVERAGE_SCOPE_LIMITED` — nothing direct was found, but coverage is
  **not established**: the wrapped config is outside the known locations
  and no sibling was named, or no config could be read. `--strict` exits 2.
- `COVERAGE_ESTABLISHED_FOR_KNOWN_CONFIGS` — nothing direct was found in
  the places Guard looked. **This is not proof of complete protection.**
- Unreadable or unparseable configs are reported as not established,
  never as covered. The report is saved to `~/.strix-guard/coverage.json`.

An entry counts as covered only when it launches the proxy with a `--config`
file that Guard can read and that names an upstream. An entry that merely
mentions the proxy, or points at a missing proxy config, is reported as
direct or not established.

## Who can approve

**Approvals are signed by default (since 0.2.0).** `init` needs an approver
key; in a terminal it creates one if you have none, otherwise run:

```bash
npx @strixgov/guard approver init   # passphrase typed in a terminal, 12+ characters
npx @strixgov/guard init            # also upgrades servers you wrapped with an older Guard:
                                    # re-points them at the pinned proxy and requires signatures
# restart your MCP client
npx @strixgov/guard approve <requestId>   # shows the request, asks "yes", asks the passphrase
```

The proxy refuses any approval that is not signed by your approver key,
over the exact request you were shown. An unsigned response, a response signed
by another key, a signature copied from a different request, a stale one, or a
flipped decision are all refused. The approver name in the receipt comes from
the verified key, not from the file. Denials are never signed: a forged denial
can only deny.

What it still does not do: the trusted public key lives in
`~/.strix-guard/servers/<id>.json`, so a process that can edit those files and
restart the proxy can swap it, and a weak passphrase can be guessed offline
against `~/.strix-guard/approver/key.enc.json` (scrypt plus AES-256-GCM). It
raises the bar from "write one file" to "tamper with Guard's configuration or
know your passphrase". If the agent can run arbitrary commands as your user and
you need to rely on approval, run it as a different OS user or in a container.
A forgotten passphrase cannot be recovered; create a new key with `--force` and
re-run `init`. `coverage --json` shows, per proxied server, whether approvals are
`SIGNED` or `UNAUTHENTICATED_FILE`.

**Unsigned approvals (explicit opt-out).** `init --unsigned-approvals` writes
proxy configs that accept plain response files in `~/.strix-guard/approvals/`.
**Any process running as your OS user can write that response**, including an
agent with shell or file-write access, and Guard does not check who wrote it:
the approver name in the receipt is whatever the file says. Use it only where
the agent cannot write to that directory, for example in a short trial.

Stronger assurance requires that the agent never holds the protected
resource's credentials and that the resource itself authorizes only the
governed path. Guard is a developer-side control, not that boundary.

## What Guard writes (and nothing else)

```
~/.strix-guard/
  servers/<id>.json    per-server proxy config (your upstream command moves here verbatim)
  approvals/           request/response files — the decision channel
  receipts/<id>/       Ed25519-signed receipts per server
  approver/            your approver key (private half encrypted under your passphrase)
  state.json           local-only activation timestamps
  coverage.json        latest coverage-audit report
  backups/             backup of each client config before it was rewritten (mode 600;
                       it contains your original config, secrets included)
```

Generated client entries launch a pinned `@strixgov/mcp-proxy` version
(0.2.4), and that proxy pins its Strix dependencies (tool-gateway, mcp-adapter,
capabilities-mcp-common) exactly, so a new Strix release does not change what an
existing install runs. Third-party dependencies, such as the MCP SDK, still
resolve within their declared ranges when `npx` installs the proxy.

On Windows the entry is `cmd /c npx -y @strixgov/mcp-proxy@<version> --config …`,
because MCP clients start commands without a shell and Node cannot start the
`npx.cmd` shim that way. Requires Node 20 or later.

**No network telemetry.** Guard sends nothing anywhere except the
approval notifications you explicitly configure with `--webhook`.

## Uninstall

```bash
npx @strixgov/guard uninstall [--config <path>] [--dry-run]
```

Restores each wrapped server's original command, args and env from its Guard
proxy config, keeps any other edits you made to the client config, and backs the
config up first. Restart your MCP client afterwards. `~/.strix-guard` is kept so
your receipts stay verifiable offline; delete it yourself when you no longer need
them. A full copy of the client config as it was before `init` is also in
`~/.strix-guard/backups/`.

## License

MIT. The proxy Guard configures (`@strixgov/mcp-proxy`) is Elastic-2.0 —
free to use, source-available.
