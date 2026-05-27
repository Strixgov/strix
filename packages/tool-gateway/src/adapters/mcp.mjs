/**
 * MCP interception layer.
 *
 * The strategically important adapter: agents speak MCP, MCP speaks
 * tools. Slot the gateway between them and every tool.call() flows
 * through policy + receipts before reaching the downstream server.
 *
 *   MCP Client → governedMcpClient → [Gateway] → real MCP Server
 *
 * Risk classification heuristics (overridable per tool):
 *
 *   - tool.name starts with "read"/"get"/"list"/"search"/"query" → LOW READ
 *   - tool.name starts with "write"/"create"/"post"/"send"/"update" → HIGH WRITE
 *   - tool.name starts with "delete"/"remove"/"drop"/"destroy" → CRITICAL WRITE
 *   - tool.name starts with "exec"/"run"/"spawn"/"shell" → CRITICAL EXECUTE
 *   - everything else → MEDIUM EXECUTE (forces explicit policy)
 *
 * Heuristics are not a security boundary; they are a sane default for
 * a server you've never seen before. Production deployments should
 * register explicit ToolCapability entries per (serverId, toolName).
 */

const READ_PREFIXES = ["read", "get", "list", "search", "query", "find", "fetch", "describe"];
const WRITE_PREFIXES = ["write", "create", "post", "send", "update", "patch", "put", "set", "add", "edit", "publish"];
const DESTROY_PREFIXES = ["delete", "remove", "drop", "destroy", "purge", "wipe", "truncate"];
const EXEC_PREFIXES = ["exec", "run", "spawn", "shell", "invoke", "execute"];

/**
 * Heuristically classify an MCP tool by name.
 *
 * @param {{ name: string, description?: string, serverId?: string }} tool
 * @returns {import("../types.d.ts").ToolCapability}
 */
export function classifyMcpTool(tool) {
  const id = `mcp.${tool.serverId ?? "default"}.${tool.name}`;
  const name = String(tool.name ?? "").toLowerCase();

  /** @type {[import("../types.d.ts").RiskLevel, import("../types.d.ts").Mode]} */
  let [risk, mode] = ["MEDIUM", "EXECUTE"];

  if (DESTROY_PREFIXES.some((p) => name.startsWith(p))) {
    [risk, mode] = ["CRITICAL", "WRITE"];
  } else if (EXEC_PREFIXES.some((p) => name.startsWith(p))) {
    [risk, mode] = ["CRITICAL", "EXECUTE"];
  } else if (WRITE_PREFIXES.some((p) => name.startsWith(p))) {
    [risk, mode] = ["HIGH", "WRITE"];
  } else if (READ_PREFIXES.some((p) => name.startsWith(p))) {
    [risk, mode] = ["LOW", "READ"];
  }

  return {
    id,
    name: tool.name,
    risk,
    mode,
    description: tool.description,
  };
}

/**
 * Minimal MCP client interface the gateway needs. Real-world MCP
 * clients (`@modelcontextprotocol/sdk`) expose a richer surface — the
 * gateway only depends on these two methods.
 *
 * @typedef {{
 *   listTools(): Promise<Array<{ name: string, description?: string }>>,
 *   callTool(name: string, args: unknown): Promise<unknown>,
 * }} MinimalMcpClient
 */

/**
 * Wrap an MCP client so every callTool flows through the gateway.
 *
 * @param {import("../gateway.mjs").Gateway} gateway
 * @param {MinimalMcpClient} client
 * @param {{
 *   serverId?: string,
 *   actorId?: string,
 *   actorRole?: string,
 *   classify?: (tool: { name: string, description?: string, serverId?: string }) => import("../types.d.ts").ToolCapability,
 *   capabilityOverrides?: Record<string, import("../types.d.ts").ToolCapability>,
 * }} [opts]
 */
export function governedMcpClient(gateway, client, opts = {}) {
  const serverId = opts.serverId ?? "default";
  const classify = opts.classify ?? classifyMcpTool;
  const overrides = opts.capabilityOverrides ?? {};

  /** @type {Map<string, import("../types.d.ts").ToolCapability>} */
  const cache = new Map();

  async function classifyAndRegister(name) {
    if (cache.has(name)) return cache.get(name);
    const tools = await client.listTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      // Fail-closed: a tool the upstream server doesn't advertise is
      // treated as CRITICAL EXECUTE. PolicyEngine then decides.
      const synthetic = {
        id: `mcp.${serverId}.${name}`,
        name,
        risk: "CRITICAL",
        mode: "EXECUTE",
        description: "Unknown MCP tool (not in server catalog)",
      };
      gateway.registerCapability(synthetic);
      cache.set(name, synthetic);
      return synthetic;
    }
    const baseId = `mcp.${serverId}.${tool.name}`;
    const cap = overrides[baseId] ?? classify({ ...tool, serverId });
    gateway.registerCapability(cap);
    cache.set(tool.name, cap);
    return cap;
  }

  async function listTools() {
    const tools = await client.listTools();
    // Pre-classify so subsequent callTool calls can use the cache.
    for (const t of tools) {
      const baseId = `mcp.${serverId}.${t.name}`;
      const cap = overrides[baseId] ?? classify({ ...t, serverId });
      gateway.registerCapability(cap);
      cache.set(t.name, cap);
    }
    return tools;
  }

  async function callTool(name, args) {
    const cap = await classifyAndRegister(name);
    const result = await gateway.execute(
      {
        capabilityId: cap.id,
        action: `mcp.callTool:${name}`,
        args,
        actorId: opts.actorId,
        actorRole: opts.actorRole,
      },
      () => client.callTool(name, args)
    );
    if (!result.ok) {
      const err = new Error(
        `MCP tool '${name}' denied: ${result.error?.message ?? "policy denied"}`
      );
      // @ts-expect-error attaching context
      err.code = result.error?.code ?? "DENIED";
      // @ts-expect-error
      err.receipt = result.receipt;
      throw err;
    }
    return result.result;
  }

  return { listTools, callTool };
}

/**
 * Server-side interception: mount in front of a real MCP server so
 * inbound tool calls go through the gateway BEFORE the server handles
 * them. The server itself stays unchanged; the gateway becomes the
 * canonical admission point.
 *
 * @param {import("../gateway.mjs").Gateway} gateway
 * @param {{
 *   handler: (name: string, args: unknown) => Promise<unknown>,
 *   listTools: () => Promise<Array<{ name: string, description?: string }>>,
 *   serverId?: string,
 * }} server
 * @param {{ classify?: (t: { name: string, description?: string, serverId?: string }) => import("../types.d.ts").ToolCapability,
 *           capabilityOverrides?: Record<string, import("../types.d.ts").ToolCapability> }} [opts]
 */
export function governedMcpServer(gateway, server, opts = {}) {
  const serverId = server.serverId ?? "default";
  const classify = opts.classify ?? classifyMcpTool;
  const overrides = opts.capabilityOverrides ?? {};

  return {
    listTools: server.listTools,
    /**
     * @param {string} name
     * @param {unknown} args
     * @param {{ actorId?: string, actorRole?: string }} [callerCtx]
     */
    async callTool(name, args, callerCtx = {}) {
      const tools = await server.listTools();
      const tool = tools.find((t) => t.name === name);
      const baseCap = tool
        ? classify({ ...tool, serverId })
        : {
            id: `mcp.${serverId}.${name}`,
            name,
            risk: "CRITICAL",
            mode: "EXECUTE",
            description: "Unknown MCP tool",
          };
      const cap = overrides[baseCap.id] ?? baseCap;
      gateway.registerCapability(cap);

      const result = await gateway.execute(
        {
          capabilityId: cap.id,
          action: `mcp.callTool:${name}`,
          args,
          actorId: callerCtx.actorId,
          actorRole: callerCtx.actorRole,
        },
        () => server.handler(name, args)
      );
      if (!result.ok) {
        const err = new Error(
          `MCP tool '${name}' denied: ${result.error?.message ?? "policy denied"}`
        );
        // @ts-expect-error
        err.code = result.error?.code ?? "DENIED";
        // @ts-expect-error
        err.receipt = result.receipt;
        throw err;
      }
      return result.result;
    },
  };
}
