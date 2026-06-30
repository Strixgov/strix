/**
 * ISCG v1 — barrel for the bearer-assertion signer + types.
 *
 * Contract: `docs/architecture/instance-scoped-capability-grants-v1.md`
 *           contractVersion 0.2.0.
 *
 * This barrel exposes the signer (CP-CAP-009 rollout step 1). The
 * verifier (rollout step 2) will export from the same barrel under
 * `verifier` once it ships.
 */

export {
  BEARER_ASSERTION_FIELDS_V1,
  BEARER_ASSERTION_CLOCK_SKEW_SECONDS_DEFAULT,
  BEARER_ASSERTION_CLOCK_SKEW_SECONDS_MAX,
  BEARER_ASSERTION_DEFAULT_TTL_SECONDS,
  BEARER_ASSERTION_MAX_TTL_SECONDS,
  BEARER_ASSERTION_NONCE_MIN_BITS,
  type BearerAssertionPayload,
  type BearerAssertionSignedEnvelope,
  type InstanceDenyReason,
  type IscgPrincipalType,
  type IscgVerifyContext,
} from "./types.js";

export {
  BEARER_ASSERTION_SIGNER_ERRORS,
  BearerAssertionSignerError,
  type BearerAssertionSignerErrorCode,
  type SignBearerAssertionInput,
  type SignBearerAssertionResult,
  signBearerAssertion,
  loadEd25519PrivateKeyFromPkcs8Der,
  canonicalizeJSON,
} from "./signer.js";
