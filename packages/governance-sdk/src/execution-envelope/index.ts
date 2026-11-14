import { createHash } from "node:crypto";
import { canonicalizeJSON, SCJ_VERSION } from "../actor-attestation/scj-v1-mirror.js";

/** Frozen wire identifier. Breaking changes require a new envelope version. */
export const EXECUTION_ENVELOPE_V1 = "strix.execution-envelope.v1" as const;
export const EXECUTION_ENVELOPE_CANONICALIZATION = SCJ_VERSION;
export const CAPABILITY_RESOLUTION_COMMITMENT_V1 = "strix.capability-resolution-commitment.v1" as const;

export type ExecutionActorType = "human" | "agent" | "service" | "device";

export interface ExecutionEnvelopeActorV1 {
  actorId: string;
  actorType: ExecutionActorType;
  /** Human/service principal on whose authority the actor operates. */
  principalId?: string;
  /** Immediate delegator, when execution is delegated. */
  delegatorId?: string;
  /** Distinct executor when proposer and executor are not the same identity. */
  executorId?: string;
}

export interface ExecutionEnvelopeSourceV1 {
  protocol: "rest" | "mcp" | "langgraph" | "sdk" | "customer" | "other";
  /** Native operation before normalization, e.g. tools/call. Provenance only. */
  operation?: string;
  /** Native tool/route/action name before capability resolution. Provenance only. */
  nativeAction?: string;
  serverId?: string;
}

export type CapabilityResolutionStatusV1 = "CANONICAL" | "ALIASED";

export interface CommittedCapabilityResolutionV1 {
  boundaryVersion: typeof CAPABILITY_RESOLUTION_COMMITMENT_V1;
  submittedCapability: string;
  canonicalCapabilityId: string;
  resolutionStatus: CapabilityResolutionStatusV1;
  resolverId: string;
  resolverVersion: string;
  resolverHash: string;
}

export interface FinalizeCapabilityResolutionV1Input {
  submittedCapability: string;
  canonicalCapabilityId: string;
  resolutionStatus: CapabilityResolutionStatusV1;
  resolverId: string;
  resolverVersion: string;
  resolverHash: string;
}

export interface ExecutionEnvelopeV1 {
  envelopeVersion: typeof EXECUTION_ENVELOPE_V1;
  executionId: string;
  tenantId: string;
  environment: string;
  actor: ExecutionEnvelopeActorV1;
  capabilityId: string;
  capabilityResolution: CommittedCapabilityResolutionV1;
  /** Exact proposed side-effect input. Never place credentials/secrets here. */
  payload: unknown;
  payloadCanonicalization: typeof EXECUTION_ENVELOPE_CANONICALIZATION;
  payloadHash: string;
  context: {
    scope?: Record<string, unknown>;
    traceId?: string;
    runId?: string;
    taskHash?: string;
  };
  /** Provenance is bound to the full envelope but excluded from the action commitment. */
  source: ExecutionEnvelopeSourceV1;
  idempotencyKey?: string;
  requestedAt: string;
}

export interface BuildExecutionEnvelopeV1Input {
  executionId: string;
  tenantId: string;
  environment: string;
  actor: ExecutionEnvelopeActorV1;
  capabilityResolution: CommittedCapabilityResolutionV1;
  payload: unknown;
  context?: ExecutionEnvelopeV1["context"];
  source: ExecutionEnvelopeSourceV1;
  idempotencyKey?: string;
  requestedAt: string;
}

export interface ExecutionCommitmentCoreV1 {
  envelopeVersion: typeof EXECUTION_ENVELOPE_V1;
  tenantId: string;
  environment: string;
  actor: ExecutionEnvelopeActorV1;
  capabilityId: string;
  payloadCanonicalization: typeof EXECUTION_ENVELOPE_CANONICALIZATION;
  payloadHash: string;
  scope?: Record<string, unknown>;
  taskHash?: string;
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
}

function requireSha256Like(value: unknown, field: string): asserts value is string {
  requireString(value, field);
  if (!/^(?:sha256:)?[0-9a-f]{64}$/i.test(value)) {
    throw new TypeError(field + " must be a SHA-256 hex digest, optionally prefixed with sha256:");
  }
}

export function assertCommittedCapabilityResolutionV1(
  value: unknown,
): asserts value is CommittedCapabilityResolutionV1 {
  if (!value || typeof value !== "object") throw new TypeError("capabilityResolution must be an object");
  const r = value as Partial<CommittedCapabilityResolutionV1>;
  if (r.boundaryVersion !== CAPABILITY_RESOLUTION_COMMITMENT_V1) {
    throw new TypeError("unsupported capability resolution boundary version");
  }
  requireString(r.submittedCapability, "capabilityResolution.submittedCapability");
  requireString(r.canonicalCapabilityId, "capabilityResolution.canonicalCapabilityId");
  if (r.resolutionStatus !== "CANONICAL" && r.resolutionStatus !== "ALIASED") {
    throw new TypeError("capabilityResolution.resolutionStatus must be CANONICAL or ALIASED");
  }
  requireString(r.resolverId, "capabilityResolution.resolverId");
  requireString(r.resolverVersion, "capabilityResolution.resolverVersion");
  requireSha256Like(r.resolverHash, "capabilityResolution.resolverHash");
  if (r.resolutionStatus === "CANONICAL" && r.submittedCapability !== r.canonicalCapabilityId) {
    throw new TypeError("CANONICAL resolution requires submittedCapability to equal canonicalCapabilityId");
  }
}

export function finalizeCapabilityResolutionV1(
  input: FinalizeCapabilityResolutionV1Input,
): Readonly<CommittedCapabilityResolutionV1> {
  const resolution: CommittedCapabilityResolutionV1 = {
    boundaryVersion: CAPABILITY_RESOLUTION_COMMITMENT_V1,
    submittedCapability: input.submittedCapability,
    canonicalCapabilityId: input.canonicalCapabilityId,
    resolutionStatus: input.resolutionStatus,
    resolverId: input.resolverId,
    resolverVersion: input.resolverVersion,
    resolverHash: input.resolverHash,
  };
  assertCommittedCapabilityResolutionV1(resolution);
  return Object.freeze(resolution);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashExecutionPayloadV1(payload: unknown): string {
  return sha256Hex(canonicalizeJSON(payload));
}

export function buildExecutionEnvelopeV1(input: BuildExecutionEnvelopeV1Input): ExecutionEnvelopeV1 {
  requireString(input.executionId, "executionId");
  requireString(input.tenantId, "tenantId");
  requireString(input.environment, "environment");
  requireString(input.actor?.actorId, "actor.actorId");
  requireString(input.actor?.actorType, "actor.actorType");
  assertCommittedCapabilityResolutionV1(input.capabilityResolution);
  requireString(input.requestedAt, "requestedAt");
  requireString(input.source?.protocol, "source.protocol");

  const envelope: ExecutionEnvelopeV1 = {
    envelopeVersion: EXECUTION_ENVELOPE_V1,
    executionId: input.executionId,
    tenantId: input.tenantId,
    environment: input.environment,
    actor: {
      actorId: input.actor.actorId,
      actorType: input.actor.actorType,
      ...(input.actor.principalId !== undefined ? { principalId: input.actor.principalId } : {}),
      ...(input.actor.delegatorId !== undefined ? { delegatorId: input.actor.delegatorId } : {}),
      ...(input.actor.executorId !== undefined ? { executorId: input.actor.executorId } : {}),
    },
    capabilityId: input.capabilityResolution.canonicalCapabilityId,
    capabilityResolution: Object.freeze({ ...input.capabilityResolution }),
    payload: input.payload,
    payloadCanonicalization: EXECUTION_ENVELOPE_CANONICALIZATION,
    payloadHash: hashExecutionPayloadV1(input.payload),
    context: { ...(input.context ?? {}) },
    source: { ...input.source },
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    requestedAt: input.requestedAt,
  };
  assertExecutionEnvelopeV1(envelope);
  return envelope;
}

export function assertExecutionEnvelopeV1(value: unknown): asserts value is ExecutionEnvelopeV1 {
  if (!value || typeof value !== "object") throw new TypeError("execution envelope must be an object");
  const e = value as Partial<ExecutionEnvelopeV1>;
  if (e.envelopeVersion !== EXECUTION_ENVELOPE_V1) throw new TypeError("unsupported execution envelope version");
  if (e.payloadCanonicalization !== EXECUTION_ENVELOPE_CANONICALIZATION) throw new TypeError("unsupported payload canonicalization");
  requireString(e.executionId, "executionId");
  requireString(e.tenantId, "tenantId");
  requireString(e.environment, "environment");
  requireString(e.actor?.actorId, "actor.actorId");
  requireString(e.actor?.actorType, "actor.actorType");
  requireString(e.capabilityId, "capabilityId");
  assertCommittedCapabilityResolutionV1(e.capabilityResolution);
  if (e.capabilityId !== e.capabilityResolution.canonicalCapabilityId) {
    throw new TypeError("capabilityId does not match committed capability resolution");
  }
  requireString(e.requestedAt, "requestedAt");
  requireString(e.source?.protocol, "source.protocol");
  if (!e.context || typeof e.context !== "object" || Array.isArray(e.context)) throw new TypeError("context must be an object");
  if (hashExecutionPayloadV1(e.payload) !== e.payloadHash) throw new TypeError("payloadHash does not match canonical payload");
}

export function canonicalizeExecutionEnvelopeV1(envelope: ExecutionEnvelopeV1): string {
  assertExecutionEnvelopeV1(envelope);
  return canonicalizeJSON(envelope);
}

export function hashExecutionEnvelopeV1(envelope: ExecutionEnvelopeV1): string {
  return sha256Hex(canonicalizeExecutionEnvelopeV1(envelope));
}

/**
 * The action commitment deliberately excludes executionId, requestedAt, source,
 * trace/run ids and idempotency metadata. Equivalent native integrations therefore
 * converge on one hash, while any trust-relevant change to actor/action/payload/
 * tenant/environment/scope/task changes the commitment.
 */
export function executionCommitmentCoreV1(envelope: ExecutionEnvelopeV1): ExecutionCommitmentCoreV1 {
  assertExecutionEnvelopeV1(envelope);
  return {
    envelopeVersion: envelope.envelopeVersion,
    tenantId: envelope.tenantId,
    environment: envelope.environment,
    actor: { ...envelope.actor },
    capabilityId: envelope.capabilityId,
    payloadCanonicalization: envelope.payloadCanonicalization,
    payloadHash: envelope.payloadHash,
    ...(envelope.context.scope ? { scope: envelope.context.scope } : {}),
    ...(envelope.context.taskHash ? { taskHash: envelope.context.taskHash } : {}),
  };
}

export function hashExecutionCommitmentV1(envelope: ExecutionEnvelopeV1): string {
  return sha256Hex(canonicalizeJSON(executionCommitmentCoreV1(envelope)));
}
