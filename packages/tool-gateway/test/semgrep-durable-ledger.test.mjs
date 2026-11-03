import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableApprovalLedger } from "../src/adapters/semgrep-durable-ledger.mjs";
const action = { tenantId: "fixture", actorId: "agent", tool: "scan", args: { path: "/fixture" } };
test("durable ledger grants once across independent instances and refuses changed action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "strix-ledger-"));
  try {
    const a = new DurableApprovalLedger({ dir });
    const b = new DurableApprovalLedger({ dir });
    const token = await a.issue(action);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).consume(token, action)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await b.consume(token, action), false);
    const changedToken = await a.issue(action);
    assert.equal(await b.consume(changedToken, { ...action, args: { path: "/changed" } }), false);
    assert.equal(await a.consume(changedToken, action), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("unavailable ledger fails closed", async () => {
  const ledger = new DurableApprovalLedger({ dir: "/dev/null/strix-approvals" });
  assert.equal(await ledger.consume("00000000-0000-4000-8000-000000000000", action), false);
});
