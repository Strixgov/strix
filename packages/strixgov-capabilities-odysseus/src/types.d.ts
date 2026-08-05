export const REGISTRY_NAME: "odysseus";
export const REGISTRY_VERSION: string;

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Mode = "READ" | "WRITE" | "EXECUTE";
export type Decision = "ALLOW" | "DENY" | "APPROVAL_REQUIRED";

/**
 * How the action's side-effect path can be intercepted today.
 * - "mcp-proxy":  the call reaches its side effect through an MCP
 *   server that @strixgov/mcp-proxy wraps — pre-execution interception
 *   is real today; this surface may be described as enforced.
 * - "host-hook":  the action uses the host's native code path; until
 *   an upstream host hook exists, the surface is OBSERVE-ONLY and must
 *   be labeled as such wherever it is rendered.
 */
export type Interception = "mcp-proxy" | "host-hook";

export interface OdysseusCapability {
  id: string;
  name: string;
  risk: RiskLevel;
  mode: Mode;
  interception: Interception;
  description: string;
}

export const shellCapabilities: ReadonlyArray<OdysseusCapability>;
export const filesystemCapabilities: ReadonlyArray<OdysseusCapability>;
export const emailCapabilities: ReadonlyArray<OdysseusCapability>;
export const webCapabilities: ReadonlyArray<OdysseusCapability>;
export const scheduleCapabilities: ReadonlyArray<OdysseusCapability>;
export const memoryCapabilities: ReadonlyArray<OdysseusCapability>;
export const secretCapabilities: ReadonlyArray<OdysseusCapability>;
export const extensionCapabilities: ReadonlyArray<OdysseusCapability>;
export const allOdysseusCapabilities: ReadonlyArray<OdysseusCapability>;

export function odysseusCapabilityMap(): Record<string, OdysseusCapability>;
export function enforceableToday(): OdysseusCapability[];
export function observeOnlyToday(): OdysseusCapability[];

export function suggestedPolicy(): {
  rules: Record<string, Decision>;
  riskOverrides: { CRITICAL: "DENY" };
  default: "DENY";
};
