/**
 * @strixgov/mcp-credentials — public API.
 *
 * OS-keychain credential store for upstream MCP server tokens.
 * Pairs with @strixgov/mcp-proxy's `upstreamCredentials` config option.
 *
 * Usage (library):
 *
 *   import { setCredential, getCredential, resolveUpstreamCredentials } from '@strixgov/mcp-credentials';
 *
 *   // Store a token once:
 *   await setCredential('notion.token', 'secret_abc123');
 *
 *   // Resolve credentials for a proxy config at startup:
 *   const env = await resolveUpstreamCredentials({
 *     NOTION_API_KEY: { from: 'keychain', key: 'notion.token' },
 *     GITHUB_TOKEN:   { from: 'env',      key: 'GITHUB_TOKEN' },
 *   });
 *   // → { NOTION_API_KEY: '<value from keychain>', GITHUB_TOKEN: '<value from process.env>' }
 *
 * The resolved env object is intended to be merged into `upstream.env` when
 * starting the proxy via `startProxy()`.
 *
 * Failure modes:
 *   - `keytar` unavailable (headless Linux / CI)   → KeychainUnavailableError
 *   - OS keychain denies access (sandbox / policy) → KeychainPermissionError
 *   - Key not found in keychain                     → returns null from getCredential()
 *   - resolveUpstreamCredentials key not found      → CredentialNotFoundError
 */

export {
  setCredential,
  getCredential,
  removeCredential,
  listCredentials,
  isKeychainAvailable,
  KeychainUnavailableError,
  KeychainPermissionError,
} from "./keychain.mjs";

export { resolveUpstreamCredentials, CredentialNotFoundError } from "./resolver.mjs";
