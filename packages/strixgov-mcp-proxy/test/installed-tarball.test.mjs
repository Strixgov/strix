/**
 * Installed-tarball smoke — packs @strixgov/mcp-proxy + its Strix
 * dependencies (@strixgov/mcp-adapter, @strixgov/tool-gateway) into a
 * throwaway consumer project, installs from local file: tarballs plus
 * the real @modelcontextprotocol/sdk from the registry, and verifies
 * the proxy is importable + the CLI prints help.
 *
 * The same regression class that bit @strixgov/mcp-adapter on this
 * branch (workspace-relative parent-path imports that resolve only in
 * the monorepo) would silently slip past unit tests here too. This
 * smoke is the one that catches it.
 *
 * Slower than the adapter's smoke (needs the MCP SDK transitive deps
 * from npm) — uses --prefer-offline so it's fast when the npm cache
 * is warm and works at all when it isn't.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PROXY_DIR = path.resolve(__dirname, "..");
const ADAPTER_DIR = path.resolve(PROXY_DIR, "..", "strixgov-mcp-adapter");
const GATEWAY_DIR = path.resolve(PROXY_DIR, "..", "tool-gateway");

function packTo(srcDir, outDir) {
  const out = execFileSync("npm", ["pack", srcDir, "--pack-destination", outDir], {
    cwd: outDir,
    encoding: "utf8",
  });
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return path.resolve(outDir, lines[lines.length - 1]);
}

// This test exercises `npm install` against the public registry to pull
// the MCP SDK and its transitive deps. In sandboxed CI environments that
// can't reach the public npm registry — or where the local mirror lacks
// recent versions — this would fail for reasons unrelated to the proxy.
// Set STRIX_RUN_TARBALL_INSTALL=1 in environments that have network +
// a full-registry npm to opt in.
const SHOULD_RUN_TARBALL_TEST = process.env.STRIX_RUN_TARBALL_INSTALL === "1";

test(
  "packed tarball + workspace Strix deps install cleanly and the CLI runs",
  {
    timeout: 180_000,
    skip: SHOULD_RUN_TARBALL_TEST
      ? false
      : "set STRIX_RUN_TARBALL_INSTALL=1 to enable (requires full npm registry access)",
  },
  () => {
    const stage = mkdtempSync(path.join(tmpdir(), "strix-mcp-proxy-pack-"));
    const tarballs = path.join(stage, "tarballs");
    const consumer = path.join(stage, "consumer");
    mkdirSync(tarballs, { recursive: true });
    mkdirSync(consumer, { recursive: true });

    try {
      // 1) Pack all three Strix packages into the staging dir.
      const gatewayTgz = packTo(GATEWAY_DIR, tarballs);
      const adapterTgz = packTo(ADAPTER_DIR, tarballs);
      const proxyTgz = packTo(PROXY_DIR, tarballs);

      // 2) Create a consumer that depends on the proxy tarball. The proxy's
      //    dependencies block carries workspace:^0.1.0 etc., which npm would
      //    misread on install — so we override the Strix deps to point at
      //    our local tarballs via package.json#overrides, the same mechanism
      //    consumers use to pin transitive deps.
      writeFileSync(
        path.join(consumer, "package.json"),
        JSON.stringify(
          {
            name: "strix-mcp-proxy-tarball-smoke",
            version: "0.0.0",
            private: true,
            type: "module",
            dependencies: {
              "@strixgov/mcp-proxy": `file:${proxyTgz}`,
              "@strixgov/mcp-adapter": `file:${adapterTgz}`,
              "@strixgov/tool-gateway": `file:${gatewayTgz}`,
            },
            overrides: {
              "@strixgov/mcp-adapter": `file:${adapterTgz}`,
              "@strixgov/tool-gateway": `file:${gatewayTgz}`,
            },
          },
          null,
          2,
        ),
      );

      // 3) Install — needs network the first time for the MCP SDK, then
      //    warm-cache fast.
      execFileSync(
        "npm",
        ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline", "--loglevel=error"],
        { cwd: consumer, encoding: "utf8" },
      );

      // 4) Import the proxy from a fresh node process — catches workspace-
      //    relative parent-path imports that would only resolve in the
      //    monorepo.
      writeFileSync(
        path.join(consumer, "import-smoke.mjs"),
        `
          import { startProxy, loadConfig, resolveCapabilities } from "@strixgov/mcp-proxy";
          if (typeof startProxy !== "function") { console.error("FAIL: startProxy not exported"); process.exit(1); }
          if (typeof loadConfig !== "function") { console.error("FAIL: loadConfig not exported"); process.exit(1); }
          if (typeof resolveCapabilities !== "function") { console.error("FAIL: resolveCapabilities not exported"); process.exit(1); }
          console.log("OK");
        `,
      );
      const importRun = spawnSync("node", ["import-smoke.mjs"], { cwd: consumer, encoding: "utf8" });
      assert.equal(
        importRun.status,
        0,
        `import smoke exited ${importRun.status}\nstdout: ${importRun.stdout}\nstderr: ${importRun.stderr}`,
      );
      assert.match(importRun.stdout, /OK/);

      // 5) Confirm the CLI is wired and runs.
      const cliRun = spawnSync("npx", ["strix-mcp-proxy", "--version"], {
        cwd: consumer,
        encoding: "utf8",
      });
      assert.equal(
        cliRun.status,
        0,
        `CLI --version exited ${cliRun.status}\nstdout: ${cliRun.stdout}\nstderr: ${cliRun.stderr}`,
      );
      assert.match(cliRun.stdout, /^strix-mcp-proxy \d+\.\d+\.\d+/);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  },
);
