/**
 * @strixgov/sdk
 *
 * The open **proof** surface of Strix (MIT). Verify governed-action receipts,
 * decision tokens, and actor attestations against the public JWKS — without
 * trusting Strix. Canonicalization, schemas, receipt signing, JWKS resolution,
 * and the verification badge live here.
 *
 * The **control** surface — the policy engine, decision-token minting,
 * simulation, resolution pipeline, agent runtime, and enforcement middleware —
 * is the closed core `@strixgov/governance-core` ("operated, not shipped").
 *
 * Boundary invariant: anyone can VERIFY a receipt with only this package + the
 * public JWKS; no export here can MINT a decision token or make a policy
 * decision.
 *
 * @example
 * ```typescript
 * import { verifyActorAttestation, canonicalizePayload, validateToken } from '@strixgov/sdk';
 * // ...verify a receipt/token/attestation offline against the public key.
 * ```
 */

// ─── Token Standard (verification / parsing) ───────────────────────
// Minting (createPayload / signToken / serializeToken) moved to the closed
// control core (@strixgov/governance-core). This package can VERIFY a decision
// token; only the control plane can MINT one.
export {
  deserializeToken,
  verifySignature,
  validateToken,
  canonicalizePayload,
  sha256,
  TokenFormatError,
} from "./token/sdt.js";
export type { TokenValidationResult } from "./token/sdt.js";

// ─── Evidence (v1) ─────────────────────────────────────────────────
export {
  buildExecutionRecord,
  computeRecordHash,
  verifyRecordIntegrity,
  MemoryEvidenceSink,
  FileEvidenceSink,
  createEvidenceSink,
} from "./evidence/evidence.js";

// ─── AA-1 (Actor Attestation v1) — PR 1C.2 ─────────────────────────
// Flag-gated via STRIX_ACTOR_ATTESTATION_V1; dormant when OFF.
// See docs/architecture/actor-attestation-v1.md (contractVersion 1.0.0)
// and docs/gates/AA-1-PR-1C2-IMPLEMENTATION-PLAN.md.
export {
  resolveAgentKeyRegistry,
  AgentKeyRegistryCollisionError,
  AgentKeyEnvParseError,
  parseAgentKeyRegistryEnv,
  createDefaultChainVerifier,
  ChainVerifierUnavailableError,
  CHAIN_VERIFIER_ERRORS,
} from "./agents/index.js";
export type {
  ResolveAgentKeyRegistryOptions,
  ResolveAgentKeyRegistryResult,
  CreateDefaultChainVerifierOptions,
  ChainVerifierUnavailableReason,
  // From agents/loader.ts (re-exported via agents/index.js)
  AgentKeyEntryInput,
  ChainVerifier,
  ChainVerificationOutcome,
  RevocationCheck,
  Ed25519JwkMirror,
  OperationalKeyAttestationMirror,
  LoadAgentKeysOptions,
  LoadAgentKeysResult,
  RejectedEntry,
  AgentLoaderErrorCode,
  // From agents/registry.ts (re-exported via agents/index.js)
  AgentPublicKeyJwk,
  RegisteredAgentKey,
  AgentKeyRegistry,
} from "./agents/index.js";
export {
  // Runtime values from agents/loader.ts / registry.ts that are useful
  // to external callers (signer, verifier, JWKS endpoint).
  isAgentAttestationFlagOn,
  isRevocationDistributionFlagOn,
  isStrictRfc3339Mirror,
  loadAgentKeyRegistry,
  EMPTY_AGENT_KEY_LOAD_RESULT,
  AGENT_LOADER_ERRORS,
  EMPTY_AGENT_KEY_REGISTRY,
  InMemoryAgentKeyRegistry,
  parseAgentKid,
  AgentKidFormatError,
  AgentIdMismatchError,
  AgentKidCollisionError,
} from "./agents/index.js";
export {
  signActorAttestation,
  ActorAttestationSignerError,
  ACTOR_ATTESTATION_SIGNER_ERRORS,
  ATTESTATION_CLOCK_SKEW_SECONDS,
  signAgentBearerAssertion,
  verifyAgentBearerAssertion,
  BearerAssertionError,
  BEARER_ASSERTION_ERRORS,
  DEFAULT_TTL_SECONDS as BEARER_ASSERTION_DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS as BEARER_ASSERTION_MAX_TTL_SECONDS,
  sha256HexOfCanonical,
  canonicalizeJSON as canonicalizeJSONScjV1Mirror,
  CanonicalJsonError as ScjV1MirrorError,
  CANONICAL_JSON_ERRORS as SCJ_V1_MIRROR_ERRORS,
  SCJ_VERSION as SCJ_V1_MIRROR_VERSION,
  // AA-1 PR 1C.3 — verifier + credential-class matrix + revocation check.
  verifyActorAttestation,
  ACTOR_CLASS_REASONS,
  CLOCK_SKEW_WINDOW_MS as ACTOR_ATTESTATION_CLOCK_SKEW_WINDOW_MS,
  RULE_NAMES as ACTOR_ATTESTATION_RULE_NAMES,
  CREDENTIAL_CLASS_MATRIX,
  isCredentialClassConsistent,
  isAgentKidRevokedAtOrAfter,
  EMPTY_REVOCATION_LIST,
  REVOCATION_LIST_VERSION_MIRROR,
} from "./actor-attestation/index.js";
export type {
  SignActorAttestationInput,
  SignActorAttestationContext,
  SignActorAttestationResult,
  EvidenceContextForAttestation,
  ActorAttestationSignerErrorCode,
  BearerAssertionPayload,
  BearerAssertionHeader,
  SignAgentBearerAssertionInput,
  SignedBearerAssertion,
  VerifyAgentBearerAssertionOptions,
  VerifiedBearerAssertion,
  NonceStore,
  BearerAssertionGeneratorOptions,
  BearerAssertionErrorCode,
  // AA-1 PR 1C.3 — verifier types.
  VerifiedClass,
  RuleOutcome,
  RuleName,
  VerifierInput,
  VerifierOutcome,
  VerifierEvidenceContext,
  SignedRevocationList as ActorAttestationSignedRevocationList,
  RevocationEntryMirror as ActorAttestationRevocationEntry,
} from "./actor-attestation/index.js";

// AA-1 v1 schema types — published from the SDK's attestation/types.ts
// (frozen in PR 1A). Locked field order; do not reorder.
//
// NOTE: `ActorType` is re-exported from the v2 graph block below (same
// {"agent","human","system"} string-literal union; intentional alignment
// between Graph + AA-1). Re-exporting it twice triggers TS2300.
export type {
  CredentialClass,
  ActorAttestationPayload,
  ActorAttestationSignedEnvelope,
  ActorAttestationRecord,
  ActorClassReason,
  ActorClassBlock,
} from "./attestation/types.js";
export { credentialClassMatchesActor } from "./attestation/types.js";

// Middleware (express / trpc enforcement wrappers) moved to the closed control
// core (@strixgov/governance-core).

// ─── Types (v1) ────────────────────────────────────────────────────
export type {
  SDTPayload,
  StrixDecisionToken,
  StrixGovernanceConfig,
  PolicyEngineConfig,
  LocalCapabilityDef,
  EvidenceSinkConfig,
  PolicyEngine,
  DecisionRequest,
  DecisionResult,
  EvidenceSink,
  ExecutionRecord,
  GovernedActionOptions,
  GovernedContext,
  RedemptionResult,
  SimulationInput,
  SimulationResult,
} from "./types.js";

// ─── Types (v2 — Graph) ───────────────────────────────────────────
export type {
  RiskLevel,
  Environment,
  EffectType,
  ApprovalMode,
  ActorType,
  CapabilityNode,
  ResolvedCapability,
  ActionProposal,
  DecisionStatus,
  GraphDecisionResult,
  ExecutionTokenClaims,
  GraphEvidenceRecord,
  ApprovalRecord,
  GovernanceProfile,
} from "./graph/types.js";
