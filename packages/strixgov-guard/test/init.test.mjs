/**
 * strix-guard init — wraps MCP client configs with the governed proxy.
 *
 * Pins: detection via --config, backup-before-write, verbatim upstream
 * move, pack selection (known → pre-classified, unknown → every call
 * asks), webhook plumb-through, idempotency, dry-run writes nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runInit, buildProxyConfig, packForServer, isAlreadyWrapped } from "../src/init.mjs";
import { guardPaths } from "../src/paths.mjs";

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strix-guard-test-"));
  const home = path.join(dir, "guard-home");
  const configPath = path.join(dir, "claude_desktop_config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          notion: {
            command: "npx",
            args: ["-y", "@notionhq/notion-mcp-server"],
            env: { NOTION_TOKEN: "secret" },
          },
          mystery: { command: "node", args: ["./my-server.js"] },
        },
      },
      null,
      2,
    ),
  );
  return { dir, home, configPath, env: { STRIX_GUARD_HOME: home } };
}

test("packForServer maps known servers and returns null for unknown", () => {
  assert.equal(
    packForServer("notion", { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] }),
    "@strixgov/capabilities-mcp-common/notion",
  );
  // Match on command contents even when the id is opaque.
  assert.equal(
    packForServer("tools", { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }),
    "@strixgov/capabilities-mcp-common/github",
  );
  assert.equal(packForServer("mystery", { command: "node", args: ["./x.js"] }), null);
});

test("buildProxyConfig: known pack → reads pass; unknown → every call asks", () => {
  const paths = guardPaths("/tmp/gh");
  const known = buildProxyConfig({
    serverId: "notion",
    entry: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
    paths,
  });
  assert.equal(known.capabilities, "@strixgov/capabilities-mcp-common/notion");
  assert.deepEqual(known.policy, { default: "APPROVAL_REQUIRED", riskOverrides: { LOW: "ALLOW" } });
  assert.equal(known.approval.type, "file");

  const unknown = buildProxyConfig({
    serverId: "mystery",
    entry: { command: "node", args: ["./x.js"] },
    paths,
    webhookUrl: "https://hooks.slack.com/services/T/B/X",
  });
  assert.deepEqual(unknown.capabilities, []);
  assert.deepEqual(unknown.policy, { default: "APPROVAL_REQUIRED" }); // never silent-allow
  assert.equal(unknown.approval.type, "webhook");
  assert.equal(unknown.approval.webhookUrl, "https://hooks.slack.com/services/T/B/X");
});

test("init wraps servers, backs up the config, and moves the upstream verbatim", async () => {
  const f = await fixture();
  try {
    const result = await runInit({ config: f.configPath, env: f.env, log: () => {} });
    assert.equal(result.wrapped, 2);

    // Backup exists with the ORIGINAL content.
    const entries = await fs.readdir(path.dirname(f.configPath));
    const backup = entries.find((e) => e.includes(".bak-strix-guard-"));
    assert.ok(backup, "backup file created");
    const original = JSON.parse(
      await fs.readFile(path.join(path.dirname(f.configPath), backup), "utf8"),
    );
    assert.equal(original.mcpServers.notion.command, "npx");

    // Client config now spawns the proxy.
    const rewritten = JSON.parse(await fs.readFile(f.configPath, "utf8"));
    assert.equal(rewritten.mcpServers.notion.command, "npx");
    assert.ok(rewritten.mcpServers.notion.args.includes("@strixgov/mcp-proxy"));

    // Proxy config carries the upstream verbatim (incl. env) + approval gate.
    const paths = guardPaths(f.home);
    const proxyCfg = JSON.parse(
      await fs.readFile(path.join(paths.serversDir, "notion.json"), "utf8"),
    );
    assert.deepEqual(proxyCfg.upstream, {
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { NOTION_TOKEN: "secret" },
    });
    assert.equal(proxyCfg.approval.enabled, true);
    assert.equal(proxyCfg.approval.requestDir, paths.approvalsDir);
    assert.equal(proxyCfg.storagePath, path.join(paths.receiptsDir, "notion"));

    // Local-only activation state recorded.
    const state = JSON.parse(await fs.readFile(paths.statePath, "utf8"));
    assert.ok(state.initializedAt);
    assert.deepEqual(new Set(state.wrappedServers), new Set(["notion", "mystery"]));
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test("init is idempotent — a second run wraps nothing", async () => {
  const f = await fixture();
  try {
    await runInit({ config: f.configPath, env: f.env, log: () => {} });
    const second = await runInit({ config: f.configPath, env: f.env, log: () => {} });
    assert.equal(second.wrapped, 0);
    assert.equal(second.skipped, 2);
    const rewritten = JSON.parse(await fs.readFile(f.configPath, "utf8"));
    assert.ok(isAlreadyWrapped(rewritten.mcpServers.notion));
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test("dry-run plans but writes nothing", async () => {
  const f = await fixture();
  try {
    const before = await fs.readFile(f.configPath, "utf8");
    const result = await runInit({ config: f.configPath, env: f.env, dryRun: true, log: () => {} });
    assert.equal(result.dryRun, true);
    assert.equal(result.wrapped, 0);
    assert.equal(await fs.readFile(f.configPath, "utf8"), before);
    await assert.rejects(() => fs.access(guardPaths(f.home).serversDir));
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test("init fails loudly on a missing or serverless config", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => runInit({ config: path.join(f.dir, "nope.json"), env: f.env, log: () => {} }),
      /config not found/,
    );
    const empty = path.join(f.dir, "empty.json");
    await fs.writeFile(empty, JSON.stringify({ mcpServers: {} }));
    await assert.rejects(
      () => runInit({ config: empty, env: f.env, log: () => {} }),
      /no mcpServers/,
    );
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});
