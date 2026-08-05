/**
 * `strix-guard init` — the five-minute loop's first command.
 *
 * What it does, in order:
 *   1. Detect (or accept via --config) the MCP client config.
 *   2. Back the config file up (<path>.bak-strix-guard-<epoch>).
 *   3. For every server in `mcpServers` not already wrapped, write a
 *      per-server @strixgov/mcp-proxy config under the guard home and
 *      rewrite the client entry to spawn the proxy instead of the
 *      upstream directly. The upstream command/args/env move verbatim
 *      into the proxy config — governance wraps the server, it does not
 *      reshape it.
 *   4. Print the next steps (restart client → first blocked action →
 *      approve → receipt).
 *
 * Default policy (the Guard promise): known servers get their
 * pre-classified capability pack (reads pass, writes require approval);
 * unknown servers get `default: APPROVAL_REQUIRED` — every tool call
 * asks a human until classified. Guard never defaults anything to
 * silent-allow.
 *
 * Telemetry: NONE over the network. Activation state (init/approval
 * timestamps) is written to <guard-home>/state.json, local only.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { guardHome, guardPaths, detectClientConfig } from "./paths.mjs";

/**
 * Server-id / command → pre-classified capability pack. Matches the
 * subpath exports of @strixgov/capabilities-mcp-common.
 */
const KNOWN_PACKS = ["notion", "github", "slack", "linear", "postgres", "filesystem", "email"];

export function packForServer(serverId, entry) {
  const haystack = [serverId, entry?.command ?? "", ...(entry?.args ?? [])]
    .join(" ")
    .toLowerCase();
  const hit = KNOWN_PACKS.find((p) => haystack.includes(p));
  return hit ? `@strixgov/capabilities-mcp-common/${hit}` : null;
}

export function isAlreadyWrapped(entry) {
  const parts = [entry?.command ?? "", ...(entry?.args ?? [])].join(" ");
  return parts.includes("@strixgov/mcp-proxy") || parts.includes("strix-mcp-proxy");
}

/** Build the per-server proxy config object (pure). */
export function buildProxyConfig({ serverId, entry, paths, webhookUrl }) {
  const pack = packForServer(serverId, entry);
  const approval = {
    enabled: true,
    type: webhookUrl ? "webhook" : "file",
    requestDir: paths.approvalsDir,
    timeoutMs: 300_000,
  };
  if (webhookUrl) approval.webhookUrl = webhookUrl;
  return {
    serverId,
    upstream: {
      command: entry.command,
      args: entry.args ?? [],
      ...(entry.env ? { env: entry.env } : {}),
    },
    // Known servers: pre-classified pack (reads ALLOW, writes
    // APPROVAL_REQUIRED per the pack's risk levels). Unknown servers:
    // no classifications yet — every call asks (never silent-allow).
    capabilities: pack ?? [],
    policy: pack
      ? { default: "APPROVAL_REQUIRED", riskOverrides: { LOW: "ALLOW" } }
      : { default: "APPROVAL_REQUIRED" },
    approval,
    storagePath: path.join(paths.receiptsDir, serverId),
  };
}

/**
 * Run init. Returns a summary object (also printed by the CLI).
 *
 * @param {{
 *   config?: string,       // explicit client-config path
 *   webhook?: string,      // Slack-compatible webhook URL for notifications
 *   dryRun?: boolean,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   log?: (line: string) => void,
 * }} opts
 */
export async function runInit(opts = {}) {
  const log = opts.log ?? console.error;
  const home = guardHome(opts.env ?? process.env);
  const paths = guardPaths(home);

  const detected = detectClientConfig({ explicit: opts.config, cwd: opts.cwd });
  if (!detected) {
    throw new Error(
      opts.config
        ? `strix-guard init: config not found: ${opts.config}`
        : "strix-guard init: no MCP client config found (looked for ./.mcp.json, Claude Desktop, ~/.cursor/mcp.json). Pass --config <path>.",
    );
  }

  const raw = await fs.readFile(detected.path, "utf8");
  let clientConfig;
  try {
    clientConfig = JSON.parse(raw);
  } catch (err) {
    throw new Error(`strix-guard init: could not parse ${detected.path}: ${err.message}`);
  }
  const servers = clientConfig.mcpServers;
  if (!servers || typeof servers !== "object" || Object.keys(servers).length === 0) {
    throw new Error(`strix-guard init: ${detected.path} has no mcpServers to wrap`);
  }

  const plan = [];
  for (const [serverId, entry] of Object.entries(servers)) {
    if (isAlreadyWrapped(entry)) {
      plan.push({ serverId, action: "skip", reason: "already wrapped" });
      continue;
    }
    if (!entry || typeof entry.command !== "string" || entry.command.length === 0) {
      plan.push({ serverId, action: "skip", reason: "no command to wrap" });
      continue;
    }
    const proxyConfigPath = path.join(paths.serversDir, `${serverId}.json`);
    plan.push({
      serverId,
      action: "wrap",
      pack: packForServer(serverId, entry),
      proxyConfigPath,
      proxyConfig: buildProxyConfig({ serverId, entry, paths, webhookUrl: opts.webhook }),
    });
  }

  const wraps = plan.filter((p) => p.action === "wrap");
  if (opts.dryRun) {
    log(`[strix-guard] dry run — would wrap ${wraps.length} server(s) in ${detected.path}:`);
    for (const p of plan) log(`  ${p.action.padEnd(4)} ${p.serverId}${p.pack ? ` (pack: ${p.pack})` : ""}${p.reason ? ` — ${p.reason}` : ""}`);
    return { configPath: detected.path, kind: detected.kind, wrapped: 0, skipped: plan.length - wraps.length, dryRun: true, plan };
  }

  if (wraps.length > 0) {
    // Backup BEFORE any write, then guard-home dirs, then proxy configs,
    // then the client config rewrite — a crash mid-way leaves the backup
    // plus at worst orphaned proxy configs, never a broken client config
    // without a backup.
    const backupPath = `${detected.path}.bak-strix-guard-${Date.now()}`;
    await fs.copyFile(detected.path, backupPath);
    await fs.mkdir(paths.serversDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.approvalsDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.receiptsDir, { recursive: true, mode: 0o700 });

    for (const p of wraps) {
      await fs.writeFile(p.proxyConfigPath, JSON.stringify(p.proxyConfig, null, 2) + "\n", { mode: 0o600 });
      servers[p.serverId] = {
        command: "npx",
        args: ["-y", "@strixgov/mcp-proxy", "--config", p.proxyConfigPath],
      };
    }
    await fs.writeFile(detected.path, JSON.stringify(clientConfig, null, 2) + "\n");

    // Local-only activation state — never transmitted.
    const state = await readState(paths.statePath);
    state.initializedAt ??= new Date().toISOString();
    state.wrappedServers = Array.from(
      new Set([...(state.wrappedServers ?? []), ...wraps.map((p) => p.serverId)]),
    );
    await fs.writeFile(paths.statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });

    log(`[strix-guard] wrapped ${wraps.length} server(s) in ${detected.path}`);
    log(`[strix-guard] backup: ${backupPath}`);
  } else {
    log(`[strix-guard] nothing to wrap in ${detected.path} (all servers already wrapped)`);
  }

  for (const p of plan) {
    log(`  ${p.action.padEnd(4)} ${p.serverId}${p.pack ? ` (pack: ${p.pack})` : ""}${p.reason ? ` — ${p.reason}` : ""}`);
  }
  if (wraps.length > 0) {
    log("");
    log("Next steps:");
    log("  1. Restart your MCP client (Claude Desktop / Claude Code / Cursor).");
    log("  2. Let your agent work. Reads pass; the first write BLOCKS and waits.");
    log("  3. See what's waiting:   npx @strixgov/guard pending");
    log("  4. Approve (or deny):    npx @strixgov/guard approve <requestId>");
    log(`  5. Signed receipts land in ${paths.receiptsDir}/<server>/ — verifiable offline.`);
    if (!opts.webhook) {
      log("");
      log("Tip: re-run with --webhook <slack-incoming-webhook-url> to get pinged where you live.");
    }
  }

  return {
    configPath: detected.path,
    kind: detected.kind,
    wrapped: wraps.length,
    skipped: plan.length - wraps.length,
    dryRun: false,
    plan,
  };
}

async function readState(statePath) {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch {
    return {};
  }
}
