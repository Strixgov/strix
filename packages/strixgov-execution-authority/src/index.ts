export { canonicalJson, canonicalSha256, sha256Hex, CANONICALIZATION } from './canonical.js';
export {
  BOUND_FIELDS, CAPABILITY, CONTRACT, GRANT_PAYLOAD_KEYS, PROPOSAL_CONTRACT,
  buildProposal, currentExecutionOf, proposalProblem,
  type BoundField, type CurrentExecution, type GrantPayload, type ProposedExecution, type SignedGrant,
} from './contract.js';
export { GRANT_REFUSALS, grantShapeProblem, verifyGrant, type GrantRefusal, type GrantVerification } from './grant.js';
export {
  DEFAULT_MAX_LIFETIME_MS, KEY_PURPOSE, REVOCATION_CONTRACT,
  keysFromKeySetDocument, spkiFromJwkX, trustFromDocuments, verifyRevocationDocument,
  type AuthorityTrust, type Revocations, type RevocationDocument, type RevocationVerdict, type TrustedKey,
} from './trust.js';
export {
  StrixExecutionAuthorityClient, StrixUnavailableError,
  type ClientOptions, type EvaluateResult, type OutcomeReport, type OutcomeResult, type RedeemResult,
} from './client.js';
export { executeGoverned, governedTool, type ExecuteGovernedInput, type GovernedOutcome, type GovernedTool } from './adapter.js';
