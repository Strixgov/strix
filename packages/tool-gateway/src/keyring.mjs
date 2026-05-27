/**
 * KeyRing — multi-key Ed25519 management with rotation.
 *
 * v0.2 replaces the v0.1 single-key layout. The on-disk shape is now a
 * directory of keys, with one currently-active and zero or more retired:
 *
 *   ~/.strix-gateway/keys/
 *     active                              → text file, content = active kid
 *     <kid>/signing-key.pem               → PKCS8 PEM, mode 0600
 *     <kid>/public-jwk.json               → public JWK
 *     <kid>/meta.json                     → { status, generatedAt, retiredAt? }
 *
 * Status:
 *   - "active"  : used to sign new receipts. Exactly one at any time.
 *   - "retired" : kept on disk to verify historically-signed receipts.
 *
 * Rotation never deletes a private key — the file mode goes 0600 → 0400 on
 * retire so a misconfigured signer cannot accidentally re-use it. Public
 * JWKs of every kid (active + retired) are served via `KeyRing.jwks()` so
 * an external verifier can resolve any historical kid by the same JWKS
 * fetch.
 *
 * Backward compatibility: if a v0.1 layout (`signing-key.pem` directly
 * under `keys/`) is detected, the first `loadOrCreateKeyRing` call moves
 * it into `<kid>/` and writes the `active` pointer. No receipts are
 * affected — the kid embedded in the JWK is preserved.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  generateSigningKey,
  publicKeyFromJwk,
  DEFAULT_KEY_DIR,
} from "./keys.mjs";

const ACTIVE_POINTER = "active";
const PRIVATE_KEY_FILE = "signing-key.pem";
const PUBLIC_JWK_FILE = "public-jwk.json";
const META_FILE = "meta.json";

function nowIso() {
  return new Date().toISOString();
}

function defaultKid() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `local-${yyyy}-${mm}`;
}

/**
 * @param {string} dir
 */
async function readKey(dir) {
  const [pemBuf, jwkBuf, metaBuf] = await Promise.all([
    fs.readFile(path.join(dir, PRIVATE_KEY_FILE), "utf8").catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    }),
    fs.readFile(path.join(dir, PUBLIC_JWK_FILE), "utf8"),
    fs.readFile(path.join(dir, META_FILE), "utf8").catch(() => null),
  ]);
  const jwk = JSON.parse(jwkBuf);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.kid !== "string") {
    throw new Error(`KeyRing: malformed JWK in ${dir}`);
  }
  const meta = metaBuf
    ? JSON.parse(metaBuf)
    : { status: "active", generatedAt: nowIso() };
  let privateKey = null;
  let publicKey;
  if (pemBuf) {
    privateKey = crypto.createPrivateKey({ key: pemBuf, format: "pem" });
    publicKey = crypto.createPublicKey(privateKey);
  } else {
    publicKey = publicKeyFromJwk(jwk);
  }
  return {
    kid: jwk.kid,
    privateKey,
    publicKey,
    publicKeyJwk: jwk,
    meta,
  };
}

/**
 * @param {string} dir
 * @param {import("./types.d.ts").SigningKey & { meta?: { status: string, generatedAt: string, retiredAt?: string } }} key
 * @param {{ withPrivate?: boolean, privateMode?: number }} [opts]
 */
async function writeKey(dir, key, opts = {}) {
  const withPrivate = opts.withPrivate !== false;
  const privateMode = opts.privateMode ?? 0o600;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(dir, PUBLIC_JWK_FILE),
    JSON.stringify(key.publicKeyJwk, null, 2),
    { mode: 0o644 },
  );
  if (withPrivate && key.privateKey) {
    const pem = key.privateKey.export({ format: "pem", type: "pkcs8" });
    await fs.writeFile(path.join(dir, PRIVATE_KEY_FILE), pem, {
      mode: privateMode,
    });
  }
  const meta = key.meta ?? { status: "active", generatedAt: nowIso() };
  await fs.writeFile(
    path.join(dir, META_FILE),
    JSON.stringify(meta, null, 2),
    { mode: 0o644 },
  );
}

/**
 * Detect + migrate the v0.1 single-key layout. Idempotent.
 *
 * Pre-migration:
 *   keys/signing-key.pem
 *   keys/public-jwk.json
 *
 * Post-migration:
 *   keys/<kid>/signing-key.pem       (moved)
 *   keys/<kid>/public-jwk.json       (moved)
 *   keys/<kid>/meta.json             (created, status=active)
 *   keys/active                      (created, content=<kid>)
 *
 * @param {string} root
 * @returns {Promise<boolean>} true if migration ran
 */
async function migrateV01Layout(root) {
  const legacyPriv = path.join(root, PRIVATE_KEY_FILE);
  const legacyPub = path.join(root, PUBLIC_JWK_FILE);
  let pubExists = false;
  try {
    await fs.access(legacyPub);
    pubExists = true;
  } catch {
    return false;
  }
  if (!pubExists) return false;

  const jwk = JSON.parse(await fs.readFile(legacyPub, "utf8"));
  const kid = jwk.kid;
  if (typeof kid !== "string" || !kid) {
    throw new Error("KeyRing migration: legacy JWK missing kid");
  }
  const target = path.join(root, kid);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await fs
    .rename(legacyPriv, path.join(target, PRIVATE_KEY_FILE))
    .catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  await fs.rename(legacyPub, path.join(target, PUBLIC_JWK_FILE));
  await fs.writeFile(
    path.join(target, META_FILE),
    JSON.stringify({ status: "active", generatedAt: nowIso() }, null, 2),
    { mode: 0o644 },
  );
  await fs.writeFile(path.join(root, ACTIVE_POINTER), kid, { mode: 0o644 });
  return true;
}

/**
 * @typedef {{
 *   kid: string,
 *   privateKey: import("node:crypto").KeyObject | null,
 *   publicKey: import("node:crypto").KeyObject,
 *   publicKeyJwk: { kty: "OKP", crv: "Ed25519", kid: string, x: string },
 *   meta: { status: "active" | "retired", generatedAt: string, retiredAt?: string },
 * }} KeyRingEntry
 */

export class KeyRing {
  /**
   * @param {{ root: string, entries: Map<string, KeyRingEntry>, activeKid: string }} args
   */
  constructor({ root, entries, activeKid }) {
    this.root = root;
    this.entries = entries;
    this.activeKid = activeKid;
  }

  /** Active signing key, suitable for `Gateway`. */
  get active() {
    const e = this.entries.get(this.activeKid);
    if (!e || !e.privateKey) {
      throw new Error(`KeyRing: active kid '${this.activeKid}' has no private key`);
    }
    return {
      kid: e.kid,
      privateKey: e.privateKey,
      publicKey: e.publicKey,
      publicKeyJwk: e.publicKeyJwk,
    };
  }

  /**
   * @param {string} kid
   * @returns {KeyRingEntry | null}
   */
  get(kid) {
    return this.entries.get(kid) ?? null;
  }

  listKids() {
    return Array.from(this.entries.keys());
  }

  /**
   * JWKS suitable for serving from `/.well-known/strix-jwks.json` or
   * passing inline to `@strixgov/verifier`. Includes every kid the ring
   * has ever had — active + retired — so historical receipts remain
   * verifiable after rotation.
   */
  jwks() {
    return { keys: Array.from(this.entries.values()).map((e) => e.publicKeyJwk) };
  }

  /**
   * Generate a fresh keypair, write it to disk as the new active key, and
   * mark the previous active kid as retired. Returns both the previous and
   * the new active entries so the caller (or the chain-snapshot writer)
   * can record the rotation.
   *
   * @param {{ kid?: string }} [opts]
   */
  async rotate(opts = {}) {
    const previous = this.entries.get(this.activeKid);
    if (!previous) {
      throw new Error("KeyRing.rotate: no active key to rotate from");
    }

    const desiredKid = opts.kid ?? defaultKid();
    let newKid = desiredKid;
    if (this.entries.has(newKid)) {
      // Avoid clobbering an existing kid; suffix with a short random tag.
      const tag = crypto.randomBytes(2).toString("hex");
      newKid = `${desiredKid}-${tag}`;
    }
    if (newKid === previous.kid) {
      throw new Error("KeyRing.rotate: refusing to rotate to the same kid");
    }

    const fresh = generateSigningKey(newKid);
    const newEntry = {
      kid: newKid,
      privateKey: fresh.privateKey,
      publicKey: fresh.publicKey,
      publicKeyJwk: fresh.publicKeyJwk,
      meta: { status: /** @type {const} */ ("active"), generatedAt: nowIso() },
    };
    await writeKey(path.join(this.root, newKid), newEntry);

    const retiredAt = nowIso();
    const updatedPrev = {
      ...previous,
      meta: {
        ...previous.meta,
        status: /** @type {const} */ ("retired"),
        retiredAt,
      },
    };
    // Re-write meta so retiredAt persists. Drop privateKey file mode to
    // 0400 — still readable by the owner for emergency re-issuance, but
    // the gateway will refuse to use it because status=retired.
    await fs.writeFile(
      path.join(this.root, previous.kid, META_FILE),
      JSON.stringify(updatedPrev.meta, null, 2),
      { mode: 0o644 },
    );
    await fs
      .chmod(path.join(this.root, previous.kid, PRIVATE_KEY_FILE), 0o400)
      .catch(() => {});

    await fs.writeFile(path.join(this.root, ACTIVE_POINTER), newKid, {
      mode: 0o644,
    });

    this.entries.set(previous.kid, updatedPrev);
    this.entries.set(newKid, newEntry);
    this.activeKid = newKid;
    return { previous: updatedPrev, current: newEntry };
  }

  /**
   * Resolve a public key by kid for verification. Works for any retired
   * kid the ring has ever held, not just the active one.
   *
   * @param {string} kid
   * @returns {import("node:crypto").KeyObject | null}
   */
  publicKeyForKid(kid) {
    const e = this.entries.get(kid);
    return e ? e.publicKey : null;
  }
}

/**
 * Open or create a key ring rooted at `root`. Backward-compatible: if a
 * v0.1 single-key layout is found, it is migrated in-place before the
 * ring is built.
 *
 * @param {{ root?: string, kid?: string }} [opts]
 * @returns {Promise<KeyRing>}
 */
export async function loadOrCreateKeyRing(opts = {}) {
  const root = opts.root ?? DEFAULT_KEY_DIR;
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await migrateV01Layout(root);

  const entries = new Map();
  let activeKid = null;
  try {
    activeKid = (await fs.readFile(path.join(root, ACTIVE_POINTER), "utf8"))
      .trim();
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const dirents = await fs.readdir(root, { withFileTypes: true });
  for (const ent of dirents) {
    if (!ent.isDirectory()) continue;
    const kid = ent.name;
    try {
      const entry = await readKey(path.join(root, kid));
      if (entry.kid !== kid) {
        throw new Error(
          `KeyRing: kid mismatch — directory '${kid}' contains JWK kid '${entry.kid}'`,
        );
      }
      entries.set(kid, entry);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
  }

  if (!activeKid || !entries.has(activeKid)) {
    // Fresh install (or pointer corrupted). Mint a new active key.
    const kid = opts.kid ?? defaultKid();
    if (entries.has(kid)) {
      // Genuinely strange — directory exists without an active pointer.
      activeKid = kid;
    } else {
      const fresh = generateSigningKey(kid);
      const entry = {
        kid,
        privateKey: fresh.privateKey,
        publicKey: fresh.publicKey,
        publicKeyJwk: fresh.publicKeyJwk,
        meta: { status: /** @type {const} */ ("active"), generatedAt: nowIso() },
      };
      await writeKey(path.join(root, kid), entry);
      entries.set(kid, entry);
      activeKid = kid;
    }
    await fs.writeFile(path.join(root, ACTIVE_POINTER), activeKid, {
      mode: 0o644,
    });
  }

  return new KeyRing({ root, entries, activeKid });
}

export { ACTIVE_POINTER, PRIVATE_KEY_FILE, PUBLIC_JWK_FILE, META_FILE };
