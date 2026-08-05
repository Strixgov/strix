/**
 * @strixgov/mcp-credentials — TypeScript declarations.
 */

export class KeychainUnavailableError extends Error {
  readonly name: "KeychainUnavailableError";
  readonly code: "KEYCHAIN_UNAVAILABLE";
  constructor(reason: string);
}

export class KeychainPermissionError extends Error {
  readonly name: "KeychainPermissionError";
  readonly code: "KEYCHAIN_PERMISSION_DENIED";
  constructor(key: string, cause?: unknown);
}

export class CredentialNotFoundError extends Error {
  readonly name: "CredentialNotFoundError";
  readonly code: "CREDENTIAL_NOT_FOUND";
  readonly envKey: string;
  readonly spec: CredentialSpec;
  constructor(envKey: string, spec: CredentialSpec);
}

/**
 * Source spec for a single upstream credential.
 *
 * `from: "keychain"` — read from the OS keychain under `key`.
 *   When the keychain is unavailable, falls back to `process.env[envKey]`
 *   with a console warning; throws `KeychainUnavailableError` if both are absent.
 *
 * `from: "env"` — read from `process.env[key]`.
 *   When unset, optionally falls back to the OS keychain at `fallbackKeychain`.
 *
 * `optional: true` — silently omit the env var from the result rather than
 *   throwing when the value is not found.
 */
export type CredentialSpec =
  | {
      from: "keychain";
      key: string;
      optional?: boolean;
    }
  | {
      from: "env";
      key: string;
      fallbackKeychain?: string;
      optional?: boolean;
    };

/**
 * Store a credential in the OS keychain.
 *
 * @param key  Logical credential name (e.g. "notion.token")
 * @param value  The secret value — never logged
 * @throws {KeychainUnavailableError} if keytar is not available
 * @throws {KeychainPermissionError} if the OS keychain denies access
 */
export function setCredential(key: string, value: string): Promise<void>;

/**
 * Retrieve a credential from the OS keychain.
 *
 * @param key  Logical credential name
 * @returns The stored value, or null if not found
 * @throws {KeychainUnavailableError} if keytar is not available
 * @throws {KeychainPermissionError} if the OS keychain denies access
 */
export function getCredential(key: string): Promise<string | null>;

/**
 * Delete a credential from the OS keychain.
 *
 * @param key  Logical credential name
 * @returns true if deleted, false if the key was not found
 * @throws {KeychainUnavailableError} if keytar is not available
 * @throws {KeychainPermissionError} if the OS keychain denies access
 */
export function removeCredential(key: string): Promise<boolean>;

/**
 * List all credential keys stored under the "strix-mcp" service.
 * Returns key names only — never values.
 *
 * @throws {KeychainUnavailableError} if keytar is not available
 * @throws {KeychainPermissionError} if the OS keychain denies access
 */
export function listCredentials(): Promise<string[]>;

/**
 * Returns true when keytar is installed and loadable; false otherwise.
 * Use this to check availability before attempting keychain operations
 * in environments where a fallback is acceptable.
 */
export function isKeychainAvailable(): Promise<boolean>;

/**
 * Resolve a credential map to concrete env-var values.
 *
 * Takes a map of env-var names → source specs and returns a plain object
 * with the resolved values, suitable for spreading into `upstream.env`
 * when starting the proxy.
 *
 * @param credentialMap  Keys are env-var names; values are source specs
 * @returns Plain object ready to spread into `upstream.env`
 * @throws {CredentialNotFoundError} if a required credential is not found
 * @throws {KeychainUnavailableError} if the keychain is needed but unavailable
 * @throws {TypeError} if a spec is malformed
 */
export function resolveUpstreamCredentials(
  credentialMap: Record<string, CredentialSpec>,
): Promise<Record<string, string>>;
