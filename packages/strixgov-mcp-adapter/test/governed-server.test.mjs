/**
 * @strixgov/mcp-adapter — core tests.
 *
 * Covers:
 *   - governMCPServer with plain handler record
 *   - createGovernedServer convenience wrapper
 *   - ALLOW / DENY / APPROVAL_REQUIRED policy decisions
 *   - Companion-pack classification wins over heuristics
 *   - Heuristic fallback for unknown tools
 *   - Fail-closed: unknown tool name → CRITICAL EXECUTE → DENY by default
 *   - callTool ctx (actorId) is forwarded to the receipt
 *   - Signed authorization receipt is produced on every allowed call
 *   - listTools reflects the registered tools
 *   - { handler, listTools } interface is accepted without wrapping
 *   - createGovernedServer exposes gateway
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateSigningKey } from "@strixgov/tool-gateway";
import { governMCPServer, createGovernedServer } from "../src/index.mjs";

const POLICY_DENY_ALL = { default: "DENY" };

const POLICY_ALLOW_READ = {
  rules: { "mcp.gh.get_file": "ALLOW" },
  default: "DENY",
};

const GITHUB_CAPS = [
  { id: "mcp.gh.get_file",    name: "get_file",    risk: "LOW",      mode: "READ"    },
  { id: "mcp.gh.merge_pr",    name: "merge_pr",    risk: "HIGH",     mode: "WRITE"   },
  { id: "mcp.gh.delete_repo", name: "delete_repo", risk: "CRITICAL", mode: "WRITE"   },
];

const TOOLS = {
  get_file:    async ({ path })    => ({ content: `content of ${path}` }),
  merge_pr:    async ({ pr })      => ({ merged: true, pr }),
  delete_repo: async ({ repo })    => ({ deleted: repo }),
};

test("governMCPServer returns callTool, executeTool, listTools, gateway, signingKey", () => {
  const srv = governMCPServer(TOOLS, { serverId: "gh", policy: POLICY_DENY_ALL });
  assert.equal(typeof srv.callTool, "function");
  assert.equal(typeof srv.executeTool, "function");
  assert.equal(typeof srv.listTools, "function");
  assert.ok(srv.gateway, "gateway exposed");
  assert.ok(srv.signingKey, "signingKey exposed");
});

test("listTools reflects all registered tool names", async () => {
  const srv = governMCPServer(TOOLS, { serverId: "gh", policy: POLICY_DENY_ALL });
  const tools = await srv.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["delete_repo", "get_file", "merge_pr"]);
});

test("ALLOW: callTool executes handler and returns result", async () => {
  const srv = governMCPServer(TOOLS, {
    serverId: "gh",
    capabilities: GITHUB_CAPS,
    policy: {
      rules: { "mcp.gh.get_file": "ALLOW" },
      default: "DENY",
    },
  });
  const result = await srv.callTool("get_file", { path: "README.md" });
  assert.deepEqual(result, { content: "content of README.md" });
});

test("ALLOW: signed authorization receipt is written for every allowed call", async () => {
  const receipts = [];
  const srv = governMCPServer(TOOLS, {
    serverId: "gh",
    capabilities: GITHUB_CAPS,
    policy: {
      rules: { "mcp.gh.get_file": "ALLOW" },
      default: "DENY",
    },
  });
  srv.gateway.on("receipt", (r) => receipts.push(r));
  await srv.callTool("get_file", { path: "x" });
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0].signature, "receipt has Ed25519 signature");
  assert.equal(receipts[0].decision, "ALLOW");
});

test("DENY: callTool throws and tool handler is never invoked", async () => {
  let called = false;
  const srv = governMCPServer(
    { merge_pr: async () => { called = true; return {}; } },
    {
      serverId: "gh",
      capabilities: GITHUB_CAPS,
      policy: { rules: { "mcp.gh.merge_pr": "DENY" }, default: "DENY" },
    },
  );
  await assert.rejects(
    () => srv.callTool("merge_pr", { pr: 42 }),
    /denied/i,
  );
  assert.equal(called, false, "handler must not run on DENY");
});

test("DENY: signed receipt is still written even for denied calls", async () => {
  const receipts = [];
  const srv = governMCPServer(TOOLS, {
    serverId: "gh",
    capabilities: GITHUB_CAPS,
    policy: { default: "DENY" },
  });
  srv.gateway.on("receipt", (r) => receipts.push(r));
  await assert.rejects(() => srv.callTool("merge_pr", {}), /denied/i);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].decision, "DENY");
});

test("Unknown tool name → CRITICAL EXECUTE → DENY by default policy", async () => {
  const srv = governMCPServer(
    { get_file: async () => ({}) },
    { serverId: "gh", policy: { default: "DENY" } },
  );
  await assert.rejects(
    () => srv.callTool("nuke_everything", {}),
    /denied/i,
  );
});

test("Companion pack classification used for risk level (not heuristics)", async () => {
  const decisions = [];
  const srv = governMCPServer(TOOLS, {
    serverId: "gh",
    capabilities: GITHUB_CAPS,
    policy: {
      riskOverrides: { LOW: "ALLOW", HIGH: "DENY", CRITICAL: "DENY" },
      default: "DENY",
    },
  });
  srv.gateway.on("receipt", (r) => decisions.push({ name: r.capabilityId, d: r.decision }));

  await srv.callTool("get_file", { path: "x" });
  await assert.rejects(() => srv.callTool("merge_pr", {}));
  await assert.rejects(() => srv.callTool("delete_repo", {}));

  assert.equal(decisions[0].d, "ALLOW");
  assert.equal(decisions[1].d, "DENY");
  assert.equal(decisions[2].d, "DENY");
});

test("Heuristic fallback classifies 'get_*' as LOW READ", async () => {
  const srv = governMCPServer(
    { get_readme: async () => ({ content: "readme" }) },
    {
      serverId: "docs",
      policy: { riskOverrides: { LOW: "ALLOW" }, default: "DENY" },
    },
  );
  const result = await srv.callTool("get_readme", {});
  assert.deepEqual(result, { content: "readme" });
});

test("Heuristic fallback classifies 'delete_*' as CRITICAL WRITE", async () => {
  const decisions = [];
  const srv = governMCPServer(
    { delete_everything: async () => ({}) },
    { serverId: "x", policy: { default: "DENY" } },
  );
  srv.gateway.on("receipt", (r) => decisions.push(r));
  await assert.rejects(() => srv.callTool("delete_everything", {}));
  assert.equal(decisions[0].decision, "DENY");
  assert.ok(
    decisions[0].capabilityId.includes("delete_everything"),
    "capabilityId reflects tool name",
  );
});

test("actorId from ctx is bound to the receipt", async () => {
  const receipts = [];
  const srv = governMCPServer(TOOLS, {
    serverId: "gh",
    capabilities: GITHUB_CAPS,
    policy: { rules: { "mcp.gh.get_file": "ALLOW" }, default: "DENY" },
  });
  srv.gateway.on("receipt", (r) => receipts.push(r));
  await srv.callTool("get_file", { path: "y" }, { actorId: "agent-claude-1" });
  assert.equal(receipts[0].actorId, "agent-claude-1");
});

test("{ handler, listTools } interface is accepted without wrapping", async () => {
  const srv = governMCPServer(
    {
      listTools: async () => [{ name: "read_file" }],
      handler: async (name, args) => ({ name, args }),
    },
    {
      serverId: "fs",
      policy: { rules: { "mcp.fs.read_file": "ALLOW" }, default: "DENY" },
    },
  );
  const result = await srv.callTool("read_file", { path: "/tmp/x" });
  assert.deepEqual(result, { name: "read_file", args: { path: "/tmp/x" } });
});

test("createGovernedServer is a convenience alias for governMCPServer", async () => {
  const srv = createGovernedServer({
    serverId: "gh",
    capabilities: GITHUB_CAPS,
    policy: { rules: { "mcp.gh.get_file": "ALLOW" }, default: "DENY" },
    tools: {
      get_file: async ({ path }) => ({ content: path }),
    },
  });
  assert.equal(typeof srv.callTool, "function");
  assert.ok(srv.gateway, "gateway is exposed");
  const result = await srv.callTool("get_file", { path: "z" });
  assert.deepEqual(result, { content: "z" });
});

test("Empty tools record throws at construction", () => {
  assert.throws(
    () => governMCPServer({}, { serverId: "x" }),
    /non-empty/,
  );
});

test("Non-object tools throws at construction", () => {
  assert.throws(
    () => governMCPServer(null, { serverId: "x" }),
    /must be an object/,
  );
});

test("storagePath is a directory; authorization and outcome records persist separately", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strix-mcp-adapter-test-"));
  try {
    const srv = governMCPServer(
      { get_file: async ({ path: p }) => ({ content: `content of ${p}` }) },
      {
        serverId: "gh",
        storagePath: dir,
        signingKey: generateSigningKey("persistent-test-key"),
        policy: { rules: { "mcp.gh.get_file": "ALLOW" }, default: "DENY" },
      },
    );

    await srv.callTool("get_file", { path: "x" });

    const receiptPath = path.join(dir, "receipts.jsonl");
    const outcomePath = path.join(dir, "execution-outcomes.jsonl");
    assert.ok(fs.existsSync(receiptPath));
    assert.ok(fs.existsSync(outcomePath));

    const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n");
    const outcomes = fs.readFileSync(outcomePath, "utf8").trim().split("\n");
    assert.equal(receipts.length, 1);
    assert.equal(outcomes.length, 1);
    assert.equal(JSON.parse(receipts[0]).decision, "ALLOW");
    assert.equal(JSON.parse(outcomes[0]).executionStatus, "SUCCEEDED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
