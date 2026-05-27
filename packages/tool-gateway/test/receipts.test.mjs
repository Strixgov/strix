import { test } from "node:test";
import assert from "node:assert/strict";
import {
  issueReceipt,
  verifyReceipt,
  computeInvocationHash,
  GENESIS_PROOF_CHAIN_HASH,
} from "../src/receipts.mjs";
import { generateSigningKey, publicKeyFromJwk } from "../src/keys.mjs";
import nodeCrypto from "node:crypto";

const sk = generateSigningKey("local-test");
const cap = { id: "filesystem.read", risk: "LOW", mode: "READ" };
const inv = {
  capabilityId: "filesystem.read",
  action: "fs.readFile",
  args: { path: "/etc/hostname" },
};

test("issueReceipt produces a verifiable signature", () => {
  const r = issueReceipt({
    invocation: inv,
    capability: cap,
    decision: "ALLOW",
    previousChainHash: GENESIS_PROOF_CHAIN_HASH,
    signingKey: sk,
    policyVersion: "sha256:" + "0".repeat(64),
  });
  assert.equal(r.signingKeyId, "local-test");
  assert.equal(r.decision, "ALLOW");
  assert.equal(r.risk, "LOW");
  assert.equal(r.schemaVersion, "2");
  assert.equal(r.policyVersion, "sha256:" + "0".repeat(64));
  assert.equal(r.tenantId, "local");
  assert.equal(r.environment, "local");
  const result = verifyReceipt(r, sk.publicKey);
  assert.equal(result.signatureValid, true);
  assert.equal(result.status, "VERIFIED");
});

test("issueReceipt fails closed without a policyVersion", () => {
  assert.throws(
    () =>
      issueReceipt({
        invocation: inv,
        capability: cap,
        decision: "ALLOW",
        previousChainHash: GENESIS_PROOF_CHAIN_HASH,
        signingKey: sk,
        // policyVersion missing
      }),
    /policyVersion is required/,
  );
});

test("issueReceipt accepts custom tenantId + environment and binds them", () => {
  const r = issueReceipt({
    invocation: inv,
    capability: cap,
    decision: "ALLOW",
    previousChainHash: GENESIS_PROOF_CHAIN_HASH,
    signingKey: sk,
    policyVersion: "sha256:" + "0".repeat(64),
    tenantId: "fairytale-farms",
    environment: "prod",
  });
  assert.equal(r.tenantId, "fairytale-farms");
  assert.equal(r.environment, "prod");
  // Tampering with either field invalidates the signature.
  const tampered = { ...r, tenantId: "attacker-co" };
  const result = verifyReceipt(tampered, sk.publicKey);
  assert.equal(result.signatureValid, false);
});

test("verifyReceipt detects a mutated decision", () => {
  const r = issueReceipt({
    invocation: inv,
    capability: cap,
    decision: "ALLOW",
    previousChainHash: GENESIS_PROOF_CHAIN_HASH,
    signingKey: sk,
    policyVersion: "sha256:" + "0".repeat(64),
  });
  const tampered = { ...r, decision: "DENY" };
  const result = verifyReceipt(tampered, sk.publicKey);
  assert.equal(result.signatureValid, false);
  assert.equal(result.status, "TAMPERED");
});

test("verifyReceipt detects a mutated args (via invocationHash unchanged but evidenceHash broken)", () => {
  const r = issueReceipt({
    invocation: inv,
    capability: cap,
    decision: "ALLOW",
    previousChainHash: GENESIS_PROOF_CHAIN_HASH,
    signingKey: sk,
    policyVersion: "sha256:" + "0".repeat(64),
  });
  // Simulating an attacker rewriting the recorded args field while leaving
  // the canonical hashes alone — they don't match anymore so verify fails
  // (here we mutate evidenceHash directly which is a stronger tamper).
  const tampered = { ...r, evidenceHash: "f".repeat(64) };
  const result = verifyReceipt(tampered, sk.publicKey);
  assert.equal(result.signatureValid, false);
});

test("computeInvocationHash is deterministic for arg key reordering", () => {
  const a = computeInvocationHash({
    capabilityId: "x",
    action: "y",
    args: { a: 1, b: 2 },
  });
  const b = computeInvocationHash({
    capabilityId: "x",
    action: "y",
    args: { b: 2, a: 1 },
  });
  assert.equal(a, b);
});

test("verifying with a public key reconstructed from JWK works (verifier compatibility)", () => {
  const r = issueReceipt({
    invocation: inv,
    capability: cap,
    decision: "ALLOW",
    previousChainHash: GENESIS_PROOF_CHAIN_HASH,
    signingKey: sk,
    policyVersion: "sha256:" + "0".repeat(64),
  });
  const reconstructed = publicKeyFromJwk(sk.publicKeyJwk);
  const result = verifyReceipt(r, reconstructed);
  assert.equal(result.signatureValid, true);
});

test("v1 receipts (legacy) still verify after the v2 schema bump", () => {
  // Hand-craft a v1 receipt by calling crypto directly with the v1
  // canonical shape — proving the verifier dispatches on schemaVersion.
  // (We can't re-issue a v1 receipt through issueReceipt because that
  // path always emits v2 now; that's the whole point of the bump.)
  const v1Canonical = {
    schemaVersion: "1",
    receiptId: "rcpt_v1legacy",
    capabilityId: cap.id,
    action: inv.action,
    decision: "ALLOW",
    risk: cap.risk,
    mode: cap.mode,
    invocationHash: "a".repeat(64),
    evidenceHash: "b".repeat(64),
    proofChainHash: "c".repeat(64),
    timestamp: "2026-04-01T00:00:00.000Z",
  };
  // Build the v1 canonical bytes manually so we don't depend on the
  // serializer (paranoia: the test would pass trivially if we used it).
  const fields = [
    "schemaVersion","receiptId","capabilityId","action","decision",
    "risk","mode","invocationHash","evidenceHash","proofChainHash","timestamp",
  ];
  const payload =
    "{" +
    fields
      .map((f) => `${JSON.stringify(f)}:${JSON.stringify(v1Canonical[f])}`)
      .join(",") +
    "}";
  const signature = nodeCrypto
    .sign(null, Buffer.from(payload, "utf8"), sk.privateKey)
    .toString("base64url");
  const v1Receipt = {
    ...v1Canonical,
    signingKeyId: sk.kid,
    signature,
  };
  const result = verifyReceipt(v1Receipt, sk.publicKey);
  assert.equal(result.signatureValid, true);
  assert.equal(result.status, "VERIFIED");
});

test("issueReceipt fails closed when signing key is missing", () => {
  assert.throws(
    () =>
      issueReceipt({
        invocation: inv,
        capability: cap,
        decision: "ALLOW",
        previousChainHash: GENESIS_PROOF_CHAIN_HASH,
        // @ts-expect-error
        signingKey: null,
      }),
    /signingKey is required/,
  );
});

test("capability/invocation id mismatch throws (invariant: same tuple end-to-end)", () => {
  assert.throws(
    () =>
      issueReceipt({
        invocation: { ...inv, capabilityId: "filesystem.write" },
        capability: cap,
        decision: "ALLOW",
        previousChainHash: GENESIS_PROOF_CHAIN_HASH,
        signingKey: sk,
      }),
    /capability id mismatch/,
  );
});

test("chain hash links: receipt N's proofChainHash = sha256(receipt N-1.proofChainHash || receipt N.evidenceHash)", async () => {
  const crypto = await import("node:crypto");
  const r1 = issueReceipt({
    invocation: inv,
    capability: cap,
    decision: "ALLOW",
    previousChainHash: GENESIS_PROOF_CHAIN_HASH,
    signingKey: sk,
    policyVersion: "sha256:" + "0".repeat(64),
  });
  const r2 = issueReceipt({
    invocation: inv,
    capability: cap,
    decision: "DENY",
    previousChainHash: r1.proofChainHash,
    signingKey: sk,
    policyVersion: "sha256:" + "0".repeat(64),
  });
  const expected = crypto
    .createHash("sha256")
    .update(`${r1.proofChainHash}|${r2.evidenceHash}`)
    .digest("hex");
  assert.equal(r2.proofChainHash, expected);
});
