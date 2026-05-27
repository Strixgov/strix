export const REGISTRY_NAME: "mcp-common";
export const REGISTRY_VERSION: string;

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Mode = "READ" | "WRITE" | "EXECUTE";
export type Decision = "ALLOW" | "DENY" | "APPROVAL_REQUIRED";

export interface McpCapability {
  id: string;
  name: string;
  risk: RiskLevel;
  mode: Mode;
  description: string;
}

export const slackCapabilities: ReadonlyArray<McpCapability>;
export const githubCapabilities: ReadonlyArray<McpCapability>;
export const linearCapabilities: ReadonlyArray<McpCapability>;
export const notionCapabilities: ReadonlyArray<McpCapability>;
export const filesystemCapabilities: ReadonlyArray<McpCapability>;
export const postgresCapabilities: ReadonlyArray<McpCapability>;
export const emailCapabilities: ReadonlyArray<McpCapability>;
export const allMcpCapabilities: ReadonlyArray<McpCapability>;

export function mcpCapabilityMap(): Record<string, McpCapability>;

export function suggestedPolicy(): {
  rules: Record<string, Decision>;
  riskOverrides: { CRITICAL: "DENY" };
  default: "DENY";
};
