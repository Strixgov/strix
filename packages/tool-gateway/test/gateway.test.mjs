import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGateway,
  generateSigningKey,
  MemoryStorage,
  fixedApprover,
  alwaysDenyApprover,
  verifyReceipt,
} from "../src/index.mjs";

function makeGateway(opts = {}) {
  return createGateway({
    signingKey: generateSigningKey("local-test"),
    storage: new MemoryStorage(),
    policy: opts.policy ?? {
      rules: { "x.read": "ALLOW", "x.write": "APPROVAL_REQUIRED", "x.del": "DENY" },
      default: "DENY",
    },
    capabilities: {
      "x.read": { id: "x.read", risk: "LOW", mode: "READ" },
      "x.write": { id: "x.write", risk: "HIGH", mode: "WRITE" },
      "x.del": { id: "x.del", risk: "CRITICAL", mode: "WRITE" },
    },
    approval: {
      prompt: opts.approver ?? alwaysDenyApprover,
    },
  });
}

test("ALLOW invokes the executor and produces an ALLOW receipt", async () => {
  const g = makeGateway();
  let executed = false;
  const out = await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => {
      executed = true;
      return "result";
    },
  );
  assert.equal(executed, true);
  assert.equal(out.ok, true);
  assert.equal(out.decision, "ALLOW");
  assert.equal(out.result, "result");
  assert.equal(out.receipt.decision, "ALLOW");
});

test("DENY does NOT invoke the executor but still issues a signed receipt", async () => {
  const g = makeGateway();
  let executed = false;
  const out = await g.execute(
    { capabilityId: "x.del", action: "x.del", args: {} },
    () => {
      executed = true;
      return "should-not-run";
    },
  );
  assert.equal(executed, false);
  assert.equal(out.ok, false);
  assert.equal(out.decision, "DENY");
  assert.equal(out.receipt.decision, "DENY");
  assert.ok(out.receipt.signature);
});

test("APPROVAL_REQUIRED + denial → DENY receipt + executor not called", async () => {
  const g = makeGateway({ approver: alwaysDenyApprover });
  let executed = false;
  const out = await g.execute(
    { capabilityId: "x.write", action: "x.write", args: {} },
    () => {
      executed = true;
    },
  );
  assert.equal(executed, false);
  assert.equal(out.decision, "DENY");
  assert.equal(out.receipt.approvalReason, "USER_DENIED");
});

test("APPROVAL_REQUIRED + approval → ALLOW + executor called", async () => {
  const g = makeGateway({ approver: fixedApprover(true, "alice") });
  let executed = false;
  const out = await g.execute(
    { capabilityId: "x.write", action: "x.write", args: { v: 1 } },
    () => {
      executed = true;
      return "ok";
    },
  );
  assert.equal(executed, true);
  assert.equal(out.decision, "ALLOW");
  assert.equal(out.result, "ok");
  assert.equal(out.receipt.approvedBy, "alice");
});

test("invariant: receipt is appended BEFORE executor runs", async () => {
  // We assert this by throwing from the executor and confirming the
  // receipt is still present in storage.
  const g = makeGateway();
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => {
      throw new Error("boom");
    },
  );
  const all = await g.listReceipts();
  assert.equal(all.length, 1);
  assert.equal(all[0].decision, "ALLOW");
});

test("proof chain links receipts in order", async () => {
  const g = makeGateway();
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: { i: 1 } },
    () => 1,
  );
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: { i: 2 } },
    () => 2,
  );
  await g.execute(
    { capabilityId: "x.del", action: "x.del", args: {} },
    () => "never",
  );
  const all = await g.listReceipts();
  assert.equal(all.length, 3);
  const chain = await g.verifyChain();
  assert.equal(chain.valid, true);

  // tamper with the middle receipt and re-verify.
  all[1].evidenceHash = "0".repeat(64);
  const broken = await g.verifyChain();
  assert.equal(broken.valid, false);
});

test("concurrent execute() calls produce a non-forked chain", async () => {
  const g = makeGateway();
  const calls = Array.from({ length: 8 }, (_, i) =>
    g.execute(
      { capabilityId: "x.read", action: "x.read", args: { i } },
      () => i,
    ),
  );
  await Promise.all(calls);
  const all = await g.listReceipts();
  assert.equal(all.length, 8);
  const chain = await g.verifyChain();
  assert.equal(chain.valid, true);
});

test("receipts are independently verifiable with the gateway's public key", async () => {
  const g = makeGateway();
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => 1,
  );
  const [r] = await g.listReceipts();
  const result = verifyReceipt(r, g.signingKey.publicKey);
  assert.equal(result.status, "VERIFIED");
});

test("unknown capability fails closed (DENY) but still mints receipt", async () => {
  const g = makeGateway();
  let executed = false;
  const out = await g.execute(
    { capabilityId: "totally.unknown", action: "x", args: {} },
    () => {
      executed = true;
    },
  );
  assert.equal(executed, false);
  assert.equal(out.decision, "DENY");
  assert.ok(out.receipt.signature);
});

// ─── v0.1.1 — policy version, tenant + env, observability events ──────────

test("every receipt carries the active policy version", async () => {
  const g = makeGateway();
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => 1,
  );
  const [r] = await g.listReceipts();
  assert.equal(r.policyVersion, g.policyVersion);
  assert.match(r.policyVersion, /^sha256:[0-9a-f]{64}$/);
});

test("setPolicy rotates policyVersion and subsequent receipts use the new one", async () => {
  const g = makeGateway();
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => 1,
  );
  const before = g.policyVersion;

  g.setPolicy({
    rules: { "x.read": "DENY", "x.write": "ALLOW", "x.del": "ALLOW" },
    default: "ALLOW",
  });
  assert.notEqual(before, g.policyVersion);

  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => 1,
  );
  const all = await g.listReceipts();
  assert.equal(all[0].policyVersion, before);
  assert.equal(all[1].policyVersion, g.policyVersion);
});

test("Gateway accepts and binds custom tenantId + environment", async () => {
  const g = createGateway({
    signingKey: generateSigningKey("local-test"),
    storage: new MemoryStorage(),
    tenantId: "fairytale-farms",
    environment: "prod",
    policy: { rules: { "x.read": "ALLOW" }, default: "DENY" },
    capabilities: {
      "x.read": { id: "x.read", risk: "LOW", mode: "READ" },
    },
  });
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => 1,
  );
  const [r] = await g.listReceipts();
  assert.equal(r.tenantId, "fairytale-farms");
  assert.equal(r.environment, "prod");
});

test("Gateway emits 'decision' before any receipt is written", async () => {
  const g = makeGateway();
  /** @type {string[]} */
  const order = [];
  g.on("decision", () => order.push("decision"));
  g.on("receipt", () => order.push("receipt"));
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => 1,
  );
  assert.deepEqual(order, ["decision", "receipt"]);
});

test("Gateway emits 'receipt' for every decision (ALLOW + DENY)", async () => {
  const g = makeGateway();
  /** @type {string[]} */
  const decisions = [];
  g.on("receipt", (r) => decisions.push(r.decision));
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => 1,
  );
  await g.execute(
    { capabilityId: "x.del", action: "x.del", args: {} },
    () => "never",
  );
  assert.deepEqual(decisions, ["ALLOW", "DENY"]);
});

test("Gateway emits 'denial' on policy denial, not on ALLOW", async () => {
  const g = makeGateway();
  let denials = 0;
  g.on("denial", () => denials++);
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => 1,
  );
  await g.execute(
    { capabilityId: "x.del", action: "x.del", args: {} },
    () => "never",
  );
  assert.equal(denials, 1);
});

test("Gateway emits 'error' when the executor throws (after the receipt is written)", async () => {
  const g = makeGateway();
  /** @type {Array<{ receipt: any, err: Error }>} */
  const errors = [];
  g.on("error", (e) => errors.push(e));
  await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => {
      throw new Error("boom");
    },
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].err.message, "boom");
  assert.equal(errors[0].receipt.decision, "ALLOW");
});

test("a buggy event listener does not poison the receipt-issuance flow", async () => {
  const g = makeGateway();
  g.on("receipt", () => {
    throw new Error("observer is buggy");
  });
  // execute() must still return cleanly.
  const out = await g.execute(
    { capabilityId: "x.read", action: "x.read", args: {} },
    () => "ok",
  );
  assert.equal(out.ok, true);
  assert.equal(out.result, "ok");
});
