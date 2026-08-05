#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { verifyReceiptChain } from "@strixgov/verifier";
import { verifyExecutionOutcomeRecord } from "@strixgov/verifier/execution-outcome";

const root = process.argv[2] ?? ".strix-nooa";
const evidenceDir = path.join(root, "evidence");
const keyDir = path.join(root, "keys");

const receipts = await readJsonl(path.join(evidenceDir, "receipts.jsonl"));
const outcomes = await readJsonl(path.join(evidenceDir, "execution-outcomes.jsonl"));
const publicJwk = JSON.parse(
  await fs.readFile(path.join(keyDir, "public-jwk.json"), "utf8"),
);
const jwks = "keys" in publicJwk ? publicJwk : { keys: [publicJwk] };

const authorization = await verifyReceiptChain(receipts, { jwks });
const byId = new Map(receipts.map((receipt) => [receipt.receiptId, receipt]));
const execution = outcomes.map((outcome) => {
  const authorizationReceipt = byId.get(outcome.authorizationReceiptId) ?? null;
  return verifyExecutionOutcomeRecord(outcome, {
    jwks,
    authorizationReceipt,
  });
});

const verdict =
  authorization.chainValid === true &&
  authorization.receipts.every(
    (receipt) => receipt.verificationStatus === "VERIFIED",
  ) &&
  execution.every((outcome) => outcome.verificationStatus === "VERIFIED")
    ? "VERIFIED"
    : "FAILED";

const report = {
  verdict,
  authorization: {
    chainValid: authorization.chainValid,
    count: authorization.count,
    receipts: authorization.receipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      verificationStatus: receipt.verificationStatus,
    })),
  },
  execution: execution.map((outcome) => ({
    outcomeId: outcome.outcomeId,
    schemaValid: outcome.schemaValid,
    hashValid: outcome.hashValid,
    keyResolved: outcome.keyResolved,
    signatureValid: outcome.signatureValid,
    consistencyValid: outcome.consistencyValid,
    linkValid: outcome.linkValid,
    verificationStatus: outcome.verificationStatus,
    error: outcome.error,
  })),
};

console.log(JSON.stringify(report, null, 2));
process.exit(verdict === "VERIFIED" ? 0 : 1);

async function readJsonl(file) {
  const text = await fs.readFile(file, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(
          `${file}:${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
}
