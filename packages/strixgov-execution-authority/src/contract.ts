/**
 * The `strix-execution-authority-v1` contract as the CONSUMER sees it: the
 * proposal it sends, the grant it receives, and the execution it presents.
 *
 * Strix compares commitments; it never observes a payload or a state. The
 * consumer computes `payloadCommitment` over the exact bytes its handler will
 * act on and `currentStateCommitment` over the standing it read, and presents
 * both again at redemption. Any drift between what was proposed and what is
 * about to run is a different execution, and the grant does not cover it.
 */
export const CONTRACT = 'strix-execution-authority-v1' as const;
export const PROPOSAL_CONTRACT = 'execution-proposal-v1' as const;
export const CAPABILITY = 'execution.authority.grant' as const;

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface ProposedExecution {
  contractVersion: typeof PROPOSAL_CONTRACT;
  proposalId: string;
  tenantId: string;
  principalId: string;
  action: string;
  consequenceId: string;
  executionRoute: string;
  payloadCommitment: string;
  currentStateCommitment: string;
  proposedAt: string;
}

/** The eight fields a grant binds and a consumer presents at redemption. */
export const BOUND_FIELDS = [
  'tenantId', 'principalId', 'proposalId', 'action', 'consequenceId', 'executionRoute',
  'payloadCommitment', 'currentStateCommitment',
] as const;
export type BoundField = (typeof BOUND_FIELDS)[number];
export type CurrentExecution = Pick<ProposedExecution, BoundField>;

export const GRANT_PAYLOAD_KEYS = [
  'schemaVersion', 'grantId', 'issuer', 'signingKeyId', 'tenantId', 'principalId', 'proposalId', 'action',
  'consequenceId', 'executionRoute', 'payloadCommitment', 'currentStateCommitment', 'strixDecisionId',
  'strixCapabilityId', 'approvalsRequired', 'approvalsGranted', 'issuedAt', 'notBefore', 'expiresAt', 'singleUse',
] as const;

export interface GrantPayload extends CurrentExecution {
  schemaVersion: typeof CONTRACT;
  grantId: string;
  issuer: string;
  signingKeyId: string;
  strixDecisionId: string;
  strixCapabilityId: typeof CAPABILITY;
  approvalsRequired: number;
  approvalsGranted: number;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  singleUse: true;
}

export interface SignedGrant {
  payload: GrantPayload;
  signature: string;
  algorithm: 'Ed25519';
  canonicalization: 'strix-canonical-json-v1';
}

export function isId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}
export function isHex64(v: unknown): v is string {
  return typeof v === 'string' && HEX64_RE.test(v);
}
export function isLabel(v: unknown, max = 256): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
}
export function isInstant(v: unknown): v is string {
  return typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
}

/** Build a proposal from the consumer's own facts. Throws on a malformed field, before anything is sent. */
export function buildProposal(input: Omit<ProposedExecution, 'contractVersion' | 'proposedAt'> & { proposedAt?: Date }): ProposedExecution {
  const p: ProposedExecution = {
    contractVersion: PROPOSAL_CONTRACT,
    proposalId: input.proposalId,
    tenantId: input.tenantId,
    principalId: input.principalId,
    action: input.action,
    consequenceId: input.consequenceId,
    executionRoute: input.executionRoute,
    payloadCommitment: input.payloadCommitment,
    currentStateCommitment: input.currentStateCommitment,
    proposedAt: (input.proposedAt ?? new Date()).toISOString(),
  };
  const problem = proposalProblem(p);
  if (problem) throw new Error(`PROPOSAL_INVALID: ${problem}`);
  return p;
}

export function proposalProblem(p: unknown): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'proposal is not an object';
  const o = p as Record<string, unknown>;
  if (o.contractVersion !== PROPOSAL_CONTRACT) return 'unsupported contractVersion';
  for (const k of ['proposalId', 'action', 'consequenceId'] as const) if (!isId(o[k])) return `${k} is malformed`;
  for (const k of ['tenantId', 'principalId', 'executionRoute'] as const) if (!isLabel(o[k])) return `${k} is malformed`;
  for (const k of ['payloadCommitment', 'currentStateCommitment'] as const) if (!isHex64(o[k])) return `${k} is not a 64-hex hash`;
  if (!isInstant(o.proposedAt)) return 'proposedAt is not an ISO instant';
  return null;
}

/** The execution a consumer is about to perform, in the shape a grant binds. */
export function currentExecutionOf(p: ProposedExecution | GrantPayload): CurrentExecution {
  return Object.fromEntries(BOUND_FIELDS.map((k) => [k, p[k]])) as unknown as CurrentExecution;
}
