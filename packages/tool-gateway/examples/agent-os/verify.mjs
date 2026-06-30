/**
 * Strix Agent OS demo — independent verification + adversarial checks.
 *
 * Uses ONLY the package's public, exported verify surface (verifyReceipt +
 * publicKeyFromJwk) — no gateway internals. `npx @strixgov/verifier <id>` is a
 * byte-identical mirror implementation (locked by test/verifier-parity.test.mjs)
 * and is what an external auditor would run; we use the in-package function here
 * so the example runs offline with zero install.
 */

import {
  verifyReceipt,
  publicKeyFromJwk,
  computeProofChainHash,
  GENESIS_PROOF_CHAIN_HASH,
} from "../../src/index.mjs";

/**
 * Verify a single receipt the way a third party would: reconstruct the public
 * key from the JWK and check the Ed25519 signature over the canonical payload.
 * @returns {import("../../src/types.d.ts").VerifyResult}
 */
export function verifyOne(receipt, publicKeyJwk) {
  return verifyReceipt(receipt, publicKeyFromJwk(publicKeyJwk));
}

/**
 * Rebuild the proof chain from the receipts alone (the same walk the
 * proof-integrity cron does): each receipt's proofChainHash must equal
 * sha256(prev | evidenceHash). Returns the index of the first break, or -1.
 */
export function findChainBreak(receipts) {
  let prev = GENESIS_PROOF_CHAIN_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const expected = computeProofChainHash({
      previousChainHash: prev,
      evidenceHash: receipts[i].evidenceHash,
    });
    if (expected !== receipts[i].proofChainHash) return i;
    prev = receipts[i].proofChainHash;
  }
  return -1;
}

/**
 * Run the three adversarial perturbations against a VERIFIED receipt (and its
 * chain). Each must be caught. Returns a structured result; the caller decides
 * the exit code.
 *
 * @param {object} verifiedReceipt a receipt that verifies clean
 * @param {object} publicKeyJwk
 * @param {Array<object>} chain the full receipt chain (for the chain tamper)
 */
export function runAdversarialChecks(verifiedReceipt, publicKeyJwk, chain) {
  // 1. Flip one byte of the signature → signature no longer validates.
  const sigTampered = structuredClone(verifiedReceipt);
  const s = sigTampered.signature;
  sigTampered.signature = (s[0] === "A" ? "B" : "A") + s.slice(1);
  const sigResult = verifyOne(sigTampered, publicKeyJwk);

  // 2. Edit a signed field (flip the decision) → canonical payload changes,
  //    signature no longer matches. You cannot rewrite the signed record.
  const fieldTampered = structuredClone(verifiedReceipt);
  fieldTampered.decision = fieldTampered.decision === "ALLOW" ? "DENY" : "ALLOW";
  const fieldResult = verifyOne(fieldTampered, publicKeyJwk);

  // 3. Corrupt a link in the chain → the rebuilt chain breaks at that record.
  const chainTampered = chain.map((r) => structuredClone(r));
  const mid = Math.floor(chainTampered.length / 2);
  chainTampered[mid].evidenceHash = "0".repeat(64); // recorded evidence altered
  const breakIdx = findChainBreak(chainTampered);

  return {
    signatureTamper: {
      caught: sigResult.status !== "VERIFIED" && sigResult.signatureValid === false,
      status: sigResult.status,
    },
    fieldTamper: {
      caught: fieldResult.status !== "VERIFIED" && fieldResult.signatureValid === false,
      status: fieldResult.status,
    },
    chainTamper: {
      caught: breakIdx !== -1,
      brokeAtIndex: breakIdx,
    },
  };
}
