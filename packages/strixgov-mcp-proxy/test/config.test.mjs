/**
 * Config loader tests — the CLI's only durable input is the config
 * file, so the loader's validation rules are the proxy's public
 * contract for operator-managed deployments.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, resolveCapabilities } from "../src/config.mjs";

async function withTempConfig(contents, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "strix-proxy-config-"));
  const file = path.join(dir, "proxy.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  try { return await fn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("loadConfig: rejects missing file", async () => {
  await assert.rejects(loadConfig("/this/path/does/not/exist.json"), /could not read/);
});

test("loadConfig: rejects malformed JSON", async () => {
  await withTempConfig("{ not: json }", async (file) => {
    await assert.rejects(loadConfig(file), /not valid JSON/);
  });
});

test("loadConfig: rejects non-object root", async () => {
  await withTempConfig("[]", async (file) => {
    await assert.rejects(loadConfig(file), /must be a JSON object/);
  });
});

test("loadConfig: requires upstream.command", async () => {
  await withTempConfig({ upstream: {} }, async (file) => {
    await assert.rejects(loadConfig(file), /upstream\.command/);
  });
});

test("loadConfig: rejects non-array upstream.args", async () => {
  await withTempConfig({ upstream: { command: "npx", args: "oops" } }, async (file) => {
    await assert.rejects(loadConfig(file), /upstream\.args/);
  });
});

test("loadConfig: rejects non-object policy", async () => {
  await withTempConfig({ upstream: { command: "x" }, policy: "deny-all" }, async (file) => {
    await assert.rejects(loadConfig(file), /'policy' must be an object/);
  });
});

test("loadConfig: expands a leading ~ in storagePath", async () => {
  await withTempConfig(
    { upstream: { command: "npx" }, storagePath: "~/strix-receipts" },
    async (file) => {
      const cfg = await loadConfig(file);
      assert.ok(!cfg.storagePath.startsWith("~"), `expected ~ to expand; got ${cfg.storagePath}`);
    },
  );
});

test("loadConfig: returns the parsed config when valid", async () => {
  await withTempConfig(
    {
      serverId: "notion",
      upstream: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
      policy: { default: "DENY" },
    },
    async (file) => {
      const cfg = await loadConfig(file);
      assert.equal(cfg.serverId, "notion");
      assert.equal(cfg.upstream.command, "npx");
      assert.deepEqual(cfg.upstream.args, ["-y", "@notionhq/notion-mcp-server"]);
    },
  );
});

test("loadConfig: missing keyPath is fine (undefined passes through)", async () => {
  await withTempConfig({ upstream: { command: "npx" } }, async (file) => {
    const cfg = await loadConfig(file);
    assert.equal(cfg.keyPath, undefined);
  });
});

test("loadConfig: rejects non-string keyPath", async () => {
  await withTempConfig({ upstream: { command: "npx" }, keyPath: 42 }, async (file) => {
    await assert.rejects(loadConfig(file), /'keyPath' must be a string/);
  });
});

test("loadConfig: expands a leading ~ in keyPath", async () => {
  await withTempConfig(
    { upstream: { command: "npx" }, keyPath: "~/.strix-mcp-proxy/my-server/keys" },
    async (file) => {
      const cfg = await loadConfig(file);
      assert.ok(!cfg.keyPath.startsWith("~"), `expected ~ to expand; got ${cfg.keyPath}`);
      assert.ok(cfg.keyPath.includes(".strix-mcp-proxy/my-server/keys"));
    },
  );
});

test("loadConfig: passes a valid string keyPath through unchanged", async () => {
  await withTempConfig(
    { upstream: { command: "npx" }, keyPath: "/opt/strix/keys" },
    async (file) => {
      const cfg = await loadConfig(file);
      assert.equal(cfg.keyPath, "/opt/strix/keys");
    },
  );
});

test("resolveCapabilities: passes an inline array through unchanged", async () => {
  const arr = [{ id: "x", name: "x", risk: "LOW", mode: "READ", description: "x" }];
  const out = await resolveCapabilities(arr);
  assert.equal(out, arr);
});

test("resolveCapabilities: returns undefined for null/undefined input", async () => {
  assert.equal(await resolveCapabilities(undefined), undefined);
  assert.equal(await resolveCapabilities(null), undefined);
});

test("resolveCapabilities: rejects non-string non-array input", async () => {
  await assert.rejects(resolveCapabilities(42), /must be a string import path or an array/);
});

test("resolveCapabilities: resolves a companion-pack module by import path", async () => {
  // Uses the workspace-symlinked package — exercises the real
  // dynamic-import flow the CLI would use in production.
  const caps = await resolveCapabilities("@strixgov/capabilities-mcp-common/notion");
  assert.ok(Array.isArray(caps));
  assert.ok(caps.length > 0);
  assert.ok(caps.every((c) => c.id?.startsWith("mcp.notion.")));
});
