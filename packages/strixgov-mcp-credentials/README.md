# @strixgov/mcp-credentials

OS-keychain credential store for upstream MCP server tokens. Store once, never re-paste.

Pairs with [`@strixgov/mcp-proxy`](https://www.npmjs.com/package/@strixgov/mcp-proxy) to feed secrets from the OS keychain into the upstream MCP server's environment at proxy startup — keeping tokens out of config files, shell history, and process listings.

## Installation

```bash
npm install -g @strixgov/mcp-credentials
# or alongside the proxy:
npm install @strixgov/mcp-credentials @strixgov/mcp-proxy
```

The optional [`keytar`](https://www.npmjs.com/package/keytar) dependency provides native keychain access:

| Platform | Backend |
|----------|---------|
| macOS    | Keychain |
| Windows  | Credential Manager |
| Linux    | libsecret / Secret Service (GNOME Keyring or KWallet) |

When `keytar` is not installed, the package falls back to matching environment variables with a console warning.

## CLI

```bash
# Store a token (prompted, no echo)
strix-mcp-credentials set notion.token

# Retrieve a stored token (prints to stdout)
strix-mcp-credentials get notion.token

# List all stored keys
strix-mcp-credentials list

# Delete a token
strix-mcp-credentials remove notion.token
```

The key name is a logical identifier (e.g. `notion.token`, `github.token`). It maps to the keychain account under the `strix-mcp` service namespace.

### Piped input

```bash
# Pipe the value non-interactively (useful in scripts)
echo "$NOTION_TOKEN" | strix-mcp-credentials set notion.token
```

## Proxy integration

Add an `upstreamCredentials` field to your proxy config or call `startProxy()` with it programmatically:

### Config file (`strix-proxy.json`)

```json
{
  "serverId": "notion",
  "upstream": {
    "command": "npx",
    "args": ["-y", "@notionhq/notion-mcp-server"]
  },
  "upstreamCredentials": {
    "NOTION_API_KEY": { "from": "keychain", "key": "notion.token" }
  },
  "capabilities": "@strixgov/capabilities-mcp-common/notion",
  "policy": { "default": "DENY" }
}
```

### Programmatic

```javascript
import { startProxy } from '@strixgov/mcp-proxy';

await startProxy({
  serverId: 'notion',
  upstream: {
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
  },
  upstreamCredentials: {
    NOTION_API_KEY: { from: 'keychain', key: 'notion.token' },
    GITHUB_TOKEN:   { from: 'env',      key: 'GITHUB_TOKEN' },
  },
});
```

The proxy fetches each credential at startup and injects it into the upstream process's environment before spawning it.

## Library API

```javascript
import {
  setCredential,
  getCredential,
  removeCredential,
  listCredentials,
  isKeychainAvailable,
  resolveUpstreamCredentials,
} from '@strixgov/mcp-credentials';

// Store
await setCredential('notion.token', 'secret_abc123');

// Retrieve
const token = await getCredential('notion.token'); // → 'secret_abc123' | null

// Resolve a credential map → env object
const env = await resolveUpstreamCredentials({
  NOTION_API_KEY: { from: 'keychain', key: 'notion.token' },
  GITHUB_TOKEN:   { from: 'env',      key: 'GITHUB_TOKEN' },
});
// → { NOTION_API_KEY: 'secret_abc123', GITHUB_TOKEN: '<value from process.env>' }
```

### `resolveUpstreamCredentials(credentialMap)`

Resolves a map of env-var names → source specs. Returns a plain object suitable for spreading into `upstream.env`.

**Credential spec:**

| Field | Required | Description |
|-------|----------|-------------|
| `from` | yes | `"keychain"` or `"env"` |
| `key` | yes | Keychain account name or env-var name to read from |
| `fallbackKeychain` | no | For `from: "env"` — keychain key to try if the env var is unset |
| `optional` | no | When `true`, silently omit the env var instead of throwing when not found |

**`from: "keychain"` fallback behavior:**

When `keytar` is unavailable, the resolver logs a warning and falls back to `process.env[envKey]` (the same name as the target env var). If that environment variable is also absent and `optional` is not set, `KeychainUnavailableError` is thrown.

## Error classes

| Class | code | Thrown when |
|-------|------|-------------|
| `KeychainUnavailableError` | `KEYCHAIN_UNAVAILABLE` | `keytar` is not installed / failed to load |
| `KeychainPermissionError` | `KEYCHAIN_PERMISSION_DENIED` | The OS denied access to the keychain |
| `CredentialNotFoundError` | `CREDENTIAL_NOT_FOUND` | A required credential was not found in any declared source |

## Requirements

- Node.js ≥ 18
- `keytar` (optional peer dependency) — install alongside this package for native keychain access

## License

MIT
