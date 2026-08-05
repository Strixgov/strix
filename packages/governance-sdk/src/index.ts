/**
 * @strixgov/sdk
 *
 * The open proof surface of Strix (MIT). Verification helpers only; control-plane
 * policy decisions and token minting remain outside this package.
 */

export { deserializeToken, verifySignature, validateToken, canonicalizePayload, sha256, TokenFormatError } from "./token/sdt.js";
export type { TokenValidationResult } from "./token/sdt.js";

export { buildExecutionRecord, computeRecordHash, verifyRecordIntegrity, MemoryEvidenceSink, FileEvidenceSink, createEvidenceSink } from "./evidence/evidence.js";

// Signed Evidence v1 truthful verification contract (R3).
export { SE_V1_SIGNATURE_ALGORITHM, EVIDENCE_VERIFICATION_CONTRACT_VERSION, isFullyVerified } from "./evidence/verification-contract.js";
export type { VerificationLayerStatus, EvidenceVerificationStatus, VerificationCheck, EvidenceVerificationContractV2 } from "./evidence/verification-contract.js";

export { resolveAgentKeyRegistry, AgentKeyRegistryCollisionError, AgentKeyEnvParseError, parseAgentKeyRegistryEnv, createDefaultChainVerifier, ChainVerifierUnavailableError, CHAIN_VERIFIER_ERRORS } from "./agents/index.js";
export type { ResolveAgentKeyRegistryOptions, ResolveAgentKeyRegistryResult, CreateDefaultChainVerifierOptions, ChainVerifierUnavailableReason, AgentKeyEntryInput, ChainVerifier, ChainVerificationOutcome, RevocationCheck, Ed25519JwkMirror, OperationalKeyAttestationMirror, LoadAgentKeysOptions, LoadAgentKeysResult, RejectedEntry, AgentLoaderErrorCode, AgentPublicKeyJwk, RegisteredAgentKey, AgentKeyRegistry } from "./agents/index.js";
export { isAgentAttestationFlagOn, isRevocationDistributionFlagOn, isStrictRfc3339Mirror, loadAgentKeyRegistry, EMPTY_AGENT_KEY_LOAD_RESULT, AGENT_LOADER_ERRORS, EMPTY_AGENT_KEY_REGISTRY, InMemoryAgentKeyRegistry, parseAgentKid, AgentKidFormatError, AgentIdMismatchError, AgentKidCollisionError } from "./agents/index.js";
export { signActorAttestation, ActorAttestationSignerError, ACTOR_ATTESTATION_SIGNER_ERRORS, ATTESTATION_CLOCK_SKEW_SECONDS, signAgentBearerAssertion, verifyAgentBearerAssertion, BearerAssertionError, BEARER_ASSERTION_ERRORS, DEFAULT_TTL_SECONDS as BEARER_ASSERTION_DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS as BEARER_ASSERTION_MAX_TTL_SECONDS, sha256HexOfCanonical, canonicalizeJSON as canonicalizeJSONScjV1Mirror, CanonicalJsonError as ScjV1MirrorError, CANONICAL_JSON_ERRORS as SCJ_V1_MIRROR_ERRORS, SCJ_VERSION as SCJ_V1_MIRROR_VERSION, verifyActorAttestation, ACTOR_CLASS_REASONS, CLOCK_SKEW_WINDOW_MS as ACTOR_ATTESTATION_CLOCK_SKEW_WINDOW_MS, RULE_NAMES as ACTOR_ATTESTATION_RULE_NAMES, CREDENTIAL_CLASS_MATRIX, isCredentialClassConsistent, isAgentKidRevokedAtOrAfter, EMPTY_REVOCATION_LIST, REVOCATION_LIST_VERSION_MIRROR } from "./actor-attestation/index.js";
export type { SignActorAttestationInput, SignActorAttestationContext, SignActorAttestationResult, EvidenceContextForAttestation, ActorAttestationSignerErrorCode, BearerAssertionPayload, BearerAssertionHeader, SignAgentBearerAssertionInput, SignedBearerAssertion, VerifyAgentBearerAssertionOptions, VerifiedBearerAssertion, NonceStore, BearerAssertionGeneratorOptions, BearerAssertionErrorCode, VerifiedClass, RuleOutcome, RuleName, VerifierInput, VerifierOutcome, VerifierEvidenceContext, SignedRevocationList as ActorAttestationSignedRevocationList, RevocationEntryMirror as ActorAttestationRevocationEntry } from "./actor-attestation/index.js";
export type { CredentialClass, ActorAttestationPayload, ActorAttestationSignedEnvelope, ActorAttestationRecord, ActorClassReason, ActorClassBlock } from "./attestation/types.js";
export { credentialClassMatchesActor } from "./attestation/types.js";

export type { SDTPayload, StrixDecisionToken, StrixGovernanceConfig, PolicyEngineConfig, LocalCapabilityDef, EvidenceSinkConfig, PolicyEngine, DecisionRequest, DecisionResult, EvidenceSink, ExecutionRecord, GovernedActionOptions, GovernedContext, RedemptionResult, SimulationInput, SimulationResult } from "./types.js";
export type { RiskLevel, Environment, EffectType, ApprovalMode, ActorType, CapabilityNode, ResolvedCapability, ActionProposal, DecisionStatus, GraphDecisionResult, ExecutionTokenClaims, GraphEvidenceRecord, ApprovalRecord, GovernanceProfile } from "./graph/types.js";
