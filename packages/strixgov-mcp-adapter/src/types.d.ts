export interface McpCapability {
  id: string;
  name: string;
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  mode: "READ" | "WRITE" | "EXECUTE";
  description?: string;
}

export interface McpCallerContext {
  actorId?: string;
  actorRole?: string;
  transport?: string;
  headers?: Record<string, string | string[] | undefined>;
  metadata?: Record<string, unknown>;
}

export interface TrustedIdentity {
  actorId: string;
  actorRole?: string;
}

export interface TrustedIdentityOptions {
  actorId?: string;
  actorRole?: string;
  requireTrusted?: boolean;
  resolve?: (input: {
    claimedActorId?: string;
    claimedActorRole?: string;
    transport?: string;
    headers?: Record<string, string | string[] | undefined>;
    metadata?: Record<string, unknown>;
  }) => TrustedIdentity | Promise<TrustedIdentity>;
}

export interface GovernMCPServerOptions {
  serverId?: string;
  capabilities?: McpCapability[];
  policy?: {
    rules?: Record<string, "ALLOW" | "DENY" | "APPROVAL_REQUIRED">;
    default?: "ALLOW" | "DENY";
    riskOverrides?: Record<string, "ALLOW" | "DENY" | "APPROVAL_REQUIRED">;
  };
  signingKey?: import("@strixgov/tool-gateway").SigningKey;
  keyRing?: import("@strixgov/tool-gateway").KeyRing;
  storagePath?: string;
  outcomeStorage?: import("@strixgov/tool-gateway").OutcomeStorageDriver;
  connectedMode?: {
    kernelUrl: string;
    apiKey: string;
    tenantId: string;
  };
  tenantId?: string;
  environment?: string;
  approval?: object;
  rateLimits?: Record<string, { windowMs: number; max: number; perActor?: boolean }>;
  identity?: TrustedIdentityOptions;
  onOutcome?: (outcome: import("@strixgov/tool-gateway").ExecutionOutcome) => void;
}

export interface GovernedExecution<TResult = unknown> {
  ok: boolean;
  decision: "ALLOW" | "DENY" | "APPROVAL_REQUIRED";
  authorizationReceipt: import("@strixgov/tool-gateway").Receipt;
  executionOutcome: import("@strixgov/tool-gateway").ExecutionOutcome | null;
  result?: TResult;
  error?: { code?: string; message?: string };
}

export interface GovernedServer {
  callTool(
    name: string,
    args: unknown,
    ctx?: McpCallerContext,
  ): Promise<unknown>;
  executeTool(
    name: string,
    args: unknown,
    ctx?: McpCallerContext,
  ): Promise<GovernedExecution>;
  listTools(): Promise<Array<{ name: string; description?: string }>>;
  listOutcomes(): Promise<import("@strixgov/tool-gateway").ExecutionOutcome[]>;
  gateway: import("@strixgov/tool-gateway").Gateway;
  readonly signingKey: import("@strixgov/tool-gateway").SigningKey;
  outcomeStorage: import("@strixgov/tool-gateway").OutcomeStorageDriver;
}

export interface McpServerLike {
  handler(name: string, args: unknown): Promise<unknown>;
  listTools(): Promise<Array<{ name: string; description?: string }>>;
  serverId?: string;
}

export function governMCPServer(
  tools: Record<string, (args: unknown) => Promise<unknown>> | McpServerLike,
  opts?: GovernMCPServerOptions,
): GovernedServer;

export function createGovernedServer(opts: GovernMCPServerOptions & {
  tools: Record<string, (args: unknown) => Promise<unknown>>;
}): GovernedServer;

export interface ConnectedModeConfig {
  kernelUrl: string;
  apiKey: string;
  tenantId: string;
}

/**
 * Read connected-mode configuration from environment variables.
 * Returns null when STRIX_API_KEY or STRIX_TENANT_ID are absent (stays in Local Mode).
 * STRIX_KERNEL_URL defaults to https://www.strixgov.com.
 */
export function loadConnectedModeFromEnv(): ConnectedModeConfig | null;

export { classifyMcpTool } from "@strixgov/tool-gateway/adapters/mcp";
