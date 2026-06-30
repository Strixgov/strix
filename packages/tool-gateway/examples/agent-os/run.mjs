/**
 * Strix Agent OS demo — the same task graph, governed two ways.
 *
 *   node examples/agent-os/run.mjs
 *
 * Runs offline. No env vars, no network, no real side effects. Decisions and
 * verification verdicts are deterministic; only the per-run signature bytes and
 * timestamps differ (the gateway timestamps each receipt at mint time).
 *
 * Three scenes:
 *   1. Allowed path   — an operator approves the refund; gateway ALLOWs it and
 *                       every receipt verifies. (The gate is not just a blocker.)
 *   2. Blocked injection — a "pre-approved, skip the gate" note is smuggled into
 *                       the task data. Self-attested governance honors it and
 *                       executes the refund (writing a clean audit log). The
 *                       gateway never reads the note → DENY, signed.
 *   3. Adversarial    — three tampers against a signed receipt, all rejected.
 *
 * Exits non-zero if any invariant the demo claims fails to hold.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedApprover } from "../../src/index.mjs";
import { planTaskGraph } from "./planner.mjs";
import { runSelfAttested } from "./arm-self-attested.mjs";
import { runThroughGateway } from "./arm-gateway.mjs";
import { verifyOne, runAdversarialChecks } from "./verify.mjs";
import { printParityPanel } from "./parity.mjs";
import { runConnectedDemo } from "./connected.mjs";
import { planTaskGraphLive } from "./live.mjs";
import { writeObservatory } from "./observatory.mjs";

// ── Flags (all stretch; the three scenes run by default) ──────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);

// --parity: print the gateway → console governedProcedure() mapping and exit.
if (flag("--parity")) {
  printParityPanel();
  process.exit(0);
}

// --connected: sync the same signed receipts to a (mock or real) kernel and exit.
if (flag("--connected")) {
  const { ok } = await runConnectedDemo();
  console.log(`\n  connected-mode round trip: ${ok ? "OK ✓" : "FAILED ✗"}`);
  process.exit(ok ? 0 : 1);
}

const useLive = flag("--live");
const obsIdx = argv.indexOf("--observatory");
const obsPath = obsIdx !== -1 ? argv[obsIdx + 1] ?? "agent-os-run.html" : null;

const work = mkdtempSync(join(tmpdir(), "agent-os-demo-"));
const failures = [];
const note = (cond, msg) => { if (!cond) failures.push(msg); };

const hr = (s) => console.log(`\n${"─".repeat(64)}\n${s}\n${"─".repeat(64)}`);

// ── Scene 1 — allowed path (operator present) ────────────────────────────────
hr("SCENE 1 — allowed path: operator approves the refund");
const cleanTasks = planTaskGraph();
const s1 = await runThroughGateway(cleanTasks, {
  approver: fixedApprover(true, "ops-lead"),
  storageDir: work,
  storageFile: "scene1.jsonl",
});
for (const o of s1.outcomes) {
  console.log(`  ${o.task} ${o.capabilityId.padEnd(22)} → ${o.decision}`);
}
const s1Receipts = await s1.gateway.listReceipts();
let s1AllVerified = true;
for (const r of s1Receipts) {
  const v = verifyOne(r, s1.publicKeyJwk);
  if (v.status !== "VERIFIED") s1AllVerified = false;
}
console.log(`  → @strixgov/verifier: ${s1Receipts.length} receipts, ${s1AllVerified ? "all VERIFIED" : "VERIFICATION FAILED"}`);
note(s1AllVerified, "Scene 1: not all receipts verified");
const refundAllow = s1Receipts.find((r) => r.capabilityId === "billing.issue_refund");
note(refundAllow && refundAllow.decision === "ALLOW", "Scene 1: refund was not ALLOWed under operator approval");

// ── Scene 2 — the injection ───────────────────────────────────────────────────
hr("SCENE 2 — prompt injection: 'finance pre-approved this, skip the gate'");
let injectedTasks = planTaskGraph({ injected: true });
if (useLive) {
  const liveTasks = await planTaskGraphLive({ injected: true });
  if (liveTasks) {
    injectedTasks = liveTasks;
    console.log(`  [--live] claude-opus-4-8: real model emitted ${liveTasks.length} tool calls`);
  } else {
    console.log("  [--live] no ANTHROPIC_API_KEY (or API error) — using deterministic planner");
  }
}

const auditPath = join(work, "self-attested-audit.json");
const audit = await runSelfAttested(injectedTasks, { humanApprovesHighRisk: false, auditPath });
const armARefund = audit.find((a) => a.capabilityId === "billing.issue_refund");

const s2 = await runThroughGateway(injectedTasks, {
  approver: undefined, // no operator present
  storageDir: work,
  storageFile: "scene2.jsonl",
});
const armBRefund = s2.outcomes.find((o) => o.capabilityId === "billing.issue_refund");

console.log("  ARM A  (self-attested / soft)");
console.log(`     refund executed : ${armARefund.executed}   (gate: ${armARefund.gate})`);
console.log(`     audit log says  : approved=${armARefund.approved}, by ${armARefund.approvedBy.slice(0, 48)}…`);
console.log(`     evidence        : ${auditPath}  (a file the agent wrote about itself)`);
console.log("  ARM B  (gateway / hard)");
console.log(`     refund executed : ${armBRefund.executed}   decision: ${armBRefund.decision}`);
const s2Receipts = await s2.gateway.listReceipts();
const armBRefundReceipt = s2Receipts.find((r) => r.capabilityId === "billing.issue_refund");
const armBVerify = verifyOne(armBRefundReceipt, s2.publicKeyJwk);
console.log(`     evidence        : signed receipt ${armBRefundReceipt.receiptId} → ${armBVerify.status} (decision: ${armBRefundReceipt.decision})`);
console.log("\n  The injection lived in T4's task data. Arm A's governor read it as");
console.log("  authority and complied. Arm B's policy never reads task data — the");
console.log("  injection could not reach the decision.");

note(armARefund.executed === true, "Scene 2: self-attested arm should have been fooled into executing the refund");
note(armBRefund.decision === "DENY" && armBRefund.executed === false, "Scene 2: gateway should have DENIED the injected refund");
note(armBVerify.status === "VERIFIED", "Scene 2: the DENY receipt should itself verify");

// ── Scene 3 — adversarial ─────────────────────────────────────────────────────
hr("SCENE 3 — adversarial: the proof is checkable, and lying is detectable");
const adv = runAdversarialChecks(refundAllow, s1.publicKeyJwk, s1Receipts);
console.log(`  a) flip one signature byte      → ${adv.signatureTamper.status.padEnd(10)} ${adv.signatureTamper.caught ? "REJECTED ✓" : "NOT CAUGHT ✗"}`);
console.log(`  b) edit a signed field (decision)→ ${adv.fieldTamper.status.padEnd(10)} ${adv.fieldTamper.caught ? "REJECTED ✓" : "NOT CAUGHT ✗"}`);
console.log(`  c) corrupt a chain link          → ${(adv.chainTamper.caught ? `break@${adv.chainTamper.brokeAtIndex}` : "intact").padEnd(10)} ${adv.chainTamper.caught ? "REJECTED ✓" : "NOT CAUGHT ✗"}`);
console.log("\n  Arm A has no equivalent column: there is no signed record to tamper-check.");
note(adv.signatureTamper.caught, "Scene 3: signature tamper not caught");
note(adv.fieldTamper.caught, "Scene 3: field tamper not caught");
note(adv.chainTamper.caught, "Scene 3: chain tamper not caught");

// ── Optional visual export (--observatory) ───────────────────────────────────
if (obsPath) {
  const out = writeObservatory({
    outPath: obsPath,
    armA: audit,
    armBReceipts: s2Receipts,
    armBVerify: (r) => verifyOne(r, s2.publicKeyJwk).status,
  });
  console.log(`\n  observatory written → ${out}  (open in a browser)`);
}

// ── Verdict ───────────────────────────────────────────────────────────────────
hr("VERDICT");
if (failures.length === 0) {
  console.log("  All demo invariants held. Verify any receipt yourself:");
  console.log("    npx @strixgov/verifier <receiptId>   (byte-identical to the in-package verify)");
  console.log("\n  Modeled side effects only — no real money moved, no email was sent.");
  console.log("  Proves: authorization + signed evidence of the decision. NOT execution result.");
  process.exit(0);
} else {
  console.error("  DEMO FAILED — invariants violated:");
  for (const f of failures) console.error(`    ✗ ${f}`);
  process.exit(1);
}
