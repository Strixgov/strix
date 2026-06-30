/**
 * `@strixgov/sdk/web` — browser-facing proof surface (Deliverable #3).
 *
 * The verdict is always reproduced client-side by the SDK verifier; the server
 * is transport only. Exposes the embeddable `<strix-proof-badge>` element, the
 * client-side verify helper, and the tri-state presentation mapping.
 */

export {
  defineStrixProofBadge,
  verifyBundleClientSide,
  badgeView,
} from "./strix-proof-badge.js";

// Re-export the public-summary block contract for server endpoints that render
// the ADR-018 §5 transaction block (privacy-safe; no private fields).
export {
  renderTransactionBlock,
  FORBIDDEN_PUBLIC_FIELDS,
  type TransactionBlock,
} from "../transaction-proof/transaction-block.js";
