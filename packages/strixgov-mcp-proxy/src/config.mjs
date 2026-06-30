/**
 * Proxy config loader.
 *
 * Config file shape (JSON, no inline comments):
 *
 *   {
 *     "serverId": "notion",
 *     "upstream": {
 *       "command": "npx",
 *       "args": ["-y", "@notionhq/notion-mcp-server"]
 *     },
 *     "capabilities": "@strixgov/capabilities-mcp-common/notion",  // dynamic import path
 *     "policy": {
 *       "riskOverrides": { "LOW": "ALLOW", "MEDIUM": "APPROVAL_REQUIRED", "CRITICAL": "DENY" },
 *       "default": "DENY"
 *     },
 *     "approval": { "enabled": false },
 *     "storagePath": "~/.strix-mcp-proxy/receipts",
 *     "keyPath": "~/.strix-mcp-proxy/my-server/keys"
 *   }
 *
 * `keyPath` (optional): directory for the persistent Ed25519 signing key.
 * When present, the proxy calls loadOrCreateSigningKey({ keyPath }) on startup:
 *   - If the key files don't exist they are generated + written there.
 *   - If they do exist they are loaded.
 * Tilde is expanded the same way as storagePath.
 * Takes precedence over the storagePath-derived key location when both are set.
 *
 * The `capabilities` field is either:
 *   - a bare import path (resolved via dynamic import; must export
 *     a named or default ReadonlyArray<McpCapability>), or
 *   - an inline array (already-classified caller-managed list)
 *
 * No env-var substitution in v0.1.0 — operators that need secrets
 * inject them via `upstream.env` from the surrounding shell rather
 * than embedding them in the config file.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export async function loadConfig(filePath) {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  let raw;
  try {
    raw = await fs.readFile(abs, "utf-8");
  } catch (err) {
    throw new Error(`loadConfig: could not read '${abs}': ${err.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadConfig: '${abs}' is not valid JSON: ${err.message}`);
  }
  validateConfig(cfg, abs);
  if (typeof cfg.storagePath === "string" && cfg.storagePath.startsWith("~")) {
    cfg.storagePath = cfg.storagePath.replace(/^~/, os.homedir());
  }
  if (typeof cfg.keyPath === "string" && cfg.keyPath.startsWith("~")) {
    cfg.keyPath = cfg.keyPath.replace(/^~/, os.homedir());
  }
  return cfg;
}

/**
 * Resolve the `capabilities` field of a config to an actual
 * Array<McpCapability>. Accepts either a bare import path (resolved
 * via dynamic import) or an inline array.
 *
 * @param {string | Array<object> | undefined} capabilities
 * @returns {Promise<Array<object> | undefined>}
 */
export async function resolveCapabilities(capabilities) {
  if (capabilities === undefined || capabilities === null) return undefined;
  if (Array.isArray(capabilities)) return capabilities;
  if (typeof capabilities !== "string") {
    throw new TypeError(
      "resolveCapabilities: 'capabilities' must be a string import path or an array",
    );
  }
  let mod;
  try {
    mod = await import(capabilities);
  } catch (err) {
    // ERR_MODULE_NOT_FOUND is the common case when a globally-installed
    // proxy can't resolve a companion pack that wasn't installed alongside
    // it. Surface an actionable error rather than the bare Node loader
    // message, since "Cannot find package '...'" gives the operator no
    // hint that the fix is `npm install -g <the-package>`.
    if (err && (err.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package/i.test(err.message))) {
      // Best-effort: peel off the subpath so the suggested install
      // command targets the bare package name. "@strixgov/capabilities-mcp-common/notion"
      // → "@strixgov/capabilities-mcp-common".
      const bare = capabilities.startsWith("@")
        ? capabilities.split("/").slice(0, 2).join("/")
        : capabilities.split("/")[0];
      throw new Error(
        `resolveCapabilities: cannot load capability pack '${capabilities}'. ` +
          `If you installed @strixgov/mcp-proxy globally, install the pack the same way: ` +
          `\`npm install -g ${bare}\`. ` +
          `Otherwise add '${bare}' to your project's dependencies. ` +
          `(underlying error: ${err.message})`,
      );
    }
    throw err;
  }
  // Look for the conventional name (foo → fooCapabilities, *Capabilities,
  // default, or the first exported array). The companion packs use the
  // `<server>Capabilities` convention, so check that first.
  const exportedArrays = Object.entries(mod).filter(([, v]) => Array.isArray(v));
  const conventional = exportedArrays.find(([k]) => k.endsWith("Capabilities"));
  if (conventional) return conventional[1];
  if (Array.isArray(mod.default)) return mod.default;
  if (exportedArrays.length === 1) return exportedArrays[0][1];
  throw new Error(
    `resolveCapabilities: module '${capabilities}' does not export a recognisable capability array ` +
      `(expected a *Capabilities export, a default export, or a single array export)`,
  );
}

// ─── internal ─────────────────────────────────────────────────────────

function validateConfig(cfg, abs) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error(`loadConfig: '${abs}' must be a JSON object`);
  }
  if (!cfg.upstream || typeof cfg.upstream !== "object") {
    throw new Error(`loadConfig: '${abs}' is missing 'upstream' object`);
  }
  if (typeof cfg.upstream.command !== "string" || !cfg.upstream.command) {
    throw new Error(`loadConfig: '${abs}' is missing 'upstream.command' string`);
  }
  if (cfg.upstream.args !== undefined && !Array.isArray(cfg.upstream.args)) {
    throw new Error(`loadConfig: '${abs}' 'upstream.args' must be an array of strings if present`);
  }
  if (cfg.policy !== undefined && (typeof cfg.policy !== "object" || cfg.policy === null)) {
    throw new Error(`loadConfig: '${abs}' 'policy' must be an object if present`);
  }
  if (cfg.keyPath !== undefined && typeof cfg.keyPath !== "string") {
    throw new Error(`loadConfig: '${abs}' 'keyPath' must be a string if present`);
  }
  if (cfg.upstreamCredentials !== undefined) {
    if (
      typeof cfg.upstreamCredentials !== "object" ||
      cfg.upstreamCredentials === null ||
      Array.isArray(cfg.upstreamCredentials)
    ) {
      throw new Error(
        `loadConfig: '${abs}' 'upstreamCredentials' must be an object if present`,
      );
    }
    for (const [envKey, spec] of Object.entries(cfg.upstreamCredentials)) {
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error(
          `loadConfig: '${abs}' 'upstreamCredentials["${envKey}"]' must be a spec object with a "from" field`,
        );
      }
      if (spec.from !== "keychain" && spec.from !== "env") {
        throw new Error(
          `loadConfig: '${abs}' 'upstreamCredentials["${envKey}"].from' must be "keychain" or "env"`,
        );
      }
      if (typeof spec.key !== "string" || !spec.key) {
        throw new Error(
          `loadConfig: '${abs}' 'upstreamCredentials["${envKey}"].key' must be a non-empty string`,
        );
      }
    }
  }
}
