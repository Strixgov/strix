/**
 * CPPACK-1 — Companion-pack manifest loading is fail-closed.
 *
 * A missing manifest, unsigned manifest (absent signingKeyId or signature),
 * unknown kid, or tampered / wrong-key signature all throw a typed
 * CompanionManifestError before any capability is consumed. This is the
 * OB-1 extension to the capability-pack surface: no capability from a
 * companion pack may be consumed without a verified signature from a
 * known key.
 *
 * Tests use the node:test runner to stay consistent with the rest of the
 * tool-gateway package.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

import {
  saveCapabilityRegistry,
  loadCompanionPackManifest,
  CompanionManifestError,
  COMPANION_MANIFEST_ERROR,
} from "../src/index.mjs";
import { generateSigningKey } from "../src/index.mjs";

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Create a temp directory, write a signed manifest with the supplied key, and
 * return { dir, manifestPath, signingKey, resolvePublicKey }.
 */
async function makeSignedManifest({ capabilities, signingKey, dir } = {}) {
  const tmpDir = dir ?? (await mkdtemp(join(tmpdir(), "cppack-test-")));
  const key = signingKey ?? (await generateSigningKey("test-kid"));
  const manifestPath = join(tmpDir, "manifest.json");

  await saveCapabilityRegistry({
    path: manifestPath,
    capabilities: capabilities ?? [
      { id: "tool.read.file", risk: "low", mode: "read" },
      { id: "tool.write.file", risk: "high", mode: "write" },
    ],
    signingKey: key,
  });

  const resolvePublicKey = (kid) => (kid === key.kid ? key.publicKey : null);
  return { dir: tmpDir, manifestPath, signingKey: key, resolvePublicKey };
}

// ─── CPPACK-1: happy path ────────────────────────────────────────────────────

test("CPPACK-1: accepts a well-formed signed companion-pack manifest", async () => {
  const { manifestPath, resolvePublicKey } = await makeSignedManifest();
  const result = await loadCompanionPackManifest({
    path: manifestPath,
    resolvePublicKey,
  });
  assert.equal(result.schemaVersion, "registry-1");
  assert.ok(Array.isArray(result.capabilities));
  assert.ok(result.capabilities.length >= 1);
  assert.ok(typeof result.signature === "string" && result.signature.length > 0);
});

// ─── CPPACK-1: missing manifest → NOT_FOUND ──────────────────────────────────

test("CPPACK-1: missing manifest file throws CompanionManifestError NOT_FOUND", async () => {
  const nonexistent = join(tmpdir(), `cppack-missing-${Date.now()}.json`);
  const { resolvePublicKey } = await makeSignedManifest();
  await assert.rejects(
    () => loadCompanionPackManifest({ path: nonexistent, resolvePublicKey }),
    (err) => {
      assert.ok(err instanceof CompanionManifestError, "must be CompanionManifestError");
      assert.equal(err.code, COMPANION_MANIFEST_ERROR.NOT_FOUND);
      return true;
    },
  );
});

// ─── CPPACK-1: missing signingKeyId → UNSIGNED ───────────────────────────────

test("CPPACK-1: manifest missing signingKeyId throws CompanionManifestError UNSIGNED", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cppack-unsigned-kid-"));
  const manifestPath = join(tmpDir, "manifest.json");
  const { signingKey } = await makeSignedManifest({ dir: tmpDir });

  // Write a manifest that omits signingKeyId
  const bare = {
    schemaVersion: "registry-1",
    capabilities: [{ id: "tool.read.file", risk: "low", mode: "read" }],
    updatedAt: new Date().toISOString(),
    // signingKeyId deliberately omitted
    signature: "aGVsbG8",
  };
  await writeFile(manifestPath, JSON.stringify(bare));

  const resolvePublicKey = (kid) => (kid === signingKey.kid ? signingKey.publicKey : null);
  await assert.rejects(
    () => loadCompanionPackManifest({ path: manifestPath, resolvePublicKey }),
    (err) => {
      assert.ok(err instanceof CompanionManifestError);
      assert.equal(err.code, COMPANION_MANIFEST_ERROR.UNSIGNED);
      return true;
    },
  );
});

// ─── CPPACK-1: missing signature field → UNSIGNED ────────────────────────────

test("CPPACK-1: manifest missing signature field throws CompanionManifestError UNSIGNED", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cppack-no-sig-"));
  const manifestPath = join(tmpDir, "manifest.json");
  const key = await generateSigningKey("test-kid-2");

  // Write a manifest that has signingKeyId but no signature
  const bare = {
    schemaVersion: "registry-1",
    capabilities: [{ id: "tool.read.file", risk: "low", mode: "read" }],
    updatedAt: new Date().toISOString(),
    signingKeyId: key.kid,
    // signature deliberately omitted
  };
  await writeFile(manifestPath, JSON.stringify(bare));

  const resolvePublicKey = (kid) => (kid === key.kid ? key.publicKey : null);
  await assert.rejects(
    () => loadCompanionPackManifest({ path: manifestPath, resolvePublicKey }),
    (err) => {
      assert.ok(err instanceof CompanionManifestError);
      assert.equal(err.code, COMPANION_MANIFEST_ERROR.UNSIGNED);
      return true;
    },
  );
});

// ─── CPPACK-1: unknown kid → KID_UNKNOWN ─────────────────────────────────────

test("CPPACK-1: signing kid not in keyring throws CompanionManifestError KID_UNKNOWN", async () => {
  const { manifestPath } = await makeSignedManifest();
  // Resolver that never recognises any kid
  const resolvePublicKey = (_kid) => null;
  await assert.rejects(
    () => loadCompanionPackManifest({ path: manifestPath, resolvePublicKey }),
    (err) => {
      assert.ok(err instanceof CompanionManifestError);
      assert.equal(err.code, COMPANION_MANIFEST_ERROR.KID_UNKNOWN);
      return true;
    },
  );
});

// ─── CPPACK-1: tampered capabilities → SIG_INVALID ───────────────────────────

test("CPPACK-1: tampered capability id throws CompanionManifestError SIG_INVALID", async () => {
  const { manifestPath, resolvePublicKey } = await makeSignedManifest();

  // Patch the manifest on disk: change a capability id
  const { readFile, writeFile: wf } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  raw.capabilities[0].id = "tool.DELETE_EVERYTHING";
  await wf(manifestPath, JSON.stringify(raw));

  await assert.rejects(
    () => loadCompanionPackManifest({ path: manifestPath, resolvePublicKey }),
    (err) => {
      assert.ok(err instanceof CompanionManifestError);
      assert.equal(err.code, COMPANION_MANIFEST_ERROR.SIG_INVALID);
      return true;
    },
  );
});

// ─── CPPACK-1: tampered risk level → SIG_INVALID ─────────────────────────────

test("CPPACK-1: tampered risk level throws CompanionManifestError SIG_INVALID", async () => {
  const { manifestPath, resolvePublicKey } = await makeSignedManifest({
    capabilities: [{ id: "tool.write.file", risk: "high", mode: "write" }],
  });

  const { readFile, writeFile: wf } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  // Downgrade risk from 'high' to 'low' — a tamper that would slip past an
  // unsigned load but must be caught by the signature check
  raw.capabilities[0].risk = "low";
  await wf(manifestPath, JSON.stringify(raw));

  await assert.rejects(
    () => loadCompanionPackManifest({ path: manifestPath, resolvePublicKey }),
    (err) => {
      assert.ok(err instanceof CompanionManifestError);
      assert.equal(err.code, COMPANION_MANIFEST_ERROR.SIG_INVALID);
      return true;
    },
  );
});

// ─── CPPACK-1: wrong key (rotated) → SIG_INVALID ─────────────────────────────

test("CPPACK-1: signature from a different key throws CompanionManifestError SIG_INVALID", async () => {
  const { manifestPath, signingKey } = await makeSignedManifest();

  // A different key — same kid as the manifest claims, but different key material
  const wrongKey = await generateSigningKey(signingKey.kid);
  // Resolver returns the WRONG public key (rotated key material, same kid)
  const resolvePublicKey = (_kid) => wrongKey.publicKey;

  await assert.rejects(
    () => loadCompanionPackManifest({ path: manifestPath, resolvePublicKey }),
    (err) => {
      assert.ok(err instanceof CompanionManifestError);
      assert.equal(err.code, COMPANION_MANIFEST_ERROR.SIG_INVALID);
      return true;
    },
  );
});

// ─── CPPACK-1: unknown schemaVersion → SCHEMA_UNKNOWN ────────────────────────

test("CPPACK-1: unknown schemaVersion throws CompanionManifestError SCHEMA_UNKNOWN", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cppack-schema-"));
  const manifestPath = join(tmpDir, "manifest.json");
  const key = await generateSigningKey("test-kid-schema");

  const bare = {
    schemaVersion: "registry-99-future",
    capabilities: [{ id: "tool.read.file", risk: "low", mode: "read" }],
    updatedAt: new Date().toISOString(),
    signingKeyId: key.kid,
    signature: "aGVsbG8",
  };
  await writeFile(manifestPath, JSON.stringify(bare));

  const resolvePublicKey = (kid) => (kid === key.kid ? key.publicKey : null);
  await assert.rejects(
    () => loadCompanionPackManifest({ path: manifestPath, resolvePublicKey }),
    (err) => {
      assert.ok(err instanceof CompanionManifestError);
      assert.equal(err.code, COMPANION_MANIFEST_ERROR.SCHEMA_UNKNOWN);
      return true;
    },
  );
});
