/**
 * @strixgov/sdk — Core Type Definitions
 *
 * Defines the Strix Decision Token (SDT) standard, configuration,
 * evidence records, and all public interfaces.
 */

// ─── Strix Decision Token (SDT) Standard ────────────────────────────

/**
 * The Strix Decision Token payload.
 * This is the standardized format for all governance decision tokens.
 */
export interface SDTPayload {
  /** The capability being authorized (e.g., "academy.program.delete") */
  capabilityId: string;
  /** The actor requesting execution */
  actorId: string;
  /** The specific resource being acted upon (optional) */
  resourceId?: string;
  /** The decision ID from the policy engine */
  decisionId: string;
  /** The environment where execution is authorized */
  environment: string;
  /** Unix timestamp (seconds) when the token was issued */
  issuedAt: number;
  /** Unix timestamp (seconds) when the token expires */
  expiresAt: number;
}

/**
 * A complete Strix Decision Token (SDT) with signature.
 */
export interface StrixDecisionToken {
  /** Token type identifier */
  typ: "SDT";
  /** Signing algorithm */
  alg: "EdDSA";
  /** The token payload */
  payload: SDTPayload;
  /** Base64url-encoded Ed25519 signature over the canonical payload */
  signature: string;
}

// ─── Configuration ──────────────────────────────────────────────────

/**
 * A capability definition for the local policy engine registry.
 *
 * Pure data-shape contract, so it lives in the open SDK; the engine that
 * consumes it (`LocalPolicyEngine`) lives in the closed control core
 * (`@strixgov/governance-core`), which imports this type from here.
 */
export interface LocalCapabilityDef {
  /** The capability ID */
  capabilityId: string;
  /** Risk classification */
  riskLevel: "critical" | "high" | "medium" | "low";
  /** Environments where this capability is allowed */
  allowedEnvironments: string[];
  /** Number of approvals required (0 = auto-approve) */
  approvalsRequired: number;
  /** Whether the action is irreversible */
  irreversible: boolean;
}

/**
 * Policy engine configuration.
 * The SDK is decision-engine agnostic — it can work with:
 * - "local": In-memory policy engine (air-gapped / testing)
 * - "remote": Strix SaaS or any external decision service
 * - Custom: Any object implementing PolicyEngine interface
 */
export type PolicyEngineConfig =
  | {
      type: "local";
      /** Ed25519 private key (hex) used to sign tokens. Required. */
      signingKey: string;
      /** Override which capabilities are auto-registered. Defaults to []. */
      capabilities?: LocalCapabilityDef[];
      /** Token TTL in seconds (default: 300 = 5 minutes) */
      tokenTtlSeconds?: number;
    }
  | {
      type: "remote";
      /** Base URL of the Strix platform. Default: https://www.strixgov.com */
      url: string;
      /** Bearer token for Authorization header */
      apiKey?: string;
      /** Tenant ID sent as X-Tenant-Id on every request */
      tenantId?: string;
      /** Request timeout in ms (default: 10000) */
      timeoutMs?: number;
    }
  | { type: "custom"; engine: PolicyEngine };

/**
 * Evidence sink configuration.
 * Controls where immutable execution records are written.
 */
export type EvidenceSinkConfig =
  | { type: "file"; path: string }
  | { type: "memory" }
  | { type: "custom"; sink: EvidenceSink };

/**
 * Main SDK configuration.
 */
export interface StrixGovernanceConfig {
  /** Policy engine configuration */
  policyEngine: PolicyEngineConfig;
  /** Evidence sink configuration */
  evidenceSink?: EvidenceSinkConfig;
  /** Ed25519 public key (hex or base64) for verifying SDT signatures */
  verificationKey?: string;
  /** Ed25519 private key (hex or base64) for signing SDTs (local engine only) */
  signingKey?: string;
  /** Default environment (e.g., "production", "staging") */
  defaultEnvironment?: string;
  /** Enable debug logging */
  debug?: boolean;
}

// ─── Policy Engine Interface ────────────────────────────────────────

/**
 * A decision request sent to the policy engine.
 */
export interface DecisionRequest {
  capabilityId: string;
  actorId: string;
  resourceId?: string;
  environment: string;
  metadata?: Record<string, unknown>;
}

/**
 * The result of a policy decision.
 */
export interface DecisionResult {
  status: "ALLOWED" | "DENIED" | "REQUIRES_APPROVAL";
  decisionId: string;
  /** Signed SDT (only present when status is ALLOWED) */
  token?: string;
  /** Reason for denial or approval requirement */
  reason?: string;
  /** Number of approvals still needed */
  missingApprovals?: number;
  /** Policy version that produced this decision */
  policyVersion?: string;
}

/**
 * Interface that all policy engines must implement.
 * This is the abstraction that makes the SDK decision-engine agnostic.
 */
export interface PolicyEngine {
  /** Request a governance decision */
  requestDecision(request: DecisionRequest): Promise<DecisionResult>;
  /** Check if a decision token has been redeemed (anti-replay) */
  isRedeemed(decisionId: string): Promise<boolean>;
  /** Mark a decision token as redeemed */
  markRedeemed(decisionId: string): Promise<void>;
}

// ─── Evidence ───────────────────────────────────────────────────────

/**
 * An immutable execution record — the first-class evidence artifact.
 */
export interface ExecutionRecord {
  /** Unique execution ID */
  executionId: string;
  /** The decision ID from the SDT */
  decisionId: string;
  /** The capability that was executed (or blocked) */
  capabilityId: string;
  /** The actor who initiated the action */
  actorId: string;
  /** The resource acted upon */
  resourceId?: string;
  /** The environment */
  environment: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Execution outcome */
  outcome: "EXECUTED" | "BLOCKED" | "ERROR";
  /** Reason for blocking (if blocked) */
  blockReason?: string;
  /** Block code for programmatic handling */
  blockCode?: string;
  /** SHA-256 hash of the handler function source (integrity) */
  handlerHash?: string;
  /** SHA-256 hash of this record (tamper detection) */
  recordHash: string;
  /** Policy version that authorized this execution */
  policyVersion?: string;
  /** Execution duration in milliseconds */
  durationMs?: number;
}

/**
 * Interface for evidence sinks.
 */
export interface EvidenceSink {
  /** Write an execution record to the sink */
  write(record: ExecutionRecord): Promise<void>;
  /** Read all records for a given capability (optional) */
  read?(capabilityId: string): Promise<ExecutionRecord[]>;
}

// ─── Governed Action ────────────────────────────────────────────────

/**
 * Options for defining a governed action.
 */
export interface GovernedActionOptions {
  /** The capability ID this action is registered under */
  capability: string;
  /** Optional description for documentation */
  description?: string;
  /** Risk classification */
  riskLevel?: "critical" | "high" | "medium" | "low";
}

/**
 * Context passed to governed action handlers.
 */
export interface GovernedContext {
  /** The verified SDT payload */
  token: SDTPayload;
  /** The execution ID for this run */
  executionId: string;
  /** The actor ID from the token */
  actorId: string;
  /** The environment */
  environment: string;
}

/**
 * The result of a token verification and redemption attempt.
 */
export interface RedemptionResult {
  success: boolean;
  executionId: string;
  reason?: string;
  blockCode?: string;
}

// ─── Simulation ─────────────────────────────────────────────────────

/**
 * Input for governance simulation.
 */
export interface SimulationInput {
  capability: string;
  actorId: string;
  resourceId?: string;
  environment?: string;
}

/**
 * Result of a governance simulation.
 */
export interface SimulationResult {
  status: "ALLOWED" | "DENIED" | "REQUIRES_APPROVAL";
  missingApprovals?: number;
  policyVersion?: string;
  reason?: string;
}
