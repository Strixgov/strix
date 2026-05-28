/**
 * @strixgov/mcp-adapter
 *
 * One-call governance for any MCP server.
 *
 * ## Quickstart
 *
 *   import { governMCPServer } from "@strixgov/mcp-adapter";
 *   import { githubCapabilities } from "@strixgov/capabilities-mcp-common/github";
 *
 *   const governed = governMCPServer(myTools, {
 *     serverId: "github",
 *     capabilities: githubCapabilities,
 *     policy: {
 *       rules: {
 *         "mcp.github.merge_pull_request":  "APPROVAL_REQUIRED",
 *         "mcp.github.delete_repository":   "DENY",
 *         "mcp.github.get_file_contents":   "ALLOW",
 *       },
 *       default: "DENY",
 *     },
 *   });
 *
 *   // In your MCP request handler:
 *   const result = await governed.callTool(name, args, { actorId: "agent-1" });
 *
 * `myTools` is either:
 *   - A plain Record<string, async (args) => result> — your existing handlers, untouched
 *   - An object with { handler(name, args), listTools() } for full control
 *
 * ## What happens on every callTool
 *
 *   1. Capability is looked up (companion pack → heuristic fallback)
 *   2. PolicyEngine evaluates: ALLOW / DENY / APPROVAL_REQUIRED
 *   3. If APPROVAL_REQUIRED: approval gate fires (configurable)
 *   4. If ALLOW/approved: tool handler runs
 *   5. Signed execution receipt written to storage (local-first)
 *   6. If connectedMode: receipt synced to strixgov.com in the background
 *
 * Steps 1–5 complete before the tool handler runs. A denied tool never
 * executes and still leaves a signed receipt proving the attempt.
 *
 * ## Fail-closed guarantee
 *
 * If a signing key cannot be obtained, `governMCPServer` throws at
 * construction — not at first call. There is no "governance degraded
 * but tool still runs" state.
 */

import {
  createGateway,
  generateSigningKey,
  MemoryStorage,
  JsonlStorage,
} from "@strixgov/tool-gateway";

import {
  governedMcpServer,
  classifyMcpTool,
} from "@strixgov/tool-gateway/adapters/mcp";

export { classifyMcpTool };

const DEFAULT_KERNEL_URL = "https://www.strixgov.com";

/**
 * Build connected-mode options from environment variables.
 *
 * Required env vars (both must be set for connected mode to activate):
 *   STRIX_API_KEY   — your strixgov.com API key (≥16 chars)
 *   STRIX_TENANT_ID — your tenant slug (e.g. "acme-corp")
 *
 * Optional:
 *   STRIX_KERNEL_URL — platform URL (default: https://www.strixgov.com)
 *
 * Returns null when required vars are absent (stays in Local Mode).
 *
 * @returns {{ kernelUrl: string, apiKey: string, tenantId: string } | null}
 */
export function loadConnectedModeFromEnv() {
  const apiKey = process.env.STRIX_API_KEY;
  const tenantId = process.env.STRIX_TENANT_ID;
  if (!apiKey || !tenantId) return null;
  return {
    kernelUrl: process.env.STRIX_KERNEL_URL ?? DEFAULT_KERNEL_URL,
    apiKey,
    tenantId,
  };
}

/**
 * Govern every tool call on an MCP server with a single call.
 *
 * @param {Record<string, (args: unknown) => Promise<unknown>> | McpServerLike} tools
 *   Either a plain map of tool name → handler, or an object with
 *   `{ handler(name, args), listTools() }` for servers that already have
 *   that interface.
 *
 * @param {{
 *   serverId?: string,
 *   capabilities?: Array<{ id: string, name: string, risk: string, mode: string }>,
 *   policy?: { rules?: Record<string, "ALLOW"|"DENY"|"APPROVAL_REQUIRED">, default?: string },
 *   signingKey?: object,
 *   storagePath?: string,
 *   connectedMode?: {
 *     kernelUrl: string,
 *     apiKey: string,
 *     tenantId: string,
 *   },
 *   approval?: object,
 *   rateLimits?: Record<string, { windowMs: number, max: number, perActor?: boolean }>,
 * }} opts
 *
 * @returns {{
 *   callTool(name: string, args: unknown, ctx?: { actorId?: string, actorRole?: string }): Promise<unknown>,
 *   listTools(): Promise<Array<{ name: string, description?: string }>>,
 *   gateway: import("../../tool-gateway/src/gateway.mjs").Gateway,
 *   signingKey: object,
 * }}
 */
export function governMCPServer(tools, opts = {}) {
  const serverId = opts.serverId ?? "default";

  // Auto-detect connected mode from env vars when caller hasn't set it
  // explicitly. This makes the 5-line integration stay 5 lines even with
  // connected mode enabled: just export STRIX_API_KEY + STRIX_TENANT_ID.
  const connectedMode =
    opts.connectedMode !== undefined
      ? opts.connectedMode
      : loadConnectedModeFromEnv();

  // Build a lookup map from the companion pack (if provided) keyed by
  // both the full canonical id AND the bare tool name for convenience.
  /** @type {Map<string, object>} */
  const capByFullId = new Map();
  /** @type {Map<string, object>} */
  const capByName = new Map();
  if (Array.isArray(opts.capabilities)) {
    for (const cap of opts.capabilities) {
      capByFullId.set(cap.id, cap);
      // Strip the "mcp.<serverId>." prefix to get the bare tool name.
      const bare = cap.id.replace(/^mcp\.[^.]+\./, "");
      capByName.set(bare, cap);
      // Many MCP servers (Notion, Slack, Linear) prefix tool names with
      // the server name — e.g. "notion-fetch". The capability `name` field
      // already carries that real on-the-wire name, so index by it too.
      // Without this, server-prefixed tools fall through to the heuristic
      // (MEDIUM EXECUTE) and the companion-pack classification is wasted.
      if (typeof cap.name === "string" && cap.name !== bare) {
        capByName.set(cap.name, cap);
      }
    }
  }

  // Signing key — auto-generate for Local Mode, stable key for Connected Mode.
  const signingKey = opts.signingKey ?? generateSigningKey(`strix-${serverId}`);

  // Storage — in-memory by default (Local Mode), JSONL on disk if storagePath given.
  const storage = opts.storagePath
    ? new JsonlStorage({ dir: opts.storagePath })
    : new MemoryStorage();

  // Policy — caller-supplied or fail-closed default.
  const policy = opts.policy ?? { default: "DENY" };

  // Pre-populate capabilities map for the gateway so policy rules can
  // reference them by id before the first callTool arrives.
  /** @type {Record<string, object>} */
  const capabilities = {};
  for (const [id, cap] of capByFullId) {
    capabilities[id] = cap;
  }

  const gateway = createGateway({
    signingKey,
    storage,
    policy,
    capabilities,
    approval: opts.approval ?? { enabled: false },
    connectedMode: connectedMode ?? undefined,
    rateLimits: opts.rateLimits,
    tenantId: connectedMode?.tenantId,
  });

  // Build the server interface that governedMcpServer expects.
  const serverIface = _buildServerIface(tools, serverId);

  // Classifier: companion pack wins, heuristics are the fallback.
  function classify(tool) {
    const fullId = `mcp.${serverId}.${tool.name}`;
    return (
      capByFullId.get(fullId) ??
      capByName.get(tool.name) ??
      classifyMcpTool({ ...tool, serverId })
    );
  }

  const governed = governedMcpServer(gateway, serverIface, { classify });

  return {
    callTool: governed.callTool,
    listTools: governed.listTools,
    gateway,
    signingKey,
  };
}

/**
 * Build a governed server from a plain map of tool handlers and a tool
 * list, without exposing the Gateway at all. Useful for the simplest
 * possible integration.
 *
 *   const server = createGovernedServer({
 *     capabilities: githubCapabilities,
 *     policy: { rules: { "mcp.github.merge_pull_request": "DENY" }, default: "DENY" },
 *     tools: {
 *       merge_pull_request: async (args) => octokit.pulls.merge(args),
 *       get_file_contents:  async (args) => octokit.repos.getContent(args),
 *     },
 *   });
 *
 *   // Plug into your MCP request handler:
 *   const result = await server.callTool(name, args);
 *
 * @param {{
 *   tools: Record<string, (args: unknown) => Promise<unknown>>,
 *   capabilities?: Array<{ id: string, name: string, risk: string, mode: string }>,
 *   policy?: object,
 *   signingKey?: object,
 *   storagePath?: string,
 *   connectedMode?: object,
 *   approval?: object,
 *   serverId?: string,
 * }} opts
 */
export function createGovernedServer(opts) {
  const { tools, ...rest } = opts;
  return governMCPServer(tools, rest);
}

// ─── internal ─────────────────────────────────────────────────────────────────

/**
 * Normalise the caller's `tools` argument into the
 * `{ handler, listTools, serverId }` shape governedMcpServer expects.
 *
 * @param {Record<string, Function> | object} tools
 * @param {string} serverId
 */
function _buildServerIface(tools, serverId) {
  // Already the right shape
  if (tools && typeof tools.handler === "function" && typeof tools.listTools === "function") {
    return { ...tools, serverId: tools.serverId ?? serverId };
  }

  // Plain Record<name, handler>
  if (tools && typeof tools === "object") {
    const entries = Object.entries(tools).filter(([, v]) => typeof v === "function");
    if (entries.length === 0) {
      throw new TypeError(
        "governMCPServer: tools must be a non-empty record of tool handlers or a { handler, listTools } object",
      );
    }
    const toolList = entries.map(([name]) => ({ name }));
    return {
      serverId,
      listTools: async () => toolList,
      handler: async (name, args) => {
        const fn = tools[name];
        if (typeof fn !== "function") {
          throw new Error(`governMCPServer: no handler registered for tool '${name}'`);
        }
        return fn(args);
      },
    };
  }

  throw new TypeError("governMCPServer: tools must be an object");
}
