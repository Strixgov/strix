/**
 * TypeScript surface for @strixgov/mcp-proxy.
 */

export interface UpstreamConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ProxyOptions {
  upstream: UpstreamConfig;
  serverId?: string;
  capabilities?: Array<{ id: string; name: string; risk: string; mode: string; description?: string }>;
  policy?: {
    rules?: Record<string, "ALLOW" | "DENY" | "APPROVAL_REQUIRED">;
    riskOverrides?: Record<string, "ALLOW" | "DENY" | "APPROVAL_REQUIRED">;
    default?: "ALLOW" | "DENY";
  };
  approval?: {
    enabled?: boolean;
    prompt?: (cap: object, invocation: object, opts: object) => Promise<{ approved: boolean; approver?: string }>;
    /** JSON-config approver selector: "terminal" | "file" | "webhook" | "auto". */
    type?: "terminal" | "file" | "webhook" | "auto";
    autoApprove?: boolean;
    /** type "file" | "webhook": request/response directory (~ expanded). */
    requestDir?: string;
    /** type "webhook": Slack-compatible notification URL (http/https). Decision still flows via the response file. */
    webhookUrl?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  storagePath?: string;
  signingKey?: object;
  connectedMode?: { kernelUrl: string; apiKey: string; tenantId: string };
  onReceipt?: (receipt: object) => void;
  onAudit?: (event: { kind: string; detail: object }) => void;
  transport?: { kind: "stdio" } | { kind: "test"; [k: string]: unknown };
}

export interface ProxyHandle {
  stop(): Promise<void>;
  gateway: object;
  signingKey: object;
}

export interface ProxyConfigFile {
  serverId?: string;
  upstream: UpstreamConfig;
  capabilities?: string | Array<object>;
  policy?: ProxyOptions["policy"];
  approval?: ProxyOptions["approval"];
  storagePath?: string;
}

export declare function startProxy(opts: ProxyOptions): Promise<ProxyHandle>;
export declare function loadConfig(filePath: string): Promise<ProxyConfigFile>;
export declare function resolveCapabilities(
  capabilities: string | Array<object> | undefined,
): Promise<Array<object> | undefined>;
