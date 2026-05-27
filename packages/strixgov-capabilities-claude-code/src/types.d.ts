export const REGISTRY_NAME: "claude-code";
export const REGISTRY_VERSION: string;

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Mode = "READ" | "WRITE" | "EXECUTE";
export type Decision = "ALLOW" | "DENY" | "APPROVAL_REQUIRED";

export interface ClaudeCodeCapability {
  id: string;
  name: string;
  risk: RiskLevel;
  mode: Mode;
  description: string;
}

export const claudeCodeCapabilities: ReadonlyArray<ClaudeCodeCapability>;

export function claudeCodeCapabilityMap(): Record<string, ClaudeCodeCapability>;

export function suggestedPolicy(): {
  rules: Record<string, Decision>;
  default: "DENY";
};
