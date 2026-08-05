/**
 * @strixgov/mcp-adapter
 *
 * One-call governance for any MCP server.
 *
 * The adapter emits two deliberately separate proof artifacts:
 *
 *   1. authorization receipt — signed and persisted before invocation;
 *   2. execution outcome — signed and persisted after the allowed invocation.
 *
 * A DENY or unapproved action produces only the authorization receipt because
 * the executor was never called. An allowed action produces a linked outcome
 * with SUCCEEDED or FAILED status.
 */

import {
  createGateway,
  generateSigningKey,
  MemoryStorage,
  JsonlStorage,
  MemoryOutcomeStorage,
  JsonlOutcomeStorage,
  issueExecutionOutcome,
} from "@strixgov/tool-gateway";

import {
  governedMcpServer,
  classifyMcpTool,
} from "@strixgov/tool-gateway/adapters/mcp";

export { classifyMcpTool };

const DEFAULT_KERNEL_URL = "https://www.strixgov.com";

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
 * Govern every tool call on an MCP server.
 *
 * Trusted identity precedence:
 *   1. opts.identity.resolve(ctx)
 *   2. opts.identity.actorId / actorRole
 *   3. STRIX_TRUSTED_ACTOR_ID / STRIX_TRUSTED_ACTOR_ROLE
 *   4. client-supplied ctx only when trusted identity is not required
 *
 * Client-provided actor metadata is never able to override a fixed or
 * transport-authenticated identity. NVIDIA NOOA/OpenShell profiles set
 * STRIX_REQUIRE_TRUSTED_IDENTITY=true and provide a workload identity.
 */
export function governMCPServer(tools, opts = {}) {
  const serverId = opts.serverId ?? "default";

  const connectedMode =
    opts.connectedMode !== undefined
      ? opts.connectedMode
      : loadConnectedModeFromEnv();

  const effectiveIdentity = opts.identity ?? {
    actorId: process.env.STRIX_TRUSTED_ACTOR_ID,
    actorRole: process.env.STRIX_TRUSTED_ACTOR_ROLE,
    requireTrusted:
      String(process.env.STRIX_REQUIRE_TRUSTED_IDENTITY ?? "").toLowerCase() ===
      "true",
  };

  const capByFullId = new Map();
  const capByName = new Map();
  if (Array.isArray(opts.capabilities)) {
    for (const cap of opts.capabilities) {
      capByFullId.set(cap.id, cap);
      const bare = cap.id.replace(/^mcp\.[^.]+\./, "");
      capByName.set(bare, cap);
      if (typeof cap.name === "string" && cap.name !== bare) {
        capByName.set(cap.name, cap);
      }
    }
  }

  // A durable receipt store paired with an implicit ephemeral private key
  // creates historical records that cannot be verified after restart. Reject
  // that combination. A key ring is accepted because it preserves retired keys
  // and exposes the currently active signer.
  if (opts.storagePath && !opts.signingKey && !opts.keyRing) {
    throw new Error(
      "governMCPServer: storagePath requires an explicit persistent signingKey or keyRing; " +
        "use loadOrCreateSigningKey/loadOrCreateKeyRing or @strixgov/mcp-proxy",
    );
  }

  const initialSigningKey =
    opts.signingKey ?? opts.keyRing?.active ?? generateSigningKey(`strix-${serverId}`);

  const storage = opts.storagePath
    ? new JsonlStorage({ dir: opts.storagePath })
    : new MemoryStorage();
  const outcomeStorage = opts.outcomeStorage ?? (
    opts.storagePath
      ? new JsonlOutcomeStorage({ dir: opts.storagePath })
      : new MemoryOutcomeStorage()
  );

  const policy = opts.policy ?? { default: "DENY" };
  const capabilities = {};
  for (const [id, cap] of capByFullId) capabilities[id] = cap;

  const gateway = createGateway({
    signingKey: opts.keyRing ? undefined : initialSigningKey,
    keyRing: opts.keyRing,
    storage,
    policy,
    capabilities,
    approval: opts.approval ?? { enabled: false },
    connectedMode: connectedMode ?? undefined,
    rateLimits: opts.rateLimits,
    tenantId:
      connectedMode?.tenantId ??
      opts.tenantId ??
      process.env.STRIX_TENANT_ID,
    environment:
      opts.environment ??
      process.env.STRIX_ENVIRONMENT,
  });

  const serverIface = _buildServerIface(tools, serverId);

  function classify(tool) {
    const fullId = `mcp.${serverId}.${tool.name}`;
    return (
      capByFullId.get(fullId) ??
      capByName.get(tool.name) ??
      classifyMcpTool({ ...tool, serverId })
    );
  }

  async function resolveCapability(name) {
    try {
      const catalog = await serverIface.listTools();
      const tool = catalog.find((entry) => entry.name === name);
      const cap = tool
        ? classify({ ...tool, serverId })
        : {
            id: `mcp.${serverId}.${name}`,
            name,
            risk: "CRITICAL",
            mode: "EXECUTE",
            description: "Unknown MCP tool",
          };
      gateway.registerCapability(cap);
      return cap;
    } catch {
      const cap = {
        id: `mcp.${serverId}.${name}`,
        name,
        risk: "CRITICAL",
        mode: "EXECUTE",
        description: "MCP capability unresolved during identity failure",
      };
      gateway.registerCapability(cap);
      return cap;
    }
  }

  const governed = governedMcpServer(gateway, serverIface, { classify });

  async function executeTool(name, args, ctx = {}) {
    let identity;
    try {
      identity = await _resolveIdentity(effectiveIdentity, ctx);
    } catch (err) {
      // Identity is part of governance, not an adapter precondition that may
      // disappear without evidence. Mint a signed DENY and never invoke the
      // handler. The client-supplied actor claim is intentionally not promoted
      // into trusted actor fields on this receipt.
      const capability = await resolveCapability(name);
      const authorizationReceipt = await gateway.recordDenial({
        invocation: {
          capabilityId: capability.id,
          action: `mcp.callTool:${name}`,
          args,
        },
        capability,
        reason: "IDENTITY_RESOLUTION_FAILED",
      });
      return {
        ok: false,
        decision: "DENY",
        authorizationReceipt,
        executionOutcome: null,
        error: {
          code: "IDENTITY_RESOLUTION_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const raw = await governed.executeTool(name, args, identity);

    if (raw.decision !== "ALLOW") {
      return {
        ok: false,
        decision: raw.decision,
        authorizationReceipt: raw.receipt,
        executionOutcome: null,
        error: raw.error,
      };
    }

    const executionStatus = raw.ok ? "SUCCEEDED" : "FAILED";
    let executionOutcome;
    try {
      // Always read the gateway's active key at outcome time. If a key ring was
      // rotated after construction, the outcome must not continue signing with
      // the retired constructor-time key.
      executionOutcome = issueExecutionOutcome({
        authorizationReceipt: raw.receipt,
        executionStatus,
        result: raw.result,
        errorCode: raw.error?.code,
        signingKey: gateway.signingKey,
      });
      await outcomeStorage.appendOutcome(executionOutcome);
    } catch (err) {
      const proofError = new Error(
        `MCP tool '${name}' completed but its signed execution outcome could not be persisted: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      proofError.code = "OUTCOME_PERSISTENCE_FAILED";
      proofError.authorizationReceipt = raw.receipt;
      proofError.executionOutcome = executionOutcome ?? null;
      proofError.sideEffectMayHaveCompleted = true;
      throw proofError;
    }

    _safeGatewayEmit(gateway, "outcome", executionOutcome);
    if (typeof opts.onOutcome === "function") {
      try {
        opts.onOutcome(executionOutcome);
      } catch {
        // Observer failures cannot rewrite an already persisted proof artifact.
      }
    }

    return {
      ok: raw.ok,
      decision: raw.decision,
      authorizationReceipt: raw.receipt,
      executionOutcome,
      result: raw.result,
      error: raw.error,
    };
  }

  async function callTool(name, args, ctx = {}) {
    const result = await executeTool(name, args, ctx);
    if (!result.ok) {
      const err = new Error(
        result.decision === "ALLOW"
          ? `MCP tool '${name}' failed: ${result.error?.message ?? "executor error"}`
          : `MCP tool '${name}' denied: ${result.error?.message ?? "policy denied"}`,
      );
      err.code = result.error?.code ?? (result.decision === "ALLOW" ? "EXECUTOR_ERROR" : "DENIED");
      err.receipt = result.authorizationReceipt;
      err.authorizationReceipt = result.authorizationReceipt;
      err.executionOutcome = result.executionOutcome;
      throw err;
    }
    return result.result;
  }

  return {
    callTool,
    executeTool,
    listTools: governed.listTools,
    listOutcomes: () => outcomeStorage.listOutcomes(),
    gateway,
    get signingKey() {
      return gateway.signingKey;
    },
    outcomeStorage,
  };
}

export function createGovernedServer(opts) {
  const { tools, ...rest } = opts;
  return governMCPServer(tools, rest);
}

async function _resolveIdentity(identity, ctx = {}) {
  const claimed = {
    actorId: ctx.actorId,
    actorRole: ctx.actorRole,
  };

  if (typeof identity?.resolve === "function") {
    const resolved = await identity.resolve({
      claimedActorId: ctx.actorId,
      claimedActorRole: ctx.actorRole,
      transport: ctx.transport,
      headers: ctx.headers,
      metadata: ctx.metadata,
    });
    if (!resolved || typeof resolved.actorId !== "string" || !resolved.actorId) {
      throw new Error("governMCPServer: identity resolver returned no actorId");
    }
    return { actorId: resolved.actorId, actorRole: resolved.actorRole };
  }

  if (typeof identity?.actorId === "string" && identity.actorId) {
    return { actorId: identity.actorId, actorRole: identity.actorRole };
  }

  if (identity?.requireTrusted === true) {
    throw new Error(
      "governMCPServer: trusted actor identity is required; client-supplied MCP metadata is not an authentication boundary",
    );
  }

  return claimed;
}

function _safeGatewayEmit(gateway, event, value) {
  if (typeof gateway?._safeEmit === "function") {
    gateway._safeEmit(event, value);
    return;
  }
  try {
    gateway?.emit?.(event, value);
  } catch {
    // Observer failure is not load-bearing after persistence.
  }
}

function _buildServerIface(tools, serverId) {
  if (tools && typeof tools.handler === "function" && typeof tools.listTools === "function") {
    return { ...tools, serverId: tools.serverId ?? serverId };
  }

  if (tools && typeof tools === "object") {
    const entries = Object.entries(tools).filter(([, value]) => typeof value === "function");
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
