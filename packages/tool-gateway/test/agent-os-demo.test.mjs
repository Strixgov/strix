/**
 * Smoke test for examples/agent-os — pins the three claims the demo makes.
 * Runs offline; no network, no real side effects.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedApprover } from "../src/index.mjs";
import { planTaskGraph } from "../examples/agent-os/planner.mjs";
import { runSelfAttested } from "../examples/agent-os/arm-self-attested.mjs";
import { runThroughGateway } from "../examples/agent-os/arm-gateway.mjs";
import { verifyOne, runAdversarialChecks } from "../examples/agent-os/verify.mjs";

const work = mkdtempSync(join(tmpdir(), "agent-os-test-"));

test("scene 1: operator-approved run — every receipt verifies, refund ALLOWed", async () => {
  const s1 = await runThroughGateway(planTaskGraph(), {
    approver: fixedApprover(true, "ops-lead"),
    storageDir: work,
    storageFile: "s1.jsonl",
  });
  const receipts = await s1.gateway.listReceipts();
  assert.equal(receipts.length, 5);
  for (const r of receipts) {
    assert.equal(verifyOne(r, s1.publicKeyJwk).status, "VERIFIED");
  }
  const refund = receipts.find((r) => r.capabilityId === "billing.issue_refund");
  assert.equal(refund.decision, "ALLOW");
});

test("scene 2: the injection fools soft governance but not the gateway", async () => {
  const tasks = planTaskGraph({ injected: true });

  // Arm A — self-attested: honors the smuggled "pre-approved" note and executes.
  const audit = await runSelfAttested(tasks, { humanApprovesHighRisk: false });
  const armA = audit.find((a) => a.capabilityId === "billing.issue_refund");
  assert.equal(armA.executed, true, "soft governance should be fooled into executing");
  assert.equal(armA.approved, true);

  // Arm B — gateway: policy never reads the note → DENY, and the DENY verifies.
  const s2 = await runThroughGateway(tasks, {
    approver: undefined,
    storageDir: work,
    storageFile: "s2.jsonl",
  });
  const armB = s2.outcomes.find((o) => o.capabilityId === "billing.issue_refund");
  assert.equal(armB.decision, "DENY");
  assert.equal(armB.executed, false);

  const receipts = await s2.gateway.listReceipts();
  const denyReceipt = receipts.find((r) => r.capabilityId === "billing.issue_refund");
  assert.equal(denyReceipt.decision, "DENY");
  assert.equal(verifyOne(denyReceipt, s2.publicKeyJwk).status, "VERIFIED");
});

test("stretch: connected mode delivers byte-identical receipts, HMAC verified", async () => {
  const { runConnectedDemo } = await import("../examples/agent-os/connected.mjs");
  const { ok } = await runConnectedDemo(); // offline mock kernel, no creds
  assert.ok(ok, "connected-mode round trip should verify HMAC and match the local chain");
});

test("stretch: observatory export writes a self-contained HTML file", async () => {
  const { writeObservatory } = await import("../examples/agent-os/observatory.mjs");
  const out = join(work, "obs.html");
  const audit = await runSelfAttested(planTaskGraph({ injected: true }), {});
  const s = await runThroughGateway(planTaskGraph({ injected: true }), {
    approver: undefined,
    storageDir: work,
    storageFile: "obs.jsonl",
  });
  const receipts = await s.gateway.listReceipts();
  writeObservatory({
    outPath: out,
    armA: audit,
    armBReceipts: receipts,
    armBVerify: (r) => verifyOne(r, s.publicKeyJwk).status,
  });
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("Arm A") && html.includes("Arm B"));
  assert.ok(!/https?:\/\//.test(html.replace(/strixgov/g, "")), "no external asset URLs");
});

test("scene 3: all three tampers are rejected", async () => {
  const s = await runThroughGateway(planTaskGraph(), {
    approver: fixedApprover(true, "ops-lead"),
    storageDir: work,
    storageFile: "s3.jsonl",
  });
  const receipts = await s.gateway.listReceipts();
  const refund = receipts.find((r) => r.capabilityId === "billing.issue_refund");
  const adv = runAdversarialChecks(refund, s.publicKeyJwk, receipts);
  assert.ok(adv.signatureTamper.caught, "signature tamper must be caught");
  assert.ok(adv.fieldTamper.caught, "field tamper must be caught");
  assert.ok(adv.chainTamper.caught, "chain tamper must be caught");
});
