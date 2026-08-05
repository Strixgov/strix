/**
 * End-to-end shadow discovery through startProxy (GSD-1 Phase 4).
 *
 * Same two-InMemoryTransport-pair harness as proxy-end-to-end.test.mjs:
 *
 *   [Test Client] ─in-memory─▶ [Proxy as Server]
 *                              [Proxy as Client] ─in-memory─▶ [Fake Upstream]
 *
 * The upstream advertises one tool the companion capability list has
 * classified and one it has NOT (`mystery_tool`). The suite drives real
 * MCP traffic and asserts shadow discovery reports the delta — without
 * perturbing the governance pipeline (verdicts, receipts) it observes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { startProxy, SHADOW_MEASUREMENT_DISCLAIMER } from "../src/index.mjs";

const SAMPLE_CAPS = [
  { id: "mcp.demo.read_thing", name: "read_thing", risk: "LOW", mode: "READ" },
  { id: "mcp.demo.write_thing", name: "write_thing", risk: "MEDIUM", mode: "WRITE" },
];

async function buildFakeUpstream() {
  const upstreamServer = new Server(
    { name: "fake-upstream", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  upstreamServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "read_thing", description: "Read a thing", inputSchema: { type: "object" } },
      { name: "write_thing", description: "Write a thing", inputSchema: { type: "object" } },
      { name: "mystery_tool", description: "Unclassified surface", inputSchema: { type: "object" } },
    ],
  }));
  upstreamServer.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `executed ${request.params.name}` }],
  }));

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await upstreamServer.connect(serverSide);
  const upstreamClient = new Client(
    { name: "test-upstream-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await upstreamClient.connect(clientSide);
  return { upstreamServer, upstreamClient };
}

async function startTestProxy({ shadowDiscovery, storagePath } = {}) {
  const auditLog = [];
  const receipts = [];
  const upstream = await buildFakeUpstream();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const consumerClient = new Client(
    { name: "test-consumer", version: "0.0.1" },
    { capabilities: {} },
  );

  const resolvedStoragePath =
    storagePath === undefined
      ? await fs.mkdtemp(path.join(os.tmpdir(), "strix-shadow-e2e-"))
      : storagePath;

  const handle = await startProxy({
    serverId: "demo",
    capabilities: SAMPLE_CAPS,
    // ALLOW everything so the governed pipeline exercises real calls;
    // mystery_tool has no capability row and rides the gateway's
    // generic classification — exactly the case shadow discovery exists
    // to surface.
    policy: {
      rules: {
        "mcp.demo.read_thing": "ALLOW",
        "mcp.demo.write_thing": "ALLOW",
        "mcp.demo.mystery_tool": "ALLOW",
      },
      default: "ALLOW",
    },
    storagePath: resolvedStoragePath,
    shadowDiscovery,
    onReceipt: (r) => receipts.push(r),
    onAudit: (e) => auditLog.push(e),
    transport: {
      kind: "test",
      upstreamClient: upstream.upstreamClient,
      serverTransport: serverSide,
    },
  });
  await consumerClient.connect(clientSide);

  return {
    consumer: consumerClient,
    proxy: handle,
    auditLog,
    receipts,
    storagePath: resolvedStoragePath,
    cleanup: async () => {
      try { await consumerClient.close(); } catch { /* */ }
      try { await handle.stop(); } catch { /* */ }
      try { await upstream.upstreamServer.close(); } catch { /* */ }
      if (resolvedStoragePath) {
        try { await fs.rm(resolvedStoragePath, { recursive: true, force: true }); } catch { /* */ }
      }
    },
  };
}

test("startup seed records the upstream's unclassified surface", async () => {
  const t = await startTestProxy();
  try {
    const snap = t.proxy.shadowDiscovery.snapshot();
    assert.equal(snap.advertisedToolCount, 3);
    assert.deepEqual(snap.unclassifiedAdvertised, ["mystery_tool"]);
    assert.equal(snap.measurement, SHADOW_MEASUREMENT_DISCLAIMER);
    // The startup seed already audited the unclassified tool.
    const seeded = t.auditLog.filter((e) => e.kind === "shadow.unclassified-tools");
    assert.equal(seeded.length, 1);
    assert.deepEqual(seeded[0].detail.tools, ["mystery_tool"]);
  } finally {
    await t.cleanup();
  }
});

test("real MCP traffic through the proxy lands in the shadow report", async () => {
  const t = await startTestProxy();
  try {
    await t.consumer.listTools();
    await t.consumer.callTool({ name: "read_thing", arguments: {} });
    await t.consumer.callTool({ name: "read_thing", arguments: {} });
    await t.consumer.callTool({ name: "mystery_tool", arguments: {} });

    const snap = t.proxy.shadowDiscovery.snapshot();
    assert.deepEqual(snap.callCounts, { read_thing: 2, mystery_tool: 1 });
    assert.deepEqual(snap.unclassifiedCallCounts, { mystery_tool: 1 });

    // The shadow JSONL exists under the receipt store and every line is
    // measurement-stamped.
    const raw = await fs.readFile(t.proxy.shadowDiscoveryLogPath, "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.length >= 2);
    for (const line of lines) {
      assert.equal(line.measurement, SHADOW_MEASUREMENT_DISCLAIMER);
    }
  } finally {
    await t.cleanup();
  }
});

test("observation never perturbs governance: receipts still flow for governed calls", async () => {
  const t = await startTestProxy();
  try {
    await t.consumer.callTool({ name: "write_thing", arguments: { v: 1 } });
    assert.ok(t.receipts.length >= 1, "governed call should still emit a receipt");
    // ...and the receipt pipeline's output is not shadow-shaped.
    assert.equal("measurement" in t.receipts[0], false);
  } finally {
    await t.cleanup();
  }
});

test("shadowDiscovery: false opts out cleanly", async () => {
  const t = await startTestProxy({ shadowDiscovery: false });
  try {
    assert.equal(t.proxy.shadowDiscovery, null);
    assert.equal(t.proxy.shadowDiscoveryLogPath, null);
    // Traffic still flows.
    const out = await t.consumer.callTool({ name: "read_thing", arguments: {} });
    assert.ok(out);
  } finally {
    await t.cleanup();
  }
});
