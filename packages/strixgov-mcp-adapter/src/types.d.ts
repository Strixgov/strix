export interface McpCapability {
  id: string;
  name: string;
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  mode: "READ" | "WRITE" | "EXECUTE";
  description?: string;
}

export interface GovernMCPServerOptions {
  serverId?: string;
  capabilities?: McpCapability[];
  policy?: {
    rules?: Record<string, "ALLOW" | "DENY" | "APPROVAL_REQUIRED">;
    default?: "ALLOW" | "DENY";
    riskOverrides?: Record<string, "ALLOW" | "DENY" | "APPROVAL_REQUIRED">;
  };
  signingKey?: object;
  storagePath?: string;
  connectedMode?: {
    kernelUrl: string;
    apiKey: string;
    tenantId: string;
  };
  approval?: object;
  rateLimits?: Record<string, { windowMs: number; max: number; perActor?: boolean }>;
}

export interface GovernedServer {
  callTool(
    name: string,
    args: unknown,
    ctx?: { actorId?: string; actorRole?: string },
  ): Promise<unknown>;
  listTools(): Promise<Array<{ name: string; description?: string }>>;
  gateway: import("@strixgov/tool-gateway").Gateway;
  signingKey: object;
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
