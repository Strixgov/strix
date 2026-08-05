/**
 * Upstream credential resolver.
 *
 * Takes a credential map (env-var-name → source spec) and returns a plain
 * object with the resolved values, suitable for spreading into `upstream.env`
 * when starting the proxy.
 *
 * Supported source specs:
 *
 *   { from: "keychain", key: "notion.token" }
 *     → load from OS keychain under the logical key "notion.token"
 *
 *   { from: "env", key: "NOTION_API_KEY" }
 *     → load from process.env["NOTION_API_KEY"]
 *
 *   { from: "env", key: "NOTION_API_KEY", fallbackKeychain: "notion.token" }
 *     → try process.env first; if unset, fall back to the keychain
 *
 * A missing / null value throws CredentialNotFoundError unless the entry
 * has `optional: true`, in which case the env var is omitted from the result.
 */

import {
  getCredential,
  isKeychainAvailable,
  KeychainUnavailableError,
} from "./keychain.mjs";

export class CredentialNotFoundError extends Error {
  constructor(envKey, spec) {
    const location =
      spec.from === "keychain"
        ? `keychain key "${spec.key}"`
        : `process.env["${spec.key}"]`;
    super(
      `Credential for "${envKey}" not found in ${location}. ` +
        `Run: strix-mcp-credentials set ${spec.from === "keychain" ? spec.key : spec.key}`,
    );
    this.name = "CredentialNotFoundError";
    this.code = "CREDENTIAL_NOT_FOUND";
    this.envKey = envKey;
    this.spec = spec;
  }
}

/**
 * Resolve a credential map to concrete values.
 *
 * @param {Record<string, CredentialSpec>} credentialMap
 *   Keys are the environment-variable names to populate.
 *   Values are source specs (see module docs).
 * @returns {Promise<Record<string, string>>}
 *   Plain object ready to spread into `upstream.env`.
 *
 * @typedef {{ from: 'keychain' | 'env', key: string, fallbackKeychain?: string, optional?: boolean }} CredentialSpec
 */
export async function resolveUpstreamCredentials(credentialMap) {
  if (!credentialMap || typeof credentialMap !== "object") return {};

  const entries = Object.entries(credentialMap);
  if (entries.length === 0) return {};

  const result = {};

  for (const [envKey, spec] of entries) {
    if (!spec || typeof spec !== "object") {
      throw new TypeError(
        `upstreamCredentials["${envKey}"]: expected a spec object with "from" field, got ${JSON.stringify(spec)}`,
      );
    }
    if (spec.from !== "keychain" && spec.from !== "env") {
      throw new TypeError(
        `upstreamCredentials["${envKey}"].from must be "keychain" or "env", got "${spec.from}"`,
      );
    }
    if (typeof spec.key !== "string" || !spec.key) {
      throw new TypeError(
        `upstreamCredentials["${envKey}"].key must be a non-empty string`,
      );
    }

    let value = null;

    if (spec.from === "keychain") {
      // Warn loudly if keychain is unavailable; fall back to env var of the same name.
      const available = await isKeychainAvailable();
      if (!available) {
        const fallbackEnvValue = process.env[envKey];
        if (fallbackEnvValue) {
          console.warn(
            `[strix-mcp-credentials] WARNING: keychain unavailable; ` +
              `falling back to process.env["${envKey}"] for credential "${spec.key}". ` +
              `Install keytar for persistent keychain storage.`,
          );
          value = fallbackEnvValue;
        } else {
          // Keychain unavailable AND no env fallback
          if (!spec.optional) {
            throw new KeychainUnavailableError(
              `keytar not installed. Cannot load "${spec.key}" from keychain. ` +
                `Set process.env["${envKey}"] as a fallback.`,
            );
          }
          continue;
        }
      } else {
        value = await getCredential(spec.key);
      }
    } else {
      // from: "env"
      value = process.env[spec.key] ?? null;

      // Optional env→keychain fallback
      if (value === null && spec.fallbackKeychain) {
        const available = await isKeychainAvailable();
        if (available) {
          value = await getCredential(spec.fallbackKeychain);
        }
      }
    }

    if (value === null || value === undefined) {
      if (spec.optional) continue;
      throw new CredentialNotFoundError(envKey, spec);
    }

    result[envKey] = value;
  }

  return result;
}
