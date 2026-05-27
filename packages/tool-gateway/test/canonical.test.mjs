import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalReceiptPayload,
  canonicalJSON,
  RECEIPT_FIELD_ORDER,
} from "../src/canonical.mjs";

test("canonicalReceiptPayload v1 emits the 11 frozen fields in locked order", () => {
  const out = canonicalReceiptPayload({
    schemaVersion: "1",
    receiptId: "rcpt_test",
    capabilityId: "filesystem.read",
    action: "fs.readFile",
    decision: "ALLOW",
    risk: "LOW",
    mode: "READ",
    invocationHash: "a".repeat(64),
    evidenceHash: "b".repeat(64),
    proofChainHash: "c".repeat(64),
    timestamp: "2026-05-07T00:00:00.000Z",
  });
  assert.equal(
    out,
    `{"schemaVersion":"1","receiptId":"rcpt_test","capabilityId":"filesystem.read","action":"fs.readFile","decision":"ALLOW","risk":"LOW","mode":"READ","invocationHash":"${"a".repeat(64)}","evidenceHash":"${"b".repeat(64)}","proofChainHash":"${"c".repeat(64)}","timestamp":"2026-05-07T00:00:00.000Z"}`,
  );
});

test("canonicalReceiptPayload v2 emits 14 fields with policyVersion + tenant + env in locked order", () => {
  const out = canonicalReceiptPayload({
    schemaVersion: "2",
    receiptId: "rcpt_test",
    capabilityId: "filesystem.read",
    action: "fs.readFile",
    decision: "ALLOW",
    risk: "LOW",
    mode: "READ",
    policyVersion: "sha256:" + "9".repeat(64),
    tenantId: "local",
    environment: "dev",
    invocationHash: "a".repeat(64),
    evidenceHash: "b".repeat(64),
    proofChainHash: "c".repeat(64),
    timestamp: "2026-05-07T00:00:00.000Z",
  });
  assert.match(out, /^{"schemaVersion":"2","receiptId":"rcpt_test","capabilityId":/);
  // The new fields appear after `mode` and before the hashes.
  assert.match(
    out,
    /"mode":"READ","policyVersion":"sha256:9{64}","tenantId":"local","environment":"dev","invocationHash":/,
  );
});

test("canonicalReceiptPayload throws on unknown schemaVersion", () => {
  assert.throws(
    () =>
      canonicalReceiptPayload({
        schemaVersion: "999",
        receiptId: "rcpt_test",
      }),
    /unknown schemaVersion/,
  );
});

test("canonicalReceiptPayload v1 vs v2 produce different bytes (signatures don't cross versions)", () => {
  const common = {
    receiptId: "rcpt_test",
    capabilityId: "filesystem.read",
    action: "fs.readFile",
    decision: "ALLOW",
    risk: "LOW",
    mode: "READ",
    invocationHash: "a".repeat(64),
    evidenceHash: "b".repeat(64),
    proofChainHash: "c".repeat(64),
    timestamp: "2026-05-07T00:00:00.000Z",
  };
  const v1 = canonicalReceiptPayload({ ...common, schemaVersion: "1" });
  const v2 = canonicalReceiptPayload({
    ...common,
    schemaVersion: "2",
    policyVersion: "sha256:" + "0".repeat(64),
    tenantId: "local",
    environment: "local",
  });
  assert.notEqual(v1, v2);
});

test("canonicalReceiptPayload throws on missing required field", () => {
  assert.throws(
    () =>
      canonicalReceiptPayload({
        schemaVersion: "1",
        receiptId: "rcpt_test",
      }),
    /required field/,
  );
});

test("canonicalJSON sorts object keys lexicographically", () => {
  const a = canonicalJSON({ b: 1, a: 2, c: 3 });
  const b = canonicalJSON({ c: 3, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":3}');
});

test("canonicalJSON preserves array order", () => {
  assert.equal(canonicalJSON([3, 1, 2]), "[3,1,2]");
});

test("canonicalJSON rejects non-finite numbers", () => {
  assert.throws(() => canonicalJSON(NaN), /non-finite/);
  assert.throws(() => canonicalJSON(Infinity), /non-finite/);
});

test("RECEIPT_FIELD_ORDER is the current (v2) locked schema", () => {
  assert.deepEqual(RECEIPT_FIELD_ORDER, [
    "schemaVersion",
    "receiptId",
    "capabilityId",
    "action",
    "decision",
    "risk",
    "mode",
    "policyVersion",
    "tenantId",
    "environment",
    "invocationHash",
    "evidenceHash",
    "proofChainHash",
    "timestamp",
  ]);
});
