/**
 * Strix MCP Proxy — core.
 *
 * Architectural shape:
 *
 *   MCP Client ──stdio──▶ [Strix Proxy: server] ──governMCPServer──▶ [client] ──stdio──▶ Upstream MCP Server
 *
 * The proxy IS an MCP server (toward the consumer's client) AND an MCP
 * client (toward the upstream tool). Every callTool entering the proxy
 * is routed through `governMCPServer` from `@strixgov/mcp-adapter`,
 * which applies policy, fires the approval gate when needed, executes
 * via the upstream client, and emits a signed Ed25519 receipt.
 *
 * Today (v0.1.0) — Mode 1 (Observed) and Mode 2 (Approval-Gated).
 *
 * Designed for Mode 3 upgrade. The downstream-call seam at
 * `buildUpstreamIface()` is the single place where Mode 3 enforcement
 * will attach in v0.2.0: a future option (`mode: "enforced"`) wraps
 * every outbound call with the `execution_authorization_v1` token
 * mint + transport step from
 * `docs/architecture/mcp-mode-3-enforcement-v1.md` §6, without
 * touching the policy / approval / receipt pipeline above it.
 *
 * Why a proxy at all? Because changing a `mcp-server-command` config
 * value is something every MCP-aware client already supports
 * (Claude Desktop, mcp-cli, IDE integrations); changing the
 * application's authorization model is not. The proxy is the
 * "change your MCP endpoint" wedge — minimal developer friction,
 * maximum coverage of the actual MCP-call surface.
 */

import path from "node:path";
import os from "node:os";
import { governMCPServer } from "@strixgov/mcp-adapter";
import { loadOrCreateSigningKey, fileApprover } from "@strixgov/tool-gateway";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Start the proxy. Returns a handle with a `stop()` method so callers
 * (CLI, tests) can shut it down cleanly.
 *
 * @param {{
 *   upstream: { command: string, args?: string[], env?: Record<string, string> },
 *   serverId?: string,
 *   capabilities?: Array<object>,
 *   policy?: object,
 *   approval?: object,
 *   storagePath?: string,
 *   keyPath?: string,
 *   signingKey?: object,
 *   connectedMode?: object,
 *   onReceipt?: (receipt: object) => void,
 *   onAudit?: (event: { kind: string, detail: object }) => void,
 *   transport?: { kind: "stdio" } | { kind: "test", server: object, client: object },
 * }} opts
 * @returns {Promise<{ stop: () => Promise<void>, gateway: object, signingKey: object }>}
 */
export async function startProxy(opts) {
  if (!opts) {
    throw new TypeError("startProxy: opts is required");
  }
  const serverId = opts.serverId ?? "proxy";
  const transportKind = opts.transport?.kind ?? "stdio";
  // In real (stdio) mode opts.upstream.command is required; in test mode the
  // caller supplies a pre-connected upstream client instead.
  if (transportKind === "stdio") {
    if (!opts.upstream || typeof opts.upstream.command !== "string") {
      throw new TypeError("startProxy: opts.upstream.command is required for stdio mode");
    }
  }

  // ─── 0. Resolve upstream credentials ─────────────────────────────────────
  // When `upstreamCredentials` is supplied (from a JSON config or programmatic
  // caller), materialise each credential from its declared source — OS keychain
  // or env var — and merge the result into `upstream.env` before the upstream
  // process starts.  This keeps secrets out of config files while still feeding
  // them into the upstream server's environment at the last possible moment.
  //
  // Credentials are resolved before the storagePath default / signing-key logic
  // so that any audit events emitted below see the final env shape.
  //
  // @strixgov/mcp-credentials is an optional peer: loaded dynamically so the
  // proxy itself doesn't hard-depend on keytar.  When the field is absent we
  // skip this step entirely (no import, no overhead).
  let resolvedUpstreamEnv = opts.upstream?.env;
  if (opts.upstreamCredentials && transportKind === "stdio") {
    let resolveUpstreamCredentials;
    try {
      const mod = await import("@strixgov/mcp-credentials");
      resolveUpstreamCredentials = mod.resolveUpstreamCredentials;
    } catch {
      throw new Error(
        "startProxy: 'upstreamCredentials' requires @strixgov/mcp-credentials. " +
          "Install it alongside the proxy: npm install @strixgov/mcp-credentials",
      );
    }
    const credEnv = await resolveUpstreamCredentials(opts.upstreamCredentials);
    // Merge: explicit upstream.env takes precedence over resolved credentials
    // so operators can still override individual values at the shell level.
    resolvedUpstreamEnv = { ...credEnv, ...(opts.upstream?.env ?? {}) };
    audit(opts, {
      kind: "credentials.resolved",
      detail: { envKeys: Object.keys(credEnv) },
    });
  }

  // v0.1.4: default storagePath to ~/.strix-mcp-proxy/<serverId> when unset.
  //
  // Pre-0.1.4 left opts.storagePath undefined, which caused governMCPServer
  // to default both halves of persistence wrong:
  //   - storage = MemoryStorage (receipts vanish with the process)
  //   - signingKey = ephemeral generateSigningKey() (kid is in every receipt
  //     on disk, but the actual key is gone the moment the proxy exits)
  // The combination silently produced "persistent receipts signed by a key
  // that no longer exists anywhere", which is the worst possible state —
  // operators who pointed storagePath at ~/.strix-gateway were getting
  // receipts they could list but never verify.
  //
  // Per-serverId default (not a single shared dir) so multiple wrapped
  // upstreams cleanly partition their receipts + keys. Intentionally NOT
  // ~/.strix-gateway: the gateway CLI uses a multi-kid keyring layout
  // (active pointer + <kid>/ subdirs) and the proxy uses loadOrCreateSigningKey's
  // flat single-key layout — sharing the same keys/ dir collides silently
  // (proxy's flat files are invisible to the keyring loader, OR a stale
  // migration clobbers the gateway's active pointer to the proxy's kid).
  //
  // Opt out by passing `storagePath: null` (treated as "I really mean
  // ephemeral"). Caller-supplied opts.signingKey still wins regardless of
  // storage choice.
  const resolvedStoragePath =
    opts.storagePath === null
      ? null
      : opts.storagePath ?? path.join(os.homedir(), ".strix-mcp-proxy", serverId);

  // ─── 1. Connect to the upstream MCP server ─────────────────────────────────
  // Test mode lets callers pre-build the upstream client (e.g. with an
  // InMemoryTransport pair) so the proxy can be exercised end-to-end
  // without spawning a real subprocess.
  let upstreamClient;
  if (transportKind === "test" && opts.transport.upstreamClient) {
    upstreamClient = opts.transport.upstreamClient;
    audit(opts, { kind: "upstream.connected", detail: { command: "(test mode)" } });
  } else {
    upstreamClient = new Client(
      { name: `strix-proxy:${serverId}`, version: "0.1.0" },
      { capabilities: {} },
    );
    const upstreamTransport = new StdioClientTransport({
      command: opts.upstream.command,
      args: opts.upstream.args ?? [],
      env: resolvedUpstreamEnv ?? process.env,
    });
    await upstreamClient.connect(upstreamTransport);
    audit(opts, { kind: "upstream.connected", detail: { command: opts.upstream.command } });
  }

  // ─── 2. Build the iface mcp-adapter expects ───────────────────────────────
  const upstreamIface = buildUpstreamIface(upstreamClient, serverId);

  // ─── 3a. Resolve a persistent signing key when storagePath is set ──────────
  // Without this, governMCPServer falls back to an in-memory ephemeral key
  // (`generateSigningKey(\`strix-${serverId}\`)`) — meaning every restart
  // produces a new key with the same kid and the previous key (the one that
  // signed receipts already on disk) is gone forever. JSONL receipts on disk
  // would then be unverifiable: the kid points at a key that doesn't exist
  // anywhere, including the proxy that wrote them.
  //
  // When storagePath is set the operator clearly wants persistent receipts;
  // it's the natural moment to also persist the signing key alongside them.
  // The keypair is written to `<storagePath>/keys/{signing-key.pem, public-jwk.json}`
  // with PKCS8 PEM at 0600 / public JWK at 0644 (mirrors loadOrCreateSigningKey's
  // own discipline). Caller-supplied `opts.signingKey` still wins.
  let resolvedSigningKey = opts.signingKey;
  // keyPath takes precedence over storagePath-derived key location when both
  // are present (operators who want a stable key location independent of the
  // receipt store can set keyPath without setting storagePath).
  if (!resolvedSigningKey && opts.keyPath) {
    resolvedSigningKey = await loadOrCreateSigningKey({
      keyPath: opts.keyPath,
      kid: `strix-${serverId}`,
    });
    audit(opts, {
      kind: "signing.key.resolved",
      detail: { source: "keyPath", kid: resolvedSigningKey.kid, keyPath: opts.keyPath },
    });
  }
  if (!resolvedSigningKey && resolvedStoragePath) {
    resolvedSigningKey = await loadOrCreateSigningKey({
      keyPath: path.join(resolvedStoragePath, "keys"),
      kid: `strix-${serverId}`,
    });
    audit(opts, {
      kind: "signing.key.resolved",
      detail: {
        source: opts.storagePath ? "persistent" : "persistent-default",
        kid: resolvedSigningKey.kid,
        keyPath: path.join(resolvedStoragePath, "keys"),
      },
    });
  }

  // ─── 3b. Resolve approval config to an approver function ───────────────────
  // The gateway's approval expects `prompt: (cap, inv, callOpts) => Promise<...>`
  // — a function. JSON config can't carry a function, so the proxy translates
  // a string `approval.type` to the right approver from @strixgov/tool-gateway.
  //
  // Why this matters: when the proxy is spawned by Claude Desktop (or any
  // other MCP client that owns the stdio channel), the default `terminalApprove`
  // fails closed because stdin/stdout aren't a TTY — every APPROVAL_REQUIRED
  // call gets denied with `PROMPT_FAILED`. Operators have to pick a headless
  // approver explicitly. `type: "file"` is the headless default; `type: "auto"`
  // is the demo shortcut; `type: "terminal"` is the legacy default (works only
  // when the proxy is run from a real terminal).
  //
  // Supported config shapes (all under `approval`):
  //
  //   {enabled: false}                                  ← gate disabled, every APPROVAL_REQUIRED → DENY
  //   {enabled: true}                                   ← terminal (legacy default; fails closed in Claude Desktop)
  //   {enabled: true, type: "terminal"}                 ← terminal (explicit)
  //   {enabled: true, type: "auto"}                     ← shortcut for autoApprove: true (demos)
  //   {enabled: true, type: "file",
  //    requestDir: "~/.strix-gateway/approvals",        ← request/response file polling (headless)
  //    timeoutMs: 300000}
  //   {enabled: true, autoApprove: true}                ← long form of {type: "auto"}
  //   {enabled: true, prompt: <fn>}                     ← programmatic caller wins (always)
  const resolvedApproval = resolveApproval(opts.approval, {
    ...opts,
    storagePath: resolvedStoragePath,
  });

  // ─── 3c. Wrap with governMCPServer (Mode 1/2) ──────────────────────────────
  const governed = governMCPServer(upstreamIface, {
    serverId,
    capabilities: opts.capabilities,
    policy: opts.policy ?? { default: "DENY" },
    approval: resolvedApproval,
    storagePath: resolvedStoragePath,
    signingKey: resolvedSigningKey,
    connectedMode: opts.connectedMode,
  });

  if (typeof opts.onReceipt === "function") {
    governed.gateway.on("receipt", opts.onReceipt);
  }

  // ─── 4. Expose the proxy as an MCP server toward the consumer ──────────────
  const proxyServer = new Server(
    { name: `strix-proxy:${serverId}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  proxyServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await governed.listTools();
    // governed.listTools returns [{ name, description? }]; the MCP wire
    // spec expects { tools: [{ name, description, inputSchema }] }.
    // Re-fetch the full descriptors from the upstream so callers see
    // the original argument shapes — governance doesn't reshape tools.
    const upstream = await upstreamClient.listTools();
    const upstreamByName = new Map(upstream.tools.map((t) => [t.name, t]));
    return {
      tools: tools.map((t) => upstreamByName.get(t.name) ?? { name: t.name }),
    };
  });

  proxyServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Forward actor context if the client put it in _meta — this is how
    // mcp-aware clients attribute calls to a specific agent identity.
    const ctx = {
      actorId: request.params?._meta?.strix_actor_id,
      actorRole: request.params?._meta?.strix_actor_role,
    };
    try {
      const result = await governed.callTool(name, args, ctx);
      return result;
    } catch (err) {
      audit(opts, { kind: "call.denied", detail: { name, code: err?.code, message: err?.message } });
      // Re-throw as an MCP-shaped error so the consumer's client sees
      // a structured failure rather than a generic exception.
      throw err;
    }
  });

  // ─── 5. Connect the proxy server to its outbound transport ─────────────────
  let proxyTransport;
  if (transportKind === "stdio") {
    proxyTransport = new StdioServerTransport();
    await proxyServer.connect(proxyTransport);
    audit(opts, { kind: "proxy.listening", detail: { serverId, transport: "stdio" } });
  } else if (transportKind === "test") {
    // Test-mode: caller supplies the proxy-server-side Transport
    // (typically an InMemoryTransport linked to a paired transport
    // they hand to a test Client). Lets the test suite drive the
    // proxy end-to-end without spawning child processes.
    if (!opts.transport.serverTransport) {
      throw new TypeError("startProxy: transport.kind='test' requires transport.serverTransport");
    }
    proxyTransport = opts.transport.serverTransport;
    await proxyServer.connect(proxyTransport);
    audit(opts, { kind: "proxy.listening", detail: { serverId, transport: "test" } });
  } else {
    throw new TypeError(`startProxy: unknown transport kind '${transportKind}'`);
  }

  return {
    gateway: governed.gateway,
    signingKey: governed.signingKey,
    async stop() {
      try { await proxyServer.close(); } catch { /* best-effort */ }
      try { await upstreamClient.close(); } catch { /* best-effort */ }
      audit(opts, { kind: "proxy.stopped", detail: { serverId } });
    },
  };
}

// ─── internal ─────────────────────────────────────────────────────────

/**
 * The single seam where Mode 3 enforcement will attach in v0.2.0.
 * Today this just forwards to the upstream client. In v0.2.0 a
 * `mode: "enforced"` option will mint an execution_authorization_v1
 * token at this layer and attach it via the chosen transport
 * (header for HTTP upstream, _meta for stdio first-party MCP) per
 * docs/architecture/mcp-mode-3-enforcement-v1.md §6.
 */
function buildUpstreamIface(client, serverId) {
  return {
    serverId,
    listTools: async () => {
      const out = await client.listTools();
      return out.tools.map((t) => ({ name: t.name, description: t.description }));
    },
    handler: async (name, args) => {
      return await client.callTool({ name, arguments: args ?? {} });
    },
  };
}

function audit(opts, event) {
  if (typeof opts.onAudit === "function") {
    try { opts.onAudit(event); } catch { /* swallow audit-handler errors */ }
  }
}

/**
 * Translate the JSON-friendly `approval` config to the function-shaped
 * approval object the gateway expects.
 *
 * Resolution rules (first match wins):
 *
 *   1. `approval.prompt` is a function       → pass through unchanged
 *      (programmatic callers can always inject their own approver).
 *   2. `approval.enabled === false`          → pass through unchanged
 *      (no prompt needed; gateway denies every APPROVAL_REQUIRED).
 *   3. `approval.autoApprove === true`       → pass through unchanged
 *      (long-form alias for type: "auto").
 *   4. `approval.type === "auto"`            → set autoApprove: true.
 *   5. `approval.type === "file"`            → construct fileApprover.
 *                                              `requestDir` defaults to
 *                                              `<storagePath>/approvals` if
 *                                              storagePath is set, otherwise
 *                                              `./.strix-approvals`.
 *                                              `~` and `$HOME` are expanded.
 *   6. `approval.type === "terminal"`        → pass through unchanged
 *      (gateway defaults to terminalApprove). Fails closed in non-TTY
 *      environments — fine for direct-CLI testing, broken under
 *      Claude Desktop spawn.
 *   7. Unknown `approval.type`               → throw at startup so the
 *      operator can't misconfigure silently into a fail-closed loop.
 */
function resolveApproval(approval, opts) {
  if (!approval) return { enabled: false };

  // Programmatic callers always win — JSON-config strings are a
  // convenience for operators, not the source of truth.
  if (typeof approval.prompt === "function") return approval;
  if (approval.enabled === false) return approval;
  if (approval.autoApprove === true) return approval;

  const type = approval.type;
  if (type === undefined || type === null) return approval;

  if (type === "auto") {
    return { ...approval, autoApprove: true };
  }

  if (type === "file") {
    const requestDirRaw =
      approval.requestDir ??
      (opts.storagePath ? path.join(opts.storagePath, "approvals") : "./.strix-approvals");
    const requestDir = expandHomeTilde(requestDirRaw);
    return {
      ...approval,
      prompt: fileApprover({
        requestDir,
        timeoutMs: approval.timeoutMs,
        pollIntervalMs: approval.pollIntervalMs,
      }),
    };
  }

  if (type === "terminal") {
    // Pass through; gateway's default is terminalApprove. Operators who
    // type this explicitly are accepting the non-TTY fail-closed behavior.
    return approval;
  }

  throw new Error(
    `startProxy: unknown approval.type '${type}' — expected "terminal", "file", or "auto"`,
  );
}

/**
 * Expand a leading `~` or `~/` to the OS user-home directory. Mirrors the
 * tilde-expansion behavior in loadConfig so `~/.strix-gateway/approvals`
 * resolves consistently across config locations.
 */
function expandHomeTilde(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
