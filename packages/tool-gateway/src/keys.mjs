/**
 * Ed25519 keypair management.
 *
 * Local-first: keys are generated and stored under
 * `~/.strix-gateway/keys/` by default. The key id format mirrors the
 * Strix kernel convention (`local-{YYYY-MM}`) so an external verifier
 * looking at receipts can tell at a glance that they came from a local
 * gateway, not a hosted Strix deployment.
 *
 * Private key never leaves the machine. Only the JWK (public bytes +
 * kid) gets published in the receipt.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_KEY_DIR = path.join(os.homedir(), ".strix-gateway", "keys");
const PRIVATE_KEY_FILE = "signing-key.pem";
const PUBLIC_JWK_FILE = "public-jwk.json";

function defaultKid() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `local-${yyyy}-${mm}`;
}

function publicKeyToJwk(publicKey, kid) {
  const der = publicKey.export({ format: "der", type: "spki" });
  // SPKI DER for Ed25519 is a 12-byte header + 32-byte key.
  const raw = der.subarray(der.length - 32);
  return {
    kty: "OKP",
    crv: "Ed25519",
    kid,
    x: raw.toString("base64url"),
  };
}

/**
 * Build an in-memory SigningKey from a Node KeyObject pair. Useful for
 * tests that don't want to touch disk.
 *
 * @param {{ privateKey: crypto.KeyObject, publicKey: crypto.KeyObject, kid?: string }} input
 * @returns {import("./types.d.ts").SigningKey}
 */
export function signingKeyFromPair({ privateKey, publicKey, kid }) {
  const id = kid ?? defaultKid();
  return {
    kid: id,
    privateKey,
    publicKey,
    publicKeyJwk: publicKeyToJwk(publicKey, id),
  };
}

/**
 * Generate a fresh Ed25519 keypair (in memory, not persisted).
 *
 * @param {string} [kid]
 * @returns {import("./types.d.ts").SigningKey}
 */
export function generateSigningKey(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return signingKeyFromPair({ privateKey, publicKey, kid });
}

/**
 * Load the gateway's signing key from disk, generating + persisting one
 * if none exists. Files:
 *
 *   {keyPath}/signing-key.pem    → PKCS8 PEM, mode 0600
 *   {keyPath}/public-jwk.json    → public JWK (kid, kty, crv, x)
 *
 * @param {{ keyPath?: string, kid?: string }} [opts]
 * @returns {Promise<import("./types.d.ts").SigningKey>}
 */
export async function loadOrCreateSigningKey(opts = {}) {
  const dir = opts.keyPath ?? DEFAULT_KEY_DIR;
  const privPath = path.join(dir, PRIVATE_KEY_FILE);
  const pubPath = path.join(dir, PUBLIC_JWK_FILE);

  try {
    const [privPem, jwkRaw] = await Promise.all([
      fs.readFile(privPath, "utf8"),
      fs.readFile(pubPath, "utf8"),
    ]);
    const jwk = JSON.parse(jwkRaw);
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.kid !== "string") {
      throw new Error("malformed public JWK on disk");
    }
    const privateKey = crypto.createPrivateKey({ key: privPem, format: "pem" });
    const publicKey = crypto.createPublicKey(privateKey);
    return {
      kid: jwk.kid,
      privateKey,
      publicKey,
      publicKeyJwk: jwk,
    };
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      throw new Error(
        `loadOrCreateSigningKey: refusing to overwrite existing key dir (${err.message})`
      );
    }
  }

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const kid = opts.kid ?? defaultKid();
  const key = generateSigningKey(kid);

  const pem = key.privateKey.export({ format: "pem", type: "pkcs8" });
  await fs.writeFile(privPath, pem, { mode: 0o600 });
  await fs.writeFile(pubPath, JSON.stringify(key.publicKeyJwk, null, 2), {
    mode: 0o644,
  });

  return key;
}

/**
 * Convert a stored JWK back to a Node KeyObject for verification.
 * Mirrors @strixgov/verifier's JWK→SPKI path so receipts remain
 * verifiable with the same primitives an auditor would use.
 *
 * @param {{ kty: string, crv: string, x: string }} jwk
 * @returns {crypto.KeyObject}
 */
export function publicKeyFromJwk(jwk) {
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new Error("publicKeyFromJwk: not an Ed25519 OKP JWK");
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) {
    throw new Error(`publicKeyFromJwk: bad raw key length ${raw.length}`);
  }
  const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
  const spki = Buffer.concat([spkiHeader, raw]);
  return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
}

export { DEFAULT_KEY_DIR };
