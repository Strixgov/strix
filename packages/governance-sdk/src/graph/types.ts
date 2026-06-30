/**
 * @strixgov/sdk — Capability Graph Types
 *
 * The Capability Graph models execution authority as a graph, not a list.
 * Each capability is a node carrying its own constraints, risk level,
 * approval requirements, and actor/environment restrictions.
 *
 * Graph semantics:
 *   - Parent/child inheritance (children inherit parent defaults)
 *   - Constraint refinement (children narrow parent scope)
 *   - Approval escalation (deeper nodes may require stricter approval)
 *   - Workflow dependency (some actions require prior states)
 */

// ─── Enums ─────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type Environment = "dev" | "staging" | "prod";
export type EffectType = "read" | "write" | "publish" | "financial" | "admin" | "destructive";
export type ApprovalMode = "none" | "single" | "dual" | "policy_only";
export type ActorType = "human" | "agent" | "system";

// ─── Capability Node ───────────────────────────────────────────────

/**
 * A single node in the Capability Graph.
 *
 * This is the fundamental unit of execution authority in Strix.
 * Actions are primary — the graph models what actions exist,
 * their risk, their constraints, and who may propose or approve them.
 */
export interface CapabilityNode {
  /** Unique capability identifier (e.g., "payment.refund.over_50") */
  id: string;
  /** Parent capability ID for inheritance (e.g., "payment.refund") */
  parentId?: string;
  /** Human-readable label */
  label: string;
  /** Detailed description of what this capability authorizes */
  description: string;

  /** The type of side effect this action produces */
  effectType: EffectType;
  /** Whether the action can be reversed */
  reversible: boolean;
  /** Risk classification */
  riskLevel: RiskLevel;

  /** Actor roles allowed to propose this action */
  allowedActors: string[];
  /** Actor roles allowed to approve this action */
  allowedApprovers?: string[];
  /** Environments where this capability may execute */
  allowedEnvironments: Environment[];

  /** Approval mode for this capability */
  approvalMode: ApprovalMode;
  /** Arbitrary constraints (e.g., maxAmount, maxRecipients) */
  constraints?: Record<string, unknown>;

  /** Capability IDs that must be completed before this one */
  dependsOn?: string[];

  /** Whether evidence is mandatory for this capability */
  requiresEvidence: boolean;
  /** Whether a cryptographic token is required for execution */
  requiresToken: boolean;

  /** Tags for filtering and grouping (e.g., ["payments", "template"]) */
  tags?: string[];
}

// ─── Resolved Capability ───────────────────────────────────────────

/**
 * A capability after graph resolution — parent defaults merged,
 * constraints evaluated, and the full inheritance chain resolved.
 */
export interface ResolvedCapability {
  /** The resolved capability node (merged with parent defaults) */
  node: CapabilityNode;
  /** The full inheritance chain from root to this node */
  inheritanceChain: string[];
  /** The effective risk level after inheritance */
  effectiveRiskLevel: RiskLevel;
  /** The effective approval mode after inheritance */
  effectiveApprovalMode: ApprovalMode;
  /** The effective allowed actors (intersection of chain) */
  effectiveActors: string[];
  /** The effective allowed approvers */
  effectiveApprovers: string[];
  /** The effective allowed environments (intersection of chain) */
  effectiveEnvironments: Environment[];
  /** Whether evidence is required at any point in the chain */
  effectiveRequiresEvidence: boolean;
  /** Whether a token is required at any point in the chain */
  effectiveRequiresToken: boolean;
  /** All constraints merged from the inheritance chain */
  effectiveConstraints: Record<string, unknown>;
  /** Unmet dependencies */
  unmetDependencies: string[];
}

// ─── Action Proposal ───────────────────────────────────────────────

/**
 * A proposal to execute a governed action.
 *
 * Agents, humans, and systems all enter Strix through proposals.
 * No actor executes directly — they propose, and the kernel decides.
 */
export interface ActionProposal {
  /** Unique proposal identifier */
  proposalId: string;
  /** The capability being requested */
  capabilityId: string;

  /** The actor requesting execution */
  actorId: string;
  /** The type of actor (human, agent, or system) */
  actorType: ActorType;
  /** The actor's role (e.g., "admin-user", "support-agent") */
  actorRole: string;

  /** The tenant this action applies to */
  tenantId: string;
  /** The environment where execution is requested */
  environment: Environment;

  /** The type of target entity (e.g., "member", "payment", "post") */
  targetType: string;
  /** The specific target entity ID */
  targetId: string;

  /** Action-specific payload (e.g., { amount: 120, reason: "duplicate" }) */
  payload: Record<string, unknown>;
  /** Human-readable justification for the action */
  justification?: string;

  /** Correlation ID for linking related proposals */
  correlationId?: string;
  /** ISO 8601 timestamp of when the proposal was created */
  requestedAt: string;

  // ── Lifecycle State Machine ──────────────────────────────────────

  /** Current lifecycle state of this proposal */
  lifecycleState?: ProposalLifecycleState;
  /** Ordered history of state transitions */
  stateHistory?: ProposalStateTransition[];
}

// ─── Proposal Lifecycle State Machine ──────────────────────────────

/**
 * The explicit lifecycle states a proposal moves through.
 *
 * State transitions:
 *   proposed → pending_approval → approved → token_issued → executed
 *   proposed → denied
 *   proposed → pending_approval → denied
 *   proposed → pending_approval → approved → token_issued → expired
 *   proposed → pending_approval → approved → token_issued → replayed
 *   proposed → pending_approval → cancelled
 *
 * Every transition generates an evidence record.
 */
export type ProposalLifecycleState =
  | "proposed"         // Initial state — proposal submitted
  | "evaluating"       // Pipeline is processing constraints/policy
  | "pending_approval" // Waiting for human approval(s)
  | "approved"         // All approvals received
  | "token_issued"     // Execution token has been generated
  | "executing"        // Handler is running
  | "executed"         // Handler completed successfully
  | "execution_failed" // Handler threw an error
  | "denied"           // Blocked by policy, constraints, or approver
  | "expired"          // Token expired before execution
  | "replayed"         // Token replay attempt detected
  | "cancelled";       // Manually cancelled before execution

/**
 * A state transition record for the proposal lifecycle.
 */
export interface ProposalStateTransition {
  /** Previous state */
  from: ProposalLifecycleState;
  /** New state */
  to: ProposalLifecycleState;
  /** ISO 8601 timestamp of the transition */
  timestamp: string;
  /** Actor who caused the transition (system, human, or agent ID) */
  triggeredBy: string;
  /** Human-readable reason for the transition */
  reason: string;
}

// ─── Decision Result ───────────────────────────────────────────────

export type DecisionStatus =
  | "approved"
  | "denied"
  | "approval_required"
  | "expired"
  | "replayed";

/**
 * The result of processing a proposal through the resolution pipeline.
 */
export interface GraphDecisionResult {
  /** The proposal that was evaluated */
  proposalId: string;
  /** The capability that was resolved */
  capabilityId: string;
  /** The decision status */
  status: DecisionStatus;

  /** The resolved risk level after graph resolution */
  resolvedRiskLevel: RiskLevel;
  /** Human-readable reasons for the decision */
  reasons: string[];

  /** Whether approval is required before execution */
  approvalRequired: boolean;
  /** The execution token ID (only present when approved) */
  tokenId?: string;
  /** Token expiration (ISO 8601) */
  tokenExpiresAt?: string;

  /** The evidence record ID for this decision */
  evidenceId: string;
}

// ─── Execution Token Claims ────────────────────────────────────────

/**
 * Claims embedded in an execution token.
 * Tokens are single-use, short-lived, and bound to a specific
 * capability, actor, tenant, target, and environment.
 */
export interface ExecutionTokenClaims {
  /** Unique token identifier */
  tokenId: string;
  /** The proposal that authorized this token */
  proposalId: string;
  /** The capability being authorized */
  capabilityId: string;

  /** The actor authorized to execute */
  actorId: string;
  /** The tenant scope */
  tenantId: string;
  /** The environment where execution is authorized */
  environment: Environment;

  /** The type of target entity */
  targetType: string;
  /** The specific target entity */
  targetId: string;

  /** ISO 8601 issuance timestamp */
  issuedAt: string;
  /** ISO 8601 expiration timestamp */
  expiresAt: string;
  /** Single-use nonce for replay protection */
  nonce: string;
}

// ─── Graph Evidence Record ─────────────────────────────────────────

/**
 * An evidence record produced by the capability graph pipeline.
 * Every decision — approved, denied, blocked, or executed — generates evidence.
 */
export interface GraphEvidenceRecord {
  /** Unique evidence identifier */
  evidenceId: string;
  /** The proposal that triggered this evidence */
  proposalId: string;
  /** The capability that was evaluated */
  capabilityId: string;

  /** The actor who proposed the action */
  actorId: string;
  /** The tenant scope */
  tenantId: string;
  /** The environment */
  environment: Environment;

  /** The decision status */
  decisionStatus: DecisionStatus;
  /** Human-readable reasons */
  reasons: string[];

  /** The execution token ID (if issued) */
  tokenId?: string;
  /** The execution outcome (if execution was attempted) */
  executionStatus?: "not_executed" | "executed" | "execution_failed";

  /** SHA-256 hash of the proposal payload */
  payloadHash: string;
  /** SHA-256 hash of this evidence record (tamper detection) */
  evidenceHash: string;

  /** ISO 8601 timestamp */
  createdAt: string;
}

// ─── Approval Record ───────────────────────────────────────────────

/**
 * A record of an approval or denial by an approver.
 */
export interface ApprovalRecord {
  /** Unique approval record ID */
  approvalId: string;
  /** The proposal being approved/denied */
  proposalId: string;
  /** The approver's actor ID */
  approverId: string;
  /** The approver's role */
  approverRole: string;
  /** The decision */
  decision: "approve" | "deny";
  /** Reason for denial (if denied) */
  reason?: string;
  /** ISO 8601 timestamp */
  decidedAt: string;
}

// ─── Governance Profile ────────────────────────────────────────────

/**
 * A governance profile is a pre-built set of capability nodes
 * for a specific vertical. Verticals don't author capabilities
 * from scratch — they select a profile and customize.
 */
export interface GovernanceProfile {
  /** Profile identifier (e.g., "fitness-default") */
  profileId: string;
  /** Human-readable name */
  name: string;
  /** Description of the vertical this profile serves */
  description: string;
  /** The capability nodes in this profile */
  capabilities: CapabilityNode[];
  /** Pack IDs that compose this profile (for traceability) */
  packIds?: string[];
  /** Domain vocabulary mapping for this profile */
  vocabulary: Record<string, string>;
}
