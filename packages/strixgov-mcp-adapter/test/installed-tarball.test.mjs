/**
 * Installed-tarball smoke test — the regression that the unit suite cannot
 * catch.
 *
 * Unit tests resolve `@strixgov/tool-gateway` via pnpm's workspace symlink
 * inside this monorepo. They will pass even if `src/index.mjs` imports the
 * peer dep through a workspace-relative path (`../../tool-gateway/...`),
 * because that path happens to exist on disk during local development.
 *
 * Every external consumer hits a different shape: `npm install
 * @strixgov/mcp-adapter` lands `src/` in `node_modules/@strixgov/mcp-adapter/`
 * with NO sibling `../../tool-gateway/` to fall back on. If the adapter's
 * imports aren't bare specifiers, `import` throws `ERR_MODULE_NOT_FOUND`
 * before a single test in this folder gets a chance to run.
 *
 * This test rebuilds that real-consumer environment from scratch:
 *
 *   1. `npm pack` both `@strixgov/tool-gateway` and this package
 *   2. Create a throwaway consumer directory
 *   3. `npm install` both tarballs (no network — purely offline file installs)
 *   4. Spawn a fresh `node` in the consumer dir that imports the adapter
 *      and exercises a single governed callTool end-to-end
 *
 * Slow (~2-5s under cold caches) but the only way to verify the package is
 * actually importable post-publish.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ADAPTER_DIR = path.resolve(__dirname, "..");                                // packages/strixgov-mcp-adapter
const GATEWAY_DIR = path.resolve(ADAPTER_DIR, "..", "tool-gateway");              // packages/tool-gateway

/** Run `npm pack <dir>` into <outDir> and return the absolute tarball path. */
function packTo(srcDir, outDir) {
  const out = execFileSync("npm", ["pack", srcDir, "--pack-destination", outDir], {
    cwd: outDir,
    encoding: "utf8",
  });
  // `npm pack` prints the tgz filename on the last non-empty line.
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const tgz = lines[lines.length - 1];
  return path.resolve(outDir, tgz);
}

test("packed tarball is importable when installed with only the declared peer dep", { timeout: 60_000 }, () => {
  const stage = mkdtempSync(path.join(tmpdir(), "strix-mcp-adapter-pack-"));
  const tarballs = path.join(stage, "tarballs");
  const consumer = path.join(stage, "consumer");
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(consumer, { recursive: true });

  try {
    // 1) Pack tool-gateway, then mcp-adapter, into the staging dir.
    const gatewayTgz = packTo(GATEWAY_DIR, tarballs);
    const adapterTgz = packTo(ADAPTER_DIR, tarballs);

    // 2) Create a bare consumer project — no workspace, no fallback sibling
    //    directories. Just a package.json that depends on the two tarballs.
    writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify(
        {
          name: "strix-mcp-adapter-tarball-smoke",
          version: "0.0.0",
          private: true,
          type: "module",
          dependencies: {
            "@strixgov/tool-gateway": `file:${gatewayTgz}`,
            "@strixgov/mcp-adapter": `file:${adapterTgz}`,
          },
        },
        null,
        2,
      ),
    );

    // 3) Install offline-style: no audit, no funding, no scripts. Tool-gateway
    //    has zero runtime deps so this resolves entirely from local tarballs.
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"],
      { cwd: consumer, encoding: "utf8" },
    );

    // 4) Drop a tiny consumer script and run it in a fresh node process.
    //    The script must (a) import the adapter via the bare specifier and
    //    (b) exercise a real ALLOW path so we know more than just module
    //    resolution survives.
    writeFileSync(
      path.join(consumer, "smoke.mjs"),
      `
        import { governMCPServer } from "@strixgov/mcp-adapter";
        const tools = { get_thing: async () => ({ ok: true }) };
        const srv = governMCPServer(tools, {
          serverId: "demo",
          capabilities: [
            { id: "mcp.demo.get_thing", name: "get_thing", risk: "LOW", mode: "READ" },
          ],
          policy: { rules: { "mcp.demo.get_thing": "ALLOW" }, default: "DENY" },
        });
        const r = await srv.callTool("get_thing", {});
        if (!r || r.ok !== true) {
          console.error("FAIL: unexpected result", r);
          process.exit(1);
        }
        console.log("OK");
      `,
    );

    const run = spawnSync("node", ["smoke.mjs"], {
      cwd: consumer,
      encoding: "utf8",
    });

    assert.equal(
      run.status,
      0,
      `consumer smoke exited ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
    );
    assert.match(run.stdout, /OK/, "consumer must print OK from a real ALLOW path");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
