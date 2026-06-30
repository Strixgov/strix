/**
 * @strixgov/sdk — Agent Swarm v1 (the Delegation Kernel) barrel.
 *
 * Contract: `docs/architecture/agent-swarm-v1.md` contractVersion 0.2.0.
 *
 * Exposes the SW-2/SW-5 attenuation algebra, the three signers
 * (swarm_run_v1 / swarm_delegation_v1 / swarm_action_evidence_v1), and the
 * DI'd verifier that re-derives the `swarm` integrity block (SW-1…SW-5). Golden
 * vectors live under `tests/golden-vectors/swarm_v1/`.
 */

export {
  type RiskLevel,
  type SwarmAuthority,
  type AttenuationReason,
  type AttenuationResult,
  attenuates,
  attenuatesPath,
  toSwarmIntegrityReason,
  checkBudget,
} from "./attenuation.js";

export {
  type SwarmRunPayload,
  type SwarmRunEnvelope,
  type SwarmDelegationPayload,
  type SwarmDelegationEnvelope,
  type SwarmActionEvidencePayload,
  type SwarmActionEvidenceEnvelope,
  type SwarmIntegrityReason,
  SWARM_INTEGRITY_REASONS,
} from "./types.js";

export {
  SWARM_SIGNER_ERRORS,
  type SwarmSignerErrorCode,
  SwarmSignerError,
  type SignSwarmRunInput,
  type SignSwarmRunResult,
  signSwarmRun,
  type SignSwarmDelegationInput,
  type SignSwarmDelegationResult,
  signSwarmDelegation,
  type SignSwarmActionEvidenceInput,
  type SignSwarmActionEvidenceResult,
  signSwarmActionEvidence,
} from "./signer.js";

export { isAgentSwarmFlagOn } from "./flag.js";

export {
  type DelegatorKeyResolver,
  type SwarmChainVerifyInput,
  type SwarmChainVerifyResult,
  verifySwarmDelegationChain,
  type ActionAttributionInput,
  type ActionAttributionResult,
  verifyActionAttribution,
} from "./verifier.js";
