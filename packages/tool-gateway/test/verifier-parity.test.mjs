/**
 * Cross-package parity test.
 *
 * Issues a receipt with @strixgov/tool-gateway and verifies it with
 * @strixgov/verifier's `verifyReceipt` — proves the canonical payload
 * serializer is byte-identical between the two packages. If this test
 * fails, every previously-issued receipt's signature is suspect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  issueReceipt,
  GENESIS_PROOF_CHAIN_HASH,
} from "../src/receipts.mjs";
import { generateSigningKey } from "../src/keys.mjs";
import {
  verifyReceipt as verifierVerifyReceipt,
  buildReceiptCanonicalPayload,
} from "../../strixgov-verifier/src/index.mjs";
import { canonicalReceiptPayload } from "../src/canonical.mjs";

test("verifier and gateway produce byte-identical v1 canonical payloads", () => {
  const sample = {
    schemaVersion: "1",
    receiptId: "rcpt_xyz",
    capabilityId: "filesystem.read",
    action: "fs.readFile",
    decision: "ALLOW",
    risk: "LOW",
    mode: "READ",
    invocationHash: "1".repeat(64),
    evidenceHash: "2".repeat(64),
    proofChainHash: "3".repeat(64),
    timestamp: "2026-05-07T00:00:00.000Z",
  };
  assert.equal(
    canonicalReceiptPayload(sample),
    buildReceiptCanonicalPayload(sample),
  );
});

test("verifier and gateway produce byte-identical v2 canonical payloads", () => {
  const sample = {
    schemaVersion: "2",
    receiptId: "rcpt_xyz",
    capabilityId: "filesystem.read",
    action: "fs.readFile",
    decision: "ALLOW",
    risk: "LOW",
    mode: "READ",
    policyVersion: "sha256:" + "0".repeat(64),
    tenantId: "fairytale-farms",
    environment: "prod",
    invocationHash: "1".repeat(64),
    evidenceHash: "2".repeat(64),
    proofChainHash: "3".repeat(64),
    timestamp: "2026-05-07T00:00:00.000Z",
  };
  assert.equal(
    canonicalReceiptPayload(sample),
    buildReceiptCanonicalPayload(sample),
  );
});

test("verifier accepts a tool-gateway receipt with JWKS", async () => {
  const sk = generateSigningKey("local-2026-05");
  const r = issueReceipt({
    invocation: {
      capabilityId: "filesystem.read",
      action: "fs.readFile",
      args: { path: "/tmp/x" },
    },
    capability: { id: "filesystem.read", risk: "LOW", mode: "READ" },
    decision: "ALLOW",
    previousChainHash: GENESIS_PROOF_CHAIN_HASH,
    signingKey: sk,
    policyVersion: "sha256:" + "0".repeat(64),
    tenantId: "fairytale-farms",
    environment: "prod",
  });

  const result = await verifierVerifyReceipt(r, {
    jwks: { keys: [sk.publicKeyJwk] },
  });
  assert.equal(result.signatureValid, true);
  assert.equal(result.verificationStatus, "VERIFIED");
});

test("verifier flags tampered receipts as TAMPERED", async () => {
  const sk = generateSigningKey("local-2026-05");
  const r = issueReceipt({
    invocation: {
      capabilityId: "filesystem.read",
      action: "fs.readFile",
      args: { path: "/tmp/x" },
    },
    capability: { id: "filesystem.read", risk: "LOW", mode: "READ" },
    decision: "ALLOW",
    previousChainHash: GENESIS_PROOF_CHAIN_HASH,
    signingKey: sk,
    policyVersion: "sha256:" + "0".repeat(64),
    tenantId: "fairytale-farms",
    environment: "prod",
  });
  const tampered = { ...r, decision: "DENY" };
  const result = await verifierVerifyReceipt(tampered, {
    jwks: { keys: [sk.publicKeyJwk] },
  });
  assert.equal(result.verificationStatus, "TAMPERED");
});
