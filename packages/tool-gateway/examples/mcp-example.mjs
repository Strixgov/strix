/**
 * Example 3 — MCP governance
 *
 * Run: node examples/mcp-example.mjs
 *
 * Demonstrates:
 *   - Wrapping an MCP-shaped client/server pair with the gateway
 *   - Auto-classification of tools by name (read_* → LOW, delete_* → CRITICAL)
 *   - The gateway sits inline: agent → governed client → real server
 *   - Receipts are emitted before any tool actually runs
 *
 * The "real" MCP client/server here is a tiny in-memory stand-in so the
 * example runs without any external MCP infra. Wiring the same adapter
 * to `@modelcontextprotocol/sdk` is mechanical.
 */

import {
  createGateway,
  generateSigningKey,
  MemoryStorage,
  fixedApprover,
} from "../src/index.mjs";
import { governedMcpClient } from "../src/adapters/mcp.mjs";

// ─── Pretend MCP server ─────────────────────────────────────────────────────
const fakeServer = {
  async listTools() {
    return [
      { name: "read_file", description: "read a file" },
      { name: "write_file", description: "write a file" },
      { name: "delete_file", description: "delete a file" },
      { name: "exec_shell", description: "run a shell command" },
    ];
  },
  async callTool(name, args) {
    return { tool: name, args, executed: true };
  },
};

const gateway = createGateway({
  signingKey: generateSigningKey("local-example"),
  storage: new MemoryStorage(),
  toolName: "mcp-example",
  policy: {
    rules: {
      "mcp.demo.read_file": "ALLOW",
      "mcp.demo.write_file": "APPROVAL_REQUIRED",
      "mcp.demo.delete_file": "DENY",
      "mcp.demo.exec_shell": "DENY",
    },
    default: "DENY",
  },
  capabilities: {},
  approval: { prompt: fixedApprover(true, "example-user") },
});

const client = governedMcpClient(gateway, fakeServer, {
  serverId: "demo",
  actorId: "agent-claude",
  actorRole: "agent",
});

console.log("─── MCP governance demo ───\n");

// listTools registers + classifies them
const tools = await client.listTools();
console.log(`discovered ${tools.length} MCP tools`);

// 1. read_file — LOW, ALLOWed
try {
  const r = await client.callTool("read_file", { path: "./README.md" });
  console.log(`✓ read_file OK: ${JSON.stringify(r)}`);
} catch (err) {
  console.log(`✗ read_file failed: ${err.message}`);
}

// 2. write_file — HIGH, APPROVAL_REQUIRED → approved
try {
  const r = await client.callTool("write_file", { path: "./out.txt", body: "hi" });
  console.log(`✓ write_file OK (after approval): ${JSON.stringify(r)}`);
} catch (err) {
  console.log(`✗ write_file failed: ${err.message}`);
}

// 3. delete_file — CRITICAL, DENY
try {
  await client.callTool("delete_file", { path: "./out.txt" });
  console.log("✗ delete_file unexpectedly executed");
} catch (err) {
  console.log(`✓ delete_file denied: ${err.code}`);
}

// 4. exec_shell — DENY
try {
  await client.callTool("exec_shell", { cmd: "ls" });
  console.log("✗ exec_shell unexpectedly executed");
} catch (err) {
  console.log(`✓ exec_shell denied: ${err.code}`);
}

const receipts = await gateway.listReceipts();
console.log(`\n${receipts.length} receipts. proof chain: ${(await gateway.verifyChain()).valid}`);
