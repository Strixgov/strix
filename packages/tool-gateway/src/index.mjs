/**
 * @strixgov/tool-gateway — public API surface.
 *
 * Stable entry points for embedding the gateway:
 *
 *   import { createGateway, JsonlStorage, loadOrCreateSigningKey }
 *     from "@strixgov/tool-gateway";
 *
 * Adapters live under subpath exports:
 *
 *   import { fsCapabilities, governedFs }
 *     from "@strixgov/tool-gateway/adapters/filesystem";
 */

export { Gateway, createGateway } from "./gateway.mjs";
export {
  PolicyEngine,
  validateRuleset,
  computePolicyVersion,
} from "./policy.mjs";
export {
  issueReceipt,
  verifyReceipt,
  computeInvocationHash,
  computeEvidenceHash,
  computeProofChainHash,
  GENESIS_PROOF_CHAIN_HASH,
} from "./receipts.mjs";
export {
  canonicalReceiptPayload,
  canonicalJSON,
  RECEIPT_FIELD_ORDER,
  RECEIPT_FIELD_ORDER_V1,
  RECEIPT_FIELD_ORDER_V2,
  RECEIPT_SCHEMA_VERSION,
} from "./canonical.mjs";
export {
  loadOrCreateSigningKey,
  generateSigningKey,
  signingKeyFromPair,
  publicKeyFromJwk,
  DEFAULT_KEY_DIR,
} from "./keys.mjs";
export {
  KeyRing,
  loadOrCreateKeyRing,
} from "./keyring.mjs";
export {
  JsonlStorage,
  MemoryStorage,
  DEFAULT_STORAGE_DIR,
} from "./storage.mjs";
export {
  terminalApprove,
  fileApprover,
  webhookApprover,
  verifyWebhookSignature,
  alwaysDenyApprover,
  fixedApprover,
  DEFAULT_TIMEOUT_MS,
} from "./approval.mjs";
export {
  RateLimiter,
} from "./rate-limit.mjs";
export {
  ConnectedSyncer,
  WIRE_VERSION,
} from "./connected-mode.mjs";
export {
  issueSnapshot,
  verifySnapshot,
  canonicalSnapshotPayload,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_FIELD_ORDER,
} from "./snapshots.mjs";
export {
  saveCapabilityRegistry,
  loadCapabilityRegistry,
  watchCapabilityRegistry,
  REGISTRY_SCHEMA_VERSION,
  DEFAULT_REGISTRY_PATH,
} from "./registry.mjs";
