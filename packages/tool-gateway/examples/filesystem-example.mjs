/**
 * Example 1 — Filesystem governance
 *
 * Run: node examples/filesystem-example.mjs
 *
 * Demonstrates:
 *   - Reading a file is ALLOWed automatically (LOW risk)
 *   - Writing a file requires approval (HIGH risk)
 *   - Deleting is hard-denied by policy (CRITICAL)
 *   - Every call produces a signed receipt in the local chain
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  createGateway,
  generateSigningKey,
  MemoryStorage,
  fixedApprover,
} from "../src/index.mjs";
import { governedFs } from "../src/adapters/filesystem.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strix-example-"));
const targetFile = path.join(tmp, "hello.txt");
await fs.writeFile(targetFile, "hello from outside the gateway\n");

const gateway = createGateway({
  signingKey: generateSigningKey("local-example"),
  storage: new MemoryStorage(),
  toolName: "filesystem-example",
  policy: {
    rules: {
      "filesystem.read": "ALLOW",
      "filesystem.list": "ALLOW",
      "filesystem.write": "APPROVAL_REQUIRED",
      "filesystem.delete": "DENY",
    },
    default: "DENY",
  },
  capabilities: {},
  // For the example we wire a fixed approver instead of a TTY prompt.
  approval: { prompt: fixedApprover(true, "example-user") },
});

const fsi = governedFs(gateway, { actorId: "agent-claude", actorRole: "agent" });

console.log("─── filesystem governance demo ───");

// 1. READ — auto-allowed
const text = await fsi.readFile(targetFile);
console.log(`✓ read OK (${text.length} chars)`);

// 2. WRITE — APPROVAL_REQUIRED, but the fixed approver says yes
await fsi.writeFile(targetFile, "rewritten by the agent\n");
console.log(`✓ write OK (after approval)`);

// 3. DELETE — DENY (CRITICAL)
try {
  await fsi.unlink(targetFile);
  console.log("✗ delete unexpectedly allowed");
} catch (err) {
  console.log(`✓ delete denied as expected: ${err.message}`);
}

// 4. The proof chain links every receipt
const receipts = await gateway.listReceipts();
console.log(`\n${receipts.length} receipts in chain:`);
for (const r of receipts) {
  console.log(
    `  ${r.decision.padEnd(18)} ${r.capabilityId.padEnd(20)} → ${r.proofChainHash.slice(0, 16)}…`,
  );
}
const chain = await gateway.verifyChain();
console.log(`\nproof chain valid: ${chain.valid}`);

// Cleanup the tmpdir without going through the gateway (we just denied it).
await fs.rm(tmp, { recursive: true });
