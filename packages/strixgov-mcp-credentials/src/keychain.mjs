/**
 * OS-native keychain adapter.
 *
 * Uses `keytar` (optional dep) to read/write/delete entries in:
 *   - macOS  → Keychain
 *   - Windows → Credential Manager
 *   - Linux  → libsecret / Secret Service (requires gnome-keyring or KWallet)
 *
 * When `keytar` is unavailable (headless Linux, CI, corp sandbox) every
 * operation throws a `KeychainUnavailableError` so callers can fall back
 * explicitly rather than silently.
 *
 * Key naming: strix-mcp-credentials uses the keytar service/account model:
 *   service  = "strix-mcp"
 *   account  = the logical key name (e.g. "notion.token", "github.token")
 *
 * This is an internal module. Public API is src/index.mjs.
 */

export class KeychainUnavailableError extends Error {
  constructor(reason) {
    super(
      `OS keychain is unavailable: ${reason}. ` +
        "Fall back to an environment variable (e.g. NOTION_API_KEY) " +
        "and set it in your MCP client's env config.",
    );
    this.name = "KeychainUnavailableError";
    this.code = "KEYCHAIN_UNAVAILABLE";
  }
}

export class KeychainPermissionError extends Error {
  constructor(key, cause) {
    super(
      `OS keychain access denied for key "${key}". ` +
        "Check system keychain permissions (macOS: Keychain Access.app → " +
        "strix-mcp entry → Access Control; Windows: Credential Manager; " +
        `Linux: org.freedesktop.Secret.Service policy). Cause: ${cause?.message ?? cause}`,
    );
    this.name = "KeychainPermissionError";
    this.code = "KEYCHAIN_PERMISSION_DENIED";
  }
}

const SERVICE = "strix-mcp";

let _keytar = null;
let _keytarAttempted = false;

async function loadKeytar() {
  if (_keytarAttempted) return _keytar;
  _keytarAttempted = true;
  try {
    const mod = await import("keytar");
    _keytar = mod.default ?? mod;
    return _keytar;
  } catch {
    _keytar = null;
    return null;
  }
}

function assertKeytar(kt) {
  if (!kt) {
    throw new KeychainUnavailableError(
      "keytar package is not installed or failed to load. " +
        "Install it: npm install -g keytar  (or add it as a dep alongside @strixgov/mcp-credentials)",
    );
  }
}

/**
 * Store a credential in the OS keychain.
 *
 * @param {string} key  Logical credential name (e.g. "notion.token")
 * @param {string} value  The secret value. Never logged.
 * @throws {KeychainUnavailableError} if keytar is not available
 * @throws {KeychainPermissionError} if the OS keychain denies access
 */
export async function setCredential(key, value) {
  const kt = await loadKeytar();
  assertKeytar(kt);
  try {
    await kt.setPassword(SERVICE, key, value);
  } catch (err) {
    if (isPermissionError(err)) throw new KeychainPermissionError(key, err);
    throw err;
  }
}

/**
 * Retrieve a credential from the OS keychain.
 *
 * @param {string} key  Logical credential name
 * @returns {Promise<string | null>}  The stored value, or null if not found
 * @throws {KeychainUnavailableError} if keytar is not available
 * @throws {KeychainPermissionError} if the OS keychain denies access
 */
export async function getCredential(key) {
  const kt = await loadKeytar();
  assertKeytar(kt);
  try {
    return await kt.getPassword(SERVICE, key);
  } catch (err) {
    if (isPermissionError(err)) throw new KeychainPermissionError(key, err);
    throw err;
  }
}

/**
 * Delete a credential from the OS keychain.
 *
 * @param {string} key  Logical credential name
 * @returns {Promise<boolean>}  true if deleted, false if key was not found
 * @throws {KeychainUnavailableError} if keytar is not available
 * @throws {KeychainPermissionError} if the OS keychain denies access
 */
export async function removeCredential(key) {
  const kt = await loadKeytar();
  assertKeytar(kt);
  try {
    return await kt.deletePassword(SERVICE, key);
  } catch (err) {
    if (isPermissionError(err)) throw new KeychainPermissionError(key, err);
    throw err;
  }
}

/**
 * List all credential keys stored under the "strix-mcp" service.
 * Returns key names only — never values.
 *
 * @returns {Promise<string[]>}
 * @throws {KeychainUnavailableError} if keytar is not available
 * @throws {KeychainPermissionError} if the OS keychain denies access
 */
export async function listCredentials() {
  const kt = await loadKeytar();
  assertKeytar(kt);
  try {
    const entries = await kt.findCredentials(SERVICE);
    return entries.map((e) => e.account).sort();
  } catch (err) {
    if (isPermissionError(err)) throw new KeychainPermissionError("(list)", err);
    throw err;
  }
}

/**
 * Returns true when keytar is installed and loadable; false otherwise.
 * Use this to check availability before attempting keychain operations
 * in environments where fallback is acceptable.
 *
 * @returns {Promise<boolean>}
 */
export async function isKeychainAvailable() {
  const kt = await loadKeytar();
  return kt !== null;
}

// Heuristic: classify OS-level "access denied" errors so callers get a
// KeychainPermissionError rather than a raw OS error object.
function isPermissionError(err) {
  const msg = err?.message?.toLowerCase() ?? "";
  return (
    msg.includes("access denied") ||
    msg.includes("permission denied") ||
    msg.includes("user denied") ||
    msg.includes("cancelled") ||
    msg.includes("user canceled")
  );
}
