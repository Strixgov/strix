/**
 * Installed-tarball smoke test — packs the validator, installs it into
 * a throwaway consumer project, and runs a real validation. This is
 * the only test that catches publish-time regressions:
 *
 *  - Files missing from the `files` allowlist in package.json
 *  - Subpath imports that resolve in the workspace but not post-install
 *  - Vendored modules that reference paths outside `src/`
 *
 * Slow (~1.5s under cold caches) but the only way to verify the
 * package is actually importable for an external consumer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, "..");

function packTo(srcDir, outDir) {
  const out = execFileSync("npm", ["pack", srcDir, "--pack-destination", outDir], {
    cwd: outDir,
    encoding: "utf8",
  });
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return path.resolve(outDir, lines[lines.length - 1]);
}

test(
  "packed tarball is importable when installed into a clean consumer",
  { timeout: 60_000 },
  () => {
    const stage = mkdtempSync(path.join(tmpdir(), "strix-mcp-token-validator-pack-"));
    const tarballs = path.join(stage, "tarballs");
    const consumer = path.join(stage, "consumer");
    mkdirSync(tarballs, { recursive: true });
    mkdirSync(consumer, { recursive: true });

    try {
      const tgz = packTo(PKG_DIR, tarballs);

      writeFileSync(
        path.join(consumer, "package.json"),
        JSON.stringify(
          {
            name: "strix-mcp-token-validator-tarball-smoke",
            version: "0.0.0",
            private: true,
            type: "module",
            dependencies: { "@strixgov/mcp-token-validator": `file:${tgz}` },
          },
          null,
          2,
        ),
      );

      execFileSync(
        "npm",
        ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"],
        { cwd: consumer, encoding: "utf8" },
      );

      // Real validation path: import the validator, the vendored canonical-JSON,
      // generate a keypair, mint + sign a token using node:crypto directly (no
      // dependency on the validator's test helpers — those don't ship), validate
      // it, confirm ok=true. Catches both module-resolution and runtime breakage.
      writeFileSync(
        path.join(consumer, "smoke.mjs"),
        `
          import crypto from "node:crypto";
          import {
            validateAuthorization,
            canonicalizeJSON,
          } from "@strixgov/mcp-token-validator";

          const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
          const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
          const jwk = { kid: "smoke-key", kty: "OKP", crv: "Ed25519", x: rawPub.toString("base64url") };

          const now = new Date();
          const expiresAt = new Date(now.getTime() + 60_000);
          const payload = {
            schemaVersion: 1,
            authorizationId: "exa_smoke",
            decisionId: "dec_smoke",
            capabilityId: "mcp.test.smoke",
            actorId: "agent-smoke",
            actorClass: "agent",
            payloadHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            tenantId: "smoke-tenant",
            environment: "test",
            nonce: crypto.randomBytes(16).toString("base64url"),
            issuedAt: now.toISOString().replace(/\\.\\d+Z$/, "Z"),
            expiresAt: expiresAt.toISOString().replace(/\\.\\d+Z$/, "Z"),
          };
          const canonical = canonicalizeJSON(payload);
          const signature = crypto.sign(null, Buffer.from(canonical, "utf-8"), privateKey).toString("base64url");
          const token = { ...payload, signingKeyId: jwk.kid, signature };

          const r = await validateAuthorization(token, {
            jwks: { keys: [jwk] },
            burnNonce: async () => true,
          });
          if (!r || r.ok !== true) {
            console.error("FAIL", JSON.stringify(r));
            process.exit(1);
          }
          console.log("OK");
        `,
      );

      const run = spawnSync("node", ["smoke.mjs"], { cwd: consumer, encoding: "utf8" });
      assert.equal(
        run.status,
        0,
        `consumer smoke exited ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
      );
      assert.match(run.stdout, /OK/, "consumer must print OK from a real validation");
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  },
);
