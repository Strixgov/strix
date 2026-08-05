import { test } from "node:test";
import assert from "node:assert/strict";

import {
  issueReceipt,
  GENESIS_PROOF_CHAIN_HASH,
} from "../src/receipts.mjs";
import { generateSigningKey } from "../src/keys.mjs";
import {
  issueExecutionOutcome,
  canonicalExecutionOutcomeCore,
  canonicalExecutionOutcomePayload,
} from "../src/outcomes.mjs";
import {
  buildExecutionOutcomeCanonicalCore,
  buildExecutionOutcomeCanonicalPayload,
  verifyExecutionOutcomeRecord,
} from "../../strixgov-verifier/src/execution-outcome.mjs";

const signingKey = generateSigningKey("outcome-parity");
const authorization = issueReceipt({
  invocation: {
    capabilityId: "mcp.nooa.patch",
    action: "mcp.callTool:patch",
    args: { patch: "sha256:abc" },
    actorId: "spiffe://openshell/nooa/remediator",
  },
  capability: {
    id: "mcp.nooa.patch",
    name: "patch",
    risk: "HIGH",
    mode: "WRITE",
  },
  decision: "ALLOW",
  previousChainHash: GENESIS_PROOF_CHAIN_HASH,
  signingKey,
  policyVersion: "sha256:" + "4".repeat(64),
  tenantId: "nvidia-demo",
  environment: "openshell",
});

const outcome = issueExecutionOutcome({
  authorizationReceipt: authorization,
  executionStatus: "SUCCEEDED",
  result: { branch: "remediation" },
  completedAt: "2026-07-27T22:30:00.000Z",
  outcomeId: "out_parity",
  signingKey,
});

test("gateway and independent verifier produce identical outcome canonical bytes", () => {
  assert.equal(
    canonicalExecutionOutcomeCore(outcome),
    buildExecutionOutcomeCanonicalCore(outcome),
  );
  assert.equal(
    canonicalExecutionOutcomePayload(outcome),
    buildExecutionOutcomeCanonicalPayload(outcome),
  );
});

test("independent verifier accepts a gateway execution outcome through JWKS", () => {
  const result = verifyExecutionOutcomeRecord(outcome, {
    jwks: { keys: [signingKey.publicKeyJwk] },
    authorizationReceipt: authorization,
  });
  assert.equal(result.keyResolved, true);
  assert.equal(result.hashValid, true);
  assert.equal(result.signatureValid, true);
  assert.equal(result.linkValid, true);
  assert.equal(result.verificationStatus, "VERIFIED");
});

test("independent verifier reports missing key separately", () => {
  const result = verifyExecutionOutcomeRecord(outcome, {
    jwks: { keys: [] },
    authorizationReceipt: authorization,
  });
  assert.equal(result.hashValid, true);
  assert.equal(result.keyResolved, false);
  assert.equal(result.verificationStatus, "KEY_NOT_FOUND");
});
