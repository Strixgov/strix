/**
 * Persistent capability registry.
 *
 * The in-process `policyEngine.capabilities` map is fast but ephemeral —
 * two agent processes on the same host can disagree about what
 * `filesystem.delete` is classified as. The persistent registry fixes
 * that with a single signed manifest on disk that any process can load
 * and verify.
 *
 * On-disk shape:
 *
 *   {
 *     "schemaVersion": "registry-1",
 *     "capabilities": [ { id, name, risk, mode, description }, ... ],
 *     "updatedAt": "<iso8601>",
 *     "signingKeyId": "<kid>",
 *     "signature": "<base64url>"
 *   }
 *
 * The signature covers a canonical JSON serialisation of
 *
 *   { schemaVersion, capabilities, updatedAt, signingKeyId }
 *
 * Capabilities are sorted by `id` before signing so two callers writing
 * the same set hash to the same bytes regardless of insertion order.
 *
 * Verification uses the `KeyRing` so signatures from previously-rotated
 * kids still verify. The signing kid is whatever was active when the
 * manifest was last written.
 *
 * Optional file watch: `loadCapabilityRegistry({ watch: true })` returns
 * a registry that auto-reloads when the file changes. Useful when one
 * process writes and others consume.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import os from "node:os";
import { canonicalJSON } from "./canonical.mjs";

export const REGISTRY_SCHEMA_VERSION = "registry-1";

// Dispatch table: add new versions here without touching loadCapabilityRegistry.
const SUPPORTED_REGISTRY_VERSIONS = new Set(["registry-1"]);

const DEFAULT_REGISTRY_PATH = path.join(
  os.homedir(),
  ".strix-gateway",
  "capabilities.json",
);

const REGISTRY_FIELDS = Object.freeze([
  "schemaVersion",
  "capabilities",
  "updatedAt",
  "signingKeyId",
]);

/**
 * @param {object} canonical
 */
function canonicalManifestPayload(canonical) {
  // Use canonicalJSON over the locked-field subset so semantically-equal
  // manifests hash identically. The capabilities array is sorted by id
  // before this is called — see saveCapabilityRegistry.
  const subset = {};
  for (const field of REGISTRY_FIELDS) {
    if (canonical[field] === undefined) {
      throw new Error(`canonicalManifestPayload: missing field '${field}'`);
    }
    subset[field] = canonical[field];
  }
  return canonicalJSON(subset);
}

/**
 * @param {Array<{ id: string, name?: string, risk: string, mode: string, description?: string }>} caps
 */
function normaliseCapabilities(caps) {
  if (!Array.isArray(caps)) {
    throw new TypeError("capabilities must be an array");
  }
  const seen = new Set();
  const out = [];
  for (const c of caps) {
    if (!c || typeof c.id !== "string" || !c.id) {
      throw new TypeError("capability.id must be a non-empty string");
    }
    if (seen.has(c.id)) {
      throw new Error(`duplicate capability id: ${c.id}`);
    }
    seen.add(c.id);
    if (typeof c.risk !== "string" || typeof c.mode !== "string") {
      throw new TypeError(`capability '${c.id}' missing risk/mode`);
    }
    // Omit undefined optional fields so canonicalJSON is happy and so two
    // semantically-equal capabilities (one with `name: undefined`, one
    // with no `name` key) hash identically.
    const entry = { id: c.id, risk: c.risk, mode: c.mode };
    if (typeof c.name === "string") entry.name = c.name;
    if (typeof c.description === "string") entry.description = c.description;
    out.push(entry);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * Sign + write a capability manifest atomically.
 *
 * @param {{
 *   path?: string,
 *   capabilities: Array<{ id: string, name?: string, risk: string, mode: string, description?: string }>,
 *   signingKey: import("./types.d.ts").SigningKey,
 *   updatedAt?: string,
 * }} args
 */
export async function saveCapabilityRegistry(args) {
  const file = args.path ?? DEFAULT_REGISTRY_PATH;
  if (!args.signingKey || !args.signingKey.privateKey) {
    throw new Error("saveCapabilityRegistry: signingKey is required");
  }
  const capabilities = normaliseCapabilities(args.capabilities);
  const updatedAt = args.updatedAt ?? new Date().toISOString();
  const manifest = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    capabilities,
    updatedAt,
    signingKeyId: args.signingKey.kid,
  };
  const payload = canonicalManifestPayload(manifest);
  const signature = crypto
    .sign(null, Buffer.from(payload, "utf8"), args.signingKey.privateKey)
    .toString("base64url");
  const full = { ...manifest, signature };

  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Atomic-ish write: tmp file + rename. Concurrent writers can still
  // race, but each individual file is well-formed.
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(full, null, 2), { mode: 0o644 });
  await fs.rename(tmp, file);
  return full;
}

/**
 * Read + verify a capability manifest. The signature MUST verify against
 * a public key the caller provides via `resolvePublicKey(kid)` (typically
 * `KeyRing.publicKeyForKid`). A failed signature throws — no partial
 * trust.
 *
 * @param {{
 *   path?: string,
 *   resolvePublicKey: (kid: string) => import("node:crypto").KeyObject | null,
 * }} args
 * @returns {Promise<{ schemaVersion: string, capabilities: object[], updatedAt: string, signingKeyId: string, signature: string }>}
 */
export async function loadCapabilityRegistry(args) {
  const file = args.path ?? DEFAULT_REGISTRY_PATH;
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!SUPPORTED_REGISTRY_VERSIONS.has(parsed.schemaVersion)) {
    throw new Error(
      `loadCapabilityRegistry: unsupported schemaVersion '${parsed.schemaVersion}' (supported: ${[...SUPPORTED_REGISTRY_VERSIONS].join(", ")})`,
    );
  }
  if (typeof parsed.signingKeyId !== "string" || !parsed.signingKeyId) {
    throw new Error("loadCapabilityRegistry: missing signingKeyId");
  }
  if (typeof parsed.signature !== "string" || !parsed.signature) {
    throw new Error("loadCapabilityRegistry: missing signature");
  }
  const publicKey = args.resolvePublicKey(parsed.signingKeyId);
  if (!publicKey) {
    throw new Error(
      `loadCapabilityRegistry: kid not in keyring: ${parsed.signingKeyId}`,
    );
  }
  // Re-canonicalise from the file's contents — re-sort capabilities so a
  // hand-edited (re-ordered) manifest with otherwise-valid signature
  // still verifies if the operator only re-shuffled keys. A real edit
  // breaks the hash.
  const capabilities = normaliseCapabilities(parsed.capabilities);
  const subset = {
    schemaVersion: parsed.schemaVersion,
    capabilities,
    updatedAt: parsed.updatedAt,
    signingKeyId: parsed.signingKeyId,
  };
  const payload = canonicalManifestPayload(subset);
  const sigOk = crypto.verify(
    null,
    Buffer.from(payload, "utf8"),
    publicKey,
    Buffer.from(parsed.signature, "base64url"),
  );
  if (!sigOk) {
    throw new Error("loadCapabilityRegistry: signature does not verify");
  }
  return { ...parsed, capabilities };
}

/**
 * File-watching variant. Returns an EventEmitter-like object with
 * `current()` for the latest snapshot and `close()` to stop watching.
 *
 * @param {{
 *   path?: string,
 *   resolvePublicKey: (kid: string) => import("node:crypto").KeyObject | null,
 *   onChange?: (snapshot: object) => void,
 *   onError?: (err: Error) => void,
 * }} args
 */
export async function watchCapabilityRegistry(args) {
  const file = args.path ?? DEFAULT_REGISTRY_PATH;
  let current = await loadCapabilityRegistry({
    path: file,
    resolvePublicKey: args.resolvePublicKey,
  });
  let closed = false;
  let pending = null;
  const reload = async () => {
    if (closed) return;
    try {
      const next = await loadCapabilityRegistry({
        path: file,
        resolvePublicKey: args.resolvePublicKey,
      });
      current = next;
      args.onChange?.(next);
    } catch (err) {
      args.onError?.(err);
    }
  };
  const watcher = watch(file, { persistent: false }, () => {
    // Debounce — editors often write tmp+rename and we don't want to
    // re-verify mid-write.
    clearTimeout(pending);
    pending = setTimeout(reload, 50);
  });
  watcher.on("error", (err) => args.onError?.(err));

  return {
    current: () => current,
    close: () => {
      closed = true;
      clearTimeout(pending);
      watcher.close();
    },
  };
}

export { DEFAULT_REGISTRY_PATH };
