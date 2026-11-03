import test from "node:test";
import assert from "node:assert/strict";
import { LocalApprovalLedger, createGovernedSemgrep, actionDigest, SEMGREP_IMAGE } from "../src/adapters/semgrep-pinned.mjs";

function harness() {
  const calls = [];
  const receipts = [];
  let online = true;
  const transport = { async callTool(name, args) {
    if (!online) throw new Error("downstream unavailable");
    calls.push({ name, args });
    return { ok: true };
  }};
  const gateway = {
    registerCapability() {},
    async recordDenial({ reason }) { const receipt = { decision: "DENY", reason }; receipts.push(receipt); return receipt; },
    async execute(invocation, fn) {
      const result = await fn();
      receipts.push({ decision: "ALLOW", invocation });
      return { ok: true, decision: "ALLOW", result };
    },
  };
  const ledger = new LocalApprovalLedger();
  const build = (actorId = "agent-1") => createGovernedSemgrep({
    gateway, transport, ledger, tenantId: "fixture-tenant", actorId, toolName: "semgrep_scan",
  });
  const args = { path: "/fixture", config: "auto" };
  const grant = (actorId = "agent-1", override = args) => ledger.issue({
    tenantId: "fixture-tenant", actorId, tool: "semgrep_scan", args: override,
  });
  return { calls, receipts, ledger, build, args, grant, setOnline(v) { online = v; } };
}
test("pinned image is immutable digest", () => assert.match(SEMGREP_IMAGE, /@sha256:[a-f0-9]{64}$/));
test("canonical arguments order independent", () => assert.equal(actionDigest({a:1,b:2}), actionDigest({b:2,a:1})));
test("exact approved invocation dispatches once", async () => {
  const h = harness(); const r = await h.build().execute(h.args, h.grant());
  assert.equal(r.ok, true); assert.equal(h.calls.length, 1);
});
test("mutation after approval refuses before dispatch", async () => {
  const h = harness(); const r = await h.build().execute({ ...h.args, path: "/other" }, h.grant());
  assert.equal(r.decision, "DENY"); assert.equal(h.calls.length, 0);
});
test("different agent refuses before dispatch", async () => {
  const h = harness(); const r = await h.build("agent-2").execute(h.args, h.grant());
  assert.equal(r.decision, "DENY"); assert.equal(h.calls.length, 0);
});
test("replay refuses second dispatch", async () => {
  const h = harness(); const token = h.grant(); const b = h.build();
  await b.execute(h.args, token); const r = await b.execute(h.args, token);
  assert.equal(r.decision, "DENY"); assert.equal(h.calls.length, 1);
});
test("concurrent reuse dispatches at most once", async () => {
  const h = harness(); const token = h.grant(); const b = h.build();
  const r = await Promise.all(Array.from({length: 20}, () => b.execute(h.args, token)));
  assert.equal(r.filter(x => x.decision === "ALLOW").length, 1);
  assert.equal(h.calls.length, 1);
});
test("unavailable gateway fails without downstream dispatch", async () => {
  const h = harness(); const gateway = { registerCapability() {}, async execute() { throw new Error("gateway unavailable"); }, async recordDenial() { throw new Error("gateway unavailable"); } };
  const b = createGovernedSemgrep({ gateway, transport: { async callTool() { h.calls.push(1); } }, ledger: h.ledger, tenantId: "fixture-tenant", actorId: "agent-1", toolName: "semgrep_scan" });
  await assert.rejects(() => b.execute(h.args, h.grant()), /gateway unavailable/);
  assert.equal(h.calls.length, 0);
});
