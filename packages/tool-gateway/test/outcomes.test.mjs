import { test } from "node:test";
import assert from "node:assert/strict";

import {
  issueReceipt,
  GENESIS_PROOF_CHAIN_HASH,
} from "../src/receipts.mjs";
import { generateSigningKey } from "../src/keys.mjs";
import {
  issueExecutionOutcome,
  verifyExecutionOutcome,
  canonicalExecutionOutcomePayload,
} from "../src/outcomes.mjs";

const signingKey = generateSigningKey("outcome-test-2026-07");
const otherKey = generateSigningKey("wrong-key");
const invocation = {
  capabilityId: "mcp.nooa.repository.patch",
  action: "mcp.callTool:propose_patch",
  args: { repository: "demo/repo", patch: "sha256:abc" },
  actorId: "spiffe://openshell.local/nooa/remediator",
  actorRole: "agent",
};
const capability = {
  id: invocation.capabilityId,
  name: "propose_patch",
  risk: "HIGH",
  mode: "WRITE",
};

function authorizationReceipt() {
  return issueReceipt({
    invocation,
    capability,
    decision: "ALLOW",
    previousChainHash: GENESIS_PROOF_CHAIN_HASH,
    signingKey,
    policyVersion: "sha256:" + "1".repeat(64),
    tenantId: "nvidia-demo",
    environment: "openshell",
  });
}

test("SUCCEEDED outcome independently verifies and links to authorization", () => {
  const authorization = authorizationReceipt();
  const outcome = issueExecutionOutcome({
    authorizationReceipt: authorization,
    executionStatus: "SUCCEEDED",
    result: { branch: "remediation", changed: 2 },
    signingKey,
  });

  assert.equal(outcome.authorizationReceiptId, authorization.receiptId);
  assert.equal(outcome.authorizationProofChainHash, authorization.proofChainHash);
  assert.equal(outcome.executionStatus, "SUCCEEDED");
  assert.match(outcome.resultHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(outcome.errorCode, "");
  assert.equal(outcome.signatureAlgorithm, "Ed25519");
  assert.ok(outcome.signature);

  const result = verifyExecutionOutcome(outcome, signingKey.publicKey, authorization);
  assert.deepEqual(
    {
      schemaValid: result.schemaValid,
      hashValid: result.hashValid,
      keyResolved: result.keyResolved,
      signatureValid: result.signatureValid,
      linkValid: result.linkValid,
      consistencyValid: result.consistencyValid,
      status: result.verificationStatus,
    },
    {
      schemaValid: true,
      hashValid: true,
      keyResolved: true,
      signatureValid: true,
      linkValid: true,
      consistencyValid: true,
      status: "VERIFIED",
    },
  );
});

test("FAILED outcome carries error code and no result hash", () => {
  const authorization = authorizationReceipt();
  const outcome = issueExecutionOutcome({
    authorizationReceipt: authorization,
    executionStatus: "FAILED",
    errorCode: "UPSTREAM_TIMEOUT",
    signingKey,
  });
  assert.equal(outcome.executionStatus, "FAILED");
  assert.equal(outcome.resultHash, "");
  assert.equal(outcome.errorCode, "UPSTREAM_TIMEOUT");
  assert.equal(
    verifyExecutionOutcome(outcome, signingKey.publicKey, authorization).verificationStatus,
    "VERIFIED",
  );
});

test("tampered outcome hash fails separately from signature", () => {
  const authorization = authorizationReceipt();
  const outcome = issueExecutionOutcome({
    authorizationReceipt: authorization,
    executionStatus: "SUCCEEDED",
    result: { ok: true },
    signingKey,
  });
  const tampered = { ...outcome, resultHash: "sha256:" + "f".repeat(64) };
  const result = verifyExecutionOutcome(tampered, signingKey.publicKey, authorization);
  assert.equal(result.schemaValid, true);
  assert.equal(result.hashValid, false);
  assert.equal(result.signatureValid, false);
  assert.equal(result.verificationStatus, "HASH_MISMATCH");
});

test("wrong key fails signature while outcome hash remains valid", () => {
  const authorization = authorizationReceipt();
  const outcome = issueExecutionOutcome({
    authorizationReceipt: authorization,
    executionStatus: "SUCCEEDED",
    result: { ok: true },
    signingKey,
  });
  const result = verifyExecutionOutcome(outcome, otherKey.publicKey, authorization);
  assert.equal(result.hashValid, true);
  assert.equal(result.keyResolved, true);
  assert.equal(result.signatureValid, false);
  assert.equal(result.verificationStatus, "SIGNATURE_INVALID");
});

test("wrong algorithm is rejected explicitly", () => {
  const authorization = authorizationReceipt();
  const outcome = issueExecutionOutcome({
    authorizationReceipt: authorization,
    executionStatus: "SUCCEEDED",
    result: { ok: true },
    signingKey,
  });
  const result = verifyExecutionOutcome(
    { ...outcome, signatureAlgorithm: "RS256" },
    signingKey.publicKey,
    authorization,
  );
  assert.equal(result.schemaValid, false);
  assert.equal(result.verificationStatus, "ERROR");
  assert.match(result.error, /unsupported signatureAlgorithm/);
});

test("missing public key reports KEY_NOT_FOUND without claiming verification", () => {
  const authorization = authorizationReceipt();
  const outcome = issueExecutionOutcome({
    authorizationReceipt: authorization,
    executionStatus: "SUCCEEDED",
    result: { ok: true },
    signingKey,
  });
  const result = verifyExecutionOutcome(outcome, null, authorization);
  assert.equal(result.schemaValid, true);
  assert.equal(result.hashValid, true);
  assert.equal(result.keyResolved, false);
  assert.equal(result.signatureValid, false);
  assert.equal(result.verificationStatus, "KEY_NOT_FOUND");
});

test("unsigned extension fields are rejected instead of ignored", () => {
  const authorization = authorizationReceipt();
  const outcome = issueExecutionOutcome({
    authorizationReceipt: authorization,
    executionStatus: "SUCCEEDED",
    result: { ok: true },
    signingKey,
  });
  const result = verifyExecutionOutcome(
    { ...outcome, displayStatus: "FAILED" },
    signingKey.publicKey,
    authorization,
  );
  assert.equal(result.schemaValid, false);
  assert.equal(result.verificationStatus, "ERROR");
  assert.match(result.error, /unsupported field 'displayStatus'/);
});

test("wrong authorization link fails independently", () => {
  const authorization = authorizationReceipt();
  const otherAuthorization = authorizationReceipt();
  const outcome = issueExecutionOutcome({
    authorizationReceipt: authorization,
    executionStatus: "SUCCEEDED",
    result: { ok: true },
    signingKey,
  });
  const result = verifyExecutionOutcome(
    outcome,
    signingKey.publicKey,
    otherAuthorization,
  );
  assert.equal(result.hashValid, true);
  assert.equal(result.signatureValid, true);
  assert.equal(result.linkValid, false);
  assert.equal(result.verificationStatus, "AUTHORIZATION_LINK_INVALID");
});

test("DENY authorization cannot be promoted into an execution outcome", () => {
  const denied = issueReceipt({
    invocation,
    capability,
    decision: "DENY",
    previousChainHash: GENESIS_PROOF_CHAIN_HASH,
    signingKey,
    policyVersion: "sha256:" + "1".repeat(64),
    tenantId: "nvidia-demo",
    environment: "openshell",
  });
  assert.throws(
    () =>
      issueExecutionOutcome({
        authorizationReceipt: denied,
        executionStatus: "SUCCEEDED",
        result: { impossible: true },
        signingKey,
      }),
    /decision must be ALLOW/,
  );
});

test("canonical payload is deterministic", () => {
  const authorization = authorizationReceipt();
  const outcome = issueExecutionOutcome({
    authorizationReceipt: authorization,
    executionStatus: "SUCCEEDED",
    result: { b: 2, a: 1 },
    completedAt: "2026-07-27T22:00:00.000Z",
    outcomeId: "out_fixed",
    signingKey,
  });
  assert.equal(
    canonicalExecutionOutcomePayload(outcome),
    canonicalExecutionOutcomePayload({ ...outcome }),
  );
});
