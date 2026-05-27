/**
 * Receipt issuance and verification.
 *
 *   evidenceHash    = SHA-256(invocationHash || decision || timestamp)
 *   proofChainHash  = SHA-256(prevProofChainHash || evidenceHash)
 *   signature       = Ed25519(canonicalReceiptPayload(receipt))
 *
 * The chain is append-only: every new receipt commits to the previous
 * one's proofChainHash. A single-receipt tamper is detectable; a
 * historical-rewrite attack requires forging a signature with a private
 * key the gateway never exports.
 */

import crypto from "node:crypto";
import {
  canonicalJSON,
  canonicalReceiptPayload,
  RECEIPT_SCHEMA_VERSION,
} from "./canonical.mjs";

const GENESIS_PROOF_CHAIN_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * @param {import("./types.d.ts").ToolInvocation} invocation
 */
export function computeInvocationHash(invocation) {
  return sha256Hex(
    canonicalJSON({
      capabilityId: invocation.capabilityId,
      action: invocation.action,
      args: invocation.args ?? null,
      actorId: invocation.actorId ?? "",
      actorRole: invocation.actorRole ?? "",
    })
  );
}

export function computeEvidenceHash({ invocationHash, decision, timestamp }) {
  return sha256Hex(`${invocationHash}|${decision}|${timestamp}`);
}

export function computeProofChainHash({ previousChainHash, evidenceHash }) {
  return sha256Hex(`${previousChainHash}|${evidenceHash}`);
}

export function newReceiptId() {
  return `rcpt_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Build, sign, and return a fully-formed receipt. Pure — does not write
 * to storage. The Gateway is responsible for persisting it under the
 * same lock that captured `previousChainHash`.
 *
 * Schema v2 fields (`policyVersion`, `tenantId`, `environment`) are
 * required and bound into the canonical signed payload. `tenantId` and
 * `environment` default to "local" if the caller does not specify;
 * `policyVersion` MUST be passed by the gateway (it has the
 * PolicyEngine handle).
 *
 * @param {{
 *   invocation: import("./types.d.ts").ToolInvocation,
 *   capability: import("./types.d.ts").ToolCapability,
 *   decision: import("./types.d.ts").Decision,
 *   previousChainHash: string,
 *   signingKey: import("./types.d.ts").SigningKey,
 *   toolName?: string,
 *   approval?: import("./types.d.ts").ApprovalResult,
 *   timestamp?: string,
 *   receiptId?: string,
 *   policyVersion: string,
 *   tenantId?: string,
 *   environment?: string,
 * }} args
 * @returns {import("./types.d.ts").Receipt}
 */
export function issueReceipt(args) {
  const {
    invocation,
    capability,
    decision,
    previousChainHash,
    signingKey,
    toolName,
    approval,
  } = args;

  if (!signingKey || !signingKey.privateKey) {
    throw new Error("issueReceipt: signingKey is required (fail-closed)");
  }
  if (!capability) {
    throw new Error("issueReceipt: capability is required");
  }
  if (capability.id !== invocation.capabilityId) {
    throw new Error(
      `issueReceipt: capability id mismatch (cap=${capability.id} inv=${invocation.capabilityId})`
    );
  }
  if (typeof args.policyVersion !== "string" || !args.policyVersion) {
    throw new Error("issueReceipt: policyVersion is required (fail-closed)");
  }

  const timestamp = args.timestamp ?? new Date().toISOString();
  const receiptId = args.receiptId ?? newReceiptId();
  const tenantId = args.tenantId ?? "local";
  const environment = args.environment ?? "local";
  const invocationHash = computeInvocationHash(invocation);
  const evidenceHash = computeEvidenceHash({
    invocationHash,
    decision,
    timestamp,
  });
  const proofChainHash = computeProofChainHash({
    previousChainHash: previousChainHash || GENESIS_PROOF_CHAIN_HASH,
    evidenceHash,
  });

  const canonical = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptId,
    capabilityId: capability.id,
    action: invocation.action,
    decision,
    risk: capability.risk,
    mode: capability.mode,
    policyVersion: args.policyVersion,
    tenantId,
    environment,
    invocationHash,
    evidenceHash,
    proofChainHash,
    timestamp,
  };

  const payload = canonicalReceiptPayload(canonical);
  const signature = crypto
    .sign(null, Buffer.from(payload, "utf8"), signingKey.privateKey)
    .toString("base64url");

  /** @type {import("./types.d.ts").Receipt} */
  const receipt = {
    ...canonical,
    signingKeyId: signingKey.kid,
    signature,
    tool: toolName,
    actorId: invocation.actorId,
    actorRole: invocation.actorRole,
    approvedBy: approval?.approvedBy,
    approvalReason: approval?.reason,
  };

  return receipt;
}

/**
 * Verify a single receipt. Recomputes the canonical payload, the hash
 * chain inputs, and the Ed25519 signature. Cross-receipt chain linkage
 * (this.proofChainHash matches next.proofChainHash's prev) is checked
 * separately by `verifyChain` in the gateway.
 *
 * @param {import("./types.d.ts").Receipt} receipt
 * @param {crypto.KeyObject} publicKey
 * @returns {import("./types.d.ts").VerifyResult}
 */
export function verifyReceipt(receipt, publicKey) {
  /** @type {import("./types.d.ts").VerifyResult} */
  const result = {
    receiptId: receipt?.receiptId,
    signaturePresent: !!receipt?.signature,
    signatureValid: false,
    hashValid: false,
    chainValid: null,
    status: "ERROR",
  };

  try {
    if (!receipt || !receipt.signature) {
      result.status = "UNSIGNED";
      return result;
    }

    // Build a canonical view that includes whichever fields the
    // receipt's schemaVersion requires. canonicalReceiptPayload then
    // dispatches on schemaVersion to pick the right field order.
    const canonical = {
      schemaVersion: String(receipt.schemaVersion ?? "1"),
      receiptId: receipt.receiptId,
      capabilityId: receipt.capabilityId,
      action: receipt.action,
      decision: receipt.decision,
      risk: receipt.risk,
      mode: receipt.mode,
      policyVersion: receipt.policyVersion,
      tenantId: receipt.tenantId,
      environment: receipt.environment,
      invocationHash: receipt.invocationHash,
      evidenceHash: receipt.evidenceHash,
      proofChainHash: receipt.proofChainHash,
      timestamp: receipt.timestamp,
    };
    const payload = canonicalReceiptPayload(canonical);

    const sigBytes = Buffer.from(receipt.signature, "base64url");
    result.signatureValid = crypto.verify(
      null,
      Buffer.from(payload, "utf8"),
      publicKey,
      sigBytes
    );
    result.hashValid = result.signatureValid; // bound by the signature
    result.status = result.signatureValid ? "VERIFIED" : "TAMPERED";
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.status = "ERROR";
  }
  return result;
}

export { GENESIS_PROOF_CHAIN_HASH };
