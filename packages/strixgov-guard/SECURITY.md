# Security posture — `@strixgov/guard`

Guard writes configuration and runs the human side of the approval loop. The
enforcement point is [`@strixgov/mcp-proxy`](https://www.npmjs.com/package/@strixgov/mcp-proxy),
which Guard configures; its own posture is in that package's `SECURITY.md`.

Report a vulnerability to **security@strixgov.com**. Please do not open a public
issue for an unfixed vulnerability.

## What Guard writes, and who can read it

Everything lives under `~/.strix-guard` (or `STRIX_GUARD_HOME`). Directories are
created owner-only (0700) and files owner-only (0600) on systems that honour
POSIX modes. Windows does not apply those modes; there, the files inherit the
ACLs of your user profile.

| Path | Contents | Sensitive |
|---|---|---|
| `servers/<id>.json` | the upstream command, args and **env** moved verbatim from your client config, plus the approval policy and the trusted approver public key | yes: any secrets in the upstream env |
| `backups/` | the client config as it was before `init` / `uninstall` | yes: same secrets |
| `approver/key.enc.json` | the approver private key, encrypted (scrypt + AES-256-GCM) under your passphrase | yes, if the passphrase is weak |
| `approvals/` | pending request and response files | arguments of pending tool calls |
| `receipts/<id>/` | Ed25519-signed receipts and the proxy's signing key | the signing key |
| `state.json`, `coverage.json` | local activation timestamps, the latest coverage audit | no |

Guard makes no network calls except the approval notifications you configure
with `--webhook`. It sends no telemetry.

## What the approval gate protects against

With signed approvals (the default since 0.2.0), a write proceeds only when the
response is signed by your approver key over the exact request bytes you were
shown, within ten minutes. An agent that can write files as your user cannot
forge that approval by writing a response file; the proxy records the refusal
as `APPROVAL_UNSIGNED`.

It does **not** protect against:

- a process that can edit `~/.strix-guard/servers/*.json` (and restart the proxy),
  which can replace the trusted public key or turn signing off;
- an offline guess of a weak passphrase against `approver/key.enc.json`;
- a client or script that starts the MCP server directly, or uses the same
  credentials outside MCP. Guard governs only calls that pass through the proxy;
  `strix-guard coverage` reports direct routes in the configs it knows about and
  cannot see others;
- an agent with arbitrary command execution as your user. For that, run the
  agent as a different OS user or in a container that cannot reach
  `~/.strix-guard`.

With `--unsigned-approvals`, any process running as your user can approve by
writing a file, and the recorded approver name is whatever that file says.

## Supply chain

Generated client entries run `npx -y @strixgov/mcp-proxy@<pinned version>`. That
proxy pins its Strix dependencies exactly (from 0.2.4). Third-party dependencies,
such as `@modelcontextprotocol/sdk`, resolve within their declared ranges when
`npx` installs the proxy.
