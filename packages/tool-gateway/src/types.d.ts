/**
 * @strixgov/tool-gateway — Type definitions
 *
 * Governed tool execution for AI agents. The gateway sits inline between
 * an agent and an execution surface and evaluates every action before the
 * executor can be invoked.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Mode = "READ" | "WRITE" | "EXECUTE";
export type Decision = "ALLOW" | "DENY" | "APPROVAL_REQUIRED";
export type ExecutionStatus = "SUCCEEDED" | "FAILED" | "UNKNOWN";

export interface ToolCapability {
  id: string;
  name?: string;
  risk: RiskLevel;
  mode: Mode;
  description?: string;
}

export interface ToolInvocation {
  capabilityId: string;
  action: string;
  args: unknown;
  actorId?: string;
  actorRole?: string;
  invocationId?: string;
}

export interface PolicyRuleset {
  rules: Record<string, Decision>;
  default?: Decision;
  riskOverrides?: Partial<Record<RiskLevel, Decision>>;
  rateLimits?: Record<string, RateLimitRule>;
}

export interface RateLimitRule {
  windowMs: number;
  max: number;
  perActor?: boolean;
}

export class RateLimiter {
  constructor(rules?: Record<string, RateLimitRule>, opts?: { now?: () => number });
  check(ctx: { capabilityId: string; actorId?: string }): {
    allowed: boolean;
    remaining: number;
    resetAt?: number;
    reason?: string;
    ruleKey?: string;
  };
  reset(capabilityId?: string, actorId?: string): void;
}

export interface PolicyEvaluation {
  decision: Decision;
  capabilityId: string;
  matchedRule: string;
  risk: RiskLevel;
  reason: string;
}

export interface ApprovalPromptOptions {
  timeoutMs?: number;
  prompt?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export interface ApprovalResult {
  approved: boolean;
  reason: "USER_APPROVED" | "USER_DENIED" | "TIMEOUT" | "PROMPT_FAILED";
  approvedBy?: string;
}

/** Current pre-execution authorization receipt schema. */
export interface ReceiptCanonical {
  schemaVersion: "2";
  receiptId: string;
  capabilityId: string;
  action: string;
  decision: Decision;
  risk: RiskLevel;
  mode: Mode;
  policyVersion: string;
  tenantId: string;
  environment: string;
  invocationHash: string;
  evidenceHash: string;
  proofChainHash: string;
  timestamp: string;
}

/** Frozen v1 receipt schema retained for legacy verification. */
export interface ReceiptCanonicalV1 {
  schemaVersion: "1";
  receiptId: string;
  capabilityId: string;
  action: string;
  decision: Decision;
  risk: RiskLevel;
  mode: Mode;
  invocationHash: string;
  evidenceHash: string;
  proofChainHash: string;
  timestamp: string;
}

export interface Receipt extends ReceiptCanonical {
  signingKeyId: string;
  signature: string;
  tool?: string;
  actorId?: string;
  actorRole?: string;
  approvedBy?: string;
  approvalReason?: ApprovalResult["reason"];
}

/**
 * Signed post-execution record. Receipt proves pre-invocation authorization;
 * ExecutionOutcome proves the result observed after an ALLOW invocation.
 */
export interface ExecutionOutcomeCanonical {
  schemaVersion: "1";
  outcomeId: string;
  authorizationReceiptId: string;
  authorizationProofChainHash: string;
  capabilityId: string;
  action: string;
  decision: "ALLOW";
  executionAttempted: true;
  executionStatus: ExecutionStatus;
  invocationHash: string;
  resultHash: string;
  errorCode: string;
  policyVersion: string;
  tenantId: string;
  environment: string;
  completedAt: string;
  signingKeyId: string;
  signatureAlgorithm: "Ed25519";
  outcomeHash: string;
}

export interface ExecutionOutcome extends ExecutionOutcomeCanonical {
  signature: string;
}

export interface VerifyExecutionOutcomeResult {
  outcomeId?: string;
  schemaValid: boolean;
  hashValid: boolean;
  signaturePresent: boolean;
  keyResolved: boolean;
  signatureValid: boolean;
  linkValid: boolean | null;
  consistencyValid: boolean;
  verificationStatus:
    | "VERIFIED"
    | "UNSIGNED"
    | "KEY_NOT_FOUND"
    | "HASH_MISMATCH"
    | "SIGNATURE_INVALID"
    | "INCONSISTENT"
    | "AUTHORIZATION_LINK_INVALID"
    | "ERROR";
  error: string | null;
}

export interface VerifyResult {
  receiptId: string;
  signaturePresent: boolean;
  signatureValid: boolean;
  hashValid: boolean;
  chainValid: boolean | null;
  status: "VERIFIED" | "UNSIGNED" | "TAMPERED" | "ERROR";
  error?: string;
}

export interface SigningKey {
  kid: string;
  privateKey: import("node:crypto").KeyObject;
  publicKey: import("node:crypto").KeyObject;
  publicKeyJwk: { kty: "OKP"; crv: "Ed25519"; kid: string; x: string };
}

export interface KeyRingEntry {
  kid: string;
  privateKey: import("node:crypto").KeyObject | null;
  publicKey: import("node:crypto").KeyObject;
  publicKeyJwk: { kty: "OKP"; crv: "Ed25519"; kid: string; x: string };
  meta: {
    status: "active" | "retired";
    generatedAt: string;
    retiredAt?: string;
  };
}

export class KeyRing {
  readonly root: string;
  readonly activeKid: string;
  readonly active: SigningKey;
  get(kid: string): KeyRingEntry | null;
  listKids(): string[];
  jwks(): { keys: Array<{ kty: "OKP"; crv: "Ed25519"; kid: string; x: string }> };
  rotate(opts?: { kid?: string }): Promise<{ previous: KeyRingEntry; current: KeyRingEntry }>;
  publicKeyForKid(kid: string): import("node:crypto").KeyObject | null;
}

export function loadOrCreateKeyRing(opts?: {
  root?: string;
  kid?: string;
}): Promise<KeyRing>;

export interface ChainSnapshot {
  schemaVersion: "snap-1";
  snapshotId: string;
  previousKid: string;
  newKid: string;
  lastReceiptId: string;
  lastProofChainHash: string;
  policyVersion: string;
  tenantId: string;
  environment: string;
  timestamp: string;
  signaturePrevious: string;
  signatureNew: string;
}

export interface StorageDriver {
  appendReceipt(receipt: Receipt): Promise<void>;
  lastReceipt(): Promise<Receipt | null>;
  listReceipts(): Promise<Receipt[]>;
  getReceipt(receiptId: string): Promise<Receipt | null>;
  appendSnapshot?(snapshot: ChainSnapshot): Promise<void>;
  listSnapshots?(): Promise<ChainSnapshot[]>;
}

export interface OutcomeStorageDriver {
  appendOutcome(outcome: ExecutionOutcome): Promise<void>;
  lastOutcome(): Promise<ExecutionOutcome | null>;
  listOutcomes(): Promise<ExecutionOutcome[]>;
  getOutcome(outcomeId: string): Promise<ExecutionOutcome | null>;
}

export class JsonlOutcomeStorage implements OutcomeStorageDriver {
  constructor(opts?: { dir?: string; file?: string });
  appendOutcome(outcome: ExecutionOutcome): Promise<void>;
  lastOutcome(): Promise<ExecutionOutcome | null>;
  listOutcomes(): Promise<ExecutionOutcome[]>;
  getOutcome(outcomeId: string): Promise<ExecutionOutcome | null>;
}

export class MemoryOutcomeStorage implements OutcomeStorageDriver {
  appendOutcome(outcome: ExecutionOutcome): Promise<void>;
  lastOutcome(): Promise<ExecutionOutcome | null>;
  listOutcomes(): Promise<ExecutionOutcome[]>;
  getOutcome(outcomeId: string): Promise<ExecutionOutcome | null>;
}

export interface EscalationOptions {
  threshold: number;
  windowMs: number;
  decisions?: Decision[];
  onEscalate?: (event: {
    threshold: number;
    windowMs: number;
    count: number;
    receipts: Receipt[];
  }) => void;
}

export interface ConnectedModeOptions {
  enabled?: boolean;
  kernelUrl: string;
  apiKey: string;
  tenantId: string;
  receiptsPath?: string;
  syncReceipts?: boolean;
  syncSnapshots?: boolean;
  bufferCap?: number;
  fetch?: typeof globalThis.fetch;
  onSyncError?: (e: {
    receipt?: Receipt;
    snapshot?: ChainSnapshot;
    err: Error;
    reason: string;
  }) => void;
}

export class ConnectedSyncer {
  constructor(opts: ConnectedModeOptions);
  readonly enabled: boolean;
  readonly pending: number;
  sendReceipt(receipt: Receipt): Promise<{ ok: boolean; status?: number; error?: Error }>;
  sendSnapshot(snapshot: ChainSnapshot): Promise<{ ok: boolean; status?: number; error?: Error }>;
  drain(): Promise<{ drained: number }>;
}

export const WIRE_VERSION: "v0.3-experimental";

export interface GatewayOptions {
  policy: PolicyRuleset;
  capabilities: Record<string, ToolCapability>;
  signingKey?: SigningKey;
  keyRing?: KeyRing;
  storage: StorageDriver;
  toolName?: string;
  rateLimiter?: RateLimiter;
  escalation?: EscalationOptions;
  connectedMode?: ConnectedModeOptions;
  tenantId?: string;
  environment?: string;
  approval?: {
    enabled?: boolean;
    timeoutMs?: number;
    autoApprove?: boolean;
    prompt?: (
      capability: ToolCapability,
      invocation: ToolInvocation,
      opts: ApprovalPromptOptions
    ) => Promise<ApprovalResult>;
  };
}

export type GatewayEvent =
  | "decision"
  | "receipt"
  | "outcome"
  | "denial"
  | "error"
  | "rotation"
  | "escalation"
  | "sync"
  | "sync-error";

export interface ExecuteResult<T> {
  ok: boolean;
  decision: Decision;
  receipt: Receipt;
  result?: T;
  error?: { code: string; message: string };
}

export type Executor<TArgs = unknown, TResult = unknown> = (
  args: TArgs
) => Promise<TResult> | TResult;

export class Gateway {
  constructor(options: GatewayOptions);
  readonly tenantId: string;
  readonly environment: string;
  readonly policyVersion: string;
  readonly connectedSyncer: ConnectedSyncer | null;
  signingKey: SigningKey;
  registerCapability(capability: ToolCapability): void;
  setPolicy(rules: PolicyRuleset): void;
  setRateLimits(rules: Record<string, RateLimitRule>): void;
  rotateKey(opts?: { kid?: string }): Promise<ChainSnapshot>;
  drainSync(): Promise<{ drained: number; pending: number }>;
  execute<TArgs, TResult>(
    invocation: ToolInvocation,
    executor: Executor<TArgs, TResult>
  ): Promise<ExecuteResult<TResult>>;
  evaluate(invocation: ToolInvocation): PolicyEvaluation;
  listReceipts(): Promise<Receipt[]>;
  verifyChain(): Promise<{ valid: boolean; brokenAt?: string }>;
  recordDenial(args: {
    invocation: ToolInvocation;
    capability: ToolCapability;
    reason: string;
  }): Promise<Receipt>;
  on(event: "decision", l: (e: { evaluation: PolicyEvaluation; invocation: ToolInvocation }) => void): this;
  on(event: "receipt", l: (r: Receipt) => void): this;
  on(event: "outcome", l: (o: ExecutionOutcome) => void): this;
  on(event: "denial", l: (e: { receipt: Receipt; evaluation?: PolicyEvaluation; approval?: ApprovalResult; reason?: string; hardfail?: boolean; rateLimited?: boolean }) => void): this;
  on(event: "error", l: (e: { receipt: Receipt; err: Error; invocation: ToolInvocation }) => void): this;
  on(event: "rotation", l: (e: { snapshot: ChainSnapshot }) => void): this;
  on(event: "escalation", l: (e: { threshold: number; windowMs: number; count: number; receipts: Receipt[] }) => void): this;
  on(event: "sync", l: (e: { kind: "receipt" | "snapshot"; record: Receipt | ChainSnapshot }) => void): this;
  on(event: "sync-error", l: (e: { receipt?: Receipt; snapshot?: ChainSnapshot; err: Error; reason: string }) => void): this;
  on(event: string | symbol, l: (...args: any[]) => void): this;
  off(event: string | symbol, l: (...args: any[]) => void): this;
  emit(event: string | symbol, ...args: any[]): boolean;
}

export function createGateway(options: GatewayOptions): Gateway;

export function loadOrCreateSigningKey(opts?: {
  keyPath?: string;
  kid?: string;
}): Promise<SigningKey>;

export function generateSigningKey(kid?: string): SigningKey;

export function verifyReceipt(
  receipt: Receipt,
  publicKey: import("node:crypto").KeyObject
): VerifyResult;

export function issueExecutionOutcome(args: {
  authorizationReceipt: Receipt;
  executionStatus: ExecutionStatus;
  result?: unknown;
  errorCode?: string;
  signingKey: SigningKey;
  completedAt?: string;
  outcomeId?: string;
}): ExecutionOutcome;

export function validateExecutionOutcomeShape(
  outcome: ExecutionOutcome
): true;

export function verifyExecutionOutcome(
  outcome: ExecutionOutcome,
  publicKey: import("node:crypto").KeyObject | null,
  authorizationReceipt?: Receipt
): VerifyExecutionOutcomeResult;

export function computeExecutionResultHash(result: unknown): string;
export function computeExecutionOutcomeHash(outcome: ExecutionOutcomeCanonical): string;
export function canonicalExecutionOutcomeCore(outcome: ExecutionOutcomeCanonical): string;
export function canonicalExecutionOutcomePayload(outcome: ExecutionOutcomeCanonical): string;

export const EXECUTION_OUTCOME_SCHEMA_VERSION: "1";
export const EXECUTION_OUTCOME_SIGNATURE_ALGORITHM: "Ed25519";
export const EXECUTION_OUTCOME_CORE_FIELD_ORDER: readonly string[];
export const EXECUTION_OUTCOME_FIELD_ORDER: readonly string[];
export const EXECUTION_OUTCOME_ALLOWED_FIELDS: readonly string[];

export function canonicalReceiptPayload(
  r: ReceiptCanonical | ReceiptCanonicalV1
): string;

export function computePolicyVersion(ruleset: PolicyRuleset): string;

export function fileApprover(opts?: {
  requestDir?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onRequestWritten?: (
    requestPath: string,
    requestId: string
  ) => void | Promise<void>;
}): (
  capability: ToolCapability,
  invocation: ToolInvocation,
  opts?: ApprovalPromptOptions
) => Promise<ApprovalResult>;

export function webhookApprover(opts: {
  notifyUrl: string;
  secret: string;
  pollResponse: (
    requestId: string
  ) => Promise<null | { approved: boolean; approvedBy?: string; reason?: string }>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
}): (
  capability: ToolCapability,
  invocation: ToolInvocation,
  opts?: ApprovalPromptOptions
) => Promise<ApprovalResult>;

export function verifyWebhookSignature(args: {
  body: string | Buffer;
  signatureHeader: string | undefined;
  secret: string;
}): boolean;

export interface CapabilityManifest {
  schemaVersion: "registry-1";
  capabilities: ToolCapability[];
  updatedAt: string;
  signingKeyId: string;
  signature: string;
}

export function saveCapabilityRegistry(args: {
  path?: string;
  capabilities: ToolCapability[];
  signingKey: SigningKey;
  updatedAt?: string;
}): Promise<CapabilityManifest>;

export function loadCapabilityRegistry(args: {
  path?: string;
  resolvePublicKey: (
    kid: string
  ) => import("node:crypto").KeyObject | null;
}): Promise<CapabilityManifest>;

export function watchCapabilityRegistry(args: {
  path?: string;
  resolvePublicKey: (
    kid: string
  ) => import("node:crypto").KeyObject | null;
  onChange?: (snapshot: CapabilityManifest) => void;
  onError?: (err: Error) => void;
}): Promise<{ current: () => CapabilityManifest; close: () => void }>;
