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
import { createHash } from "node:crypto";
import { guardHome, guardPaths, detectClientConfig } from "./paths.mjs";
import { auditCoverage, formatCoverage } from "./coverage.mjs";
import { readApproverPublic } from "./approver.mjs";

/**
 * Server-id / command → pre-classified capability pack. Matches the
 * subpath exports of @strixgov/capabilities-mcp-common.
 */
const KNOWN_PACKS = ["notion", "github", "slack", "linear", "postgres", "filesystem", "email"];

/**
 * The @strixgov/mcp-proxy version the generated client entries launch.
 * Pinned so a new npm publish cannot change what every Guard install runs;
 * test/package-contract.test.mjs checks it against the proxy in this repo.
 * Raise it deliberately, with Guard, after testing.
 */
export const PROXY_VERSION = "0.2.4";
const PROXY_PACKAGE = "@strixgov/mcp-proxy";

/**
 * The client entry that launches the proxy. On Windows, MCP clients spawn the
 * command without a shell, and `npx` is a `.cmd` shim that Node will not
 * spawn that way (EINVAL / ENOENT), so the entry goes through `cmd /c`.
 * isAlreadyWrapped and the coverage audit recognise both forms.
 */
export function proxyLaunchEntry(proxyConfigPath, platform = process.platform) {
  const npxArgs = ["-y", `${PROXY_PACKAGE}@${PROXY_VERSION}`, "--config", proxyConfigPath];
  return platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", ...npxArgs] }
    : { command: "npx", args: npxArgs };
}

/**
 * Approval mode for new wraps. Signed is the default since 0.2.0: an unsigned
 * approval is a file any process running as the user can write. Unsigned
 * needs an explicit opt-out (--unsigned-approvals).
 */
export function resolveApprovalMode(opts = {}) {
  if (opts.signedApprovals && opts.unsignedApprovals) {
    throw new Error("strix-guard init: --signed-approvals and --unsigned-approvals cannot both be set");
  }
  return opts.unsignedApprovals ? "unsigned" : "signed";
}

// A bare package specifier (optionally scoped, optionally versioned). A file
// path such as "/opt/github-mirror/server.js" is not one, so words inside
// paths never pick a capability pack.
const PACKAGE_SPECIFIER = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[^/\s]+)?$/i;

export function packForServer(serverId, entry) {
  const sources = [serverId, basename(entry?.command), ...(entry?.args ?? []).filter(
    (a) => typeof a === "string" && !a.startsWith("-") && PACKAGE_SPECIFIER.test(a),
  )];
  const tokens = new Set(
    sources.flatMap((x) => String(x ?? "").toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean),
  );
  const hit = KNOWN_PACKS.find((p) => tokens.has(p));
  return hit ? `@strixgov/capabilities-mcp-common/${hit}` : null;
}

function basename(command) {
  return typeof command === "string" ? command.split(/[\\/]/).pop() : "";
}

/**
 * True only when the entry launches the Strix proxy with a proxy config:
 * some argument is exactly the proxy package (optionally versioned) or the
 * command is the proxy binary, AND the entry carries `--config <file>`.
 * A server that merely mentions the proxy name is a direct route and is not
 * skipped. This is a structural check; the coverage audit then verifies the
 * named proxy config is readable and names an upstream.
 */
export function isAlreadyWrapped(entry) {
  if (!entry || typeof entry.command !== "string") return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const i = args.indexOf("--config");
  if (i < 0 || typeof args[i + 1] !== "string" || args[i + 1].length === 0) return false;
  const proxyArg = new RegExp(`^${PROXY_PACKAGE.replace("/", "\\/")}(@[^/\\s]+)?$`);
  if (args.some((a) => typeof a === "string" && proxyArg.test(a))) return true;
  return /^strix-mcp-proxy(\.cmd|\.exe|\.mjs)?$/i.test(basename(entry.command));
}

/**
 * The proxy config a wrapped entry launches, if it is one this Guard home
 * wrote (inside its servers directory); otherwise null. Used by init to
 * re-point Guard's own entries at a new pinned proxy, and by uninstall to
 * restore them. Entries pointing elsewhere are not Guard's to change.
 */
export function guardOwnedProxyConfig(entry, serversDir) {
  if (!isAlreadyWrapped(entry)) return null;
  const i = entry.args.indexOf("--config");
  const cfg = entry.args[i + 1];
  const rel = path.relative(path.resolve(serversDir), path.resolve(cfg));
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel) ? cfg : null;
}

/**
 * Require approvals to be signed by the given approver key (pure). The proxy
 * refuses any approving response not signed by it.
 */
export function applySignedApprovals(approval, approver) {
  approval.requireSignedResponse = true;
  approval.approverKeys = [{ publicKey: approver.publicKey, kid: approver.kid, label: approver.label }];
  return approval;
}

/** Build the per-server proxy config object (pure). */
export function buildProxyConfig({ serverId, entry, paths, webhookUrl, approver }) {
  const pack = packForServer(serverId, entry);
  const approval = {
    enabled: true,
    type: webhookUrl ? "webhook" : "file",
    requestDir: paths.approvalsDir,
    timeoutMs: 300_000,
  };
  if (webhookUrl) approval.webhookUrl = webhookUrl;
  if (approver) applySignedApprovals(approval, approver);
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
 *   auditExtra?: string[], // sibling configs to include in the coverage audit
 *   signedApprovals?: boolean,   // accepted for compatibility; signed is the default
 *   unsignedApprovals?: boolean, // explicit opt-out: file approvals any local process can write
 *   createApprover?: () => Promise<object>, // called when signed mode has no key yet (the CLI prompts in a TTY)
 *   platform?: NodeJS.Platform,
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

  const mode = resolveApprovalMode(opts);
  let approver = null;
  if (mode === "signed") {
    approver = await readApproverPublic(opts.env ?? process.env);
    if (!approver && !opts.dryRun) {
      if (opts.createApprover) approver = await opts.createApprover();
      if (!approver) {
        throw new Error(
          "strix-guard init: signed approvals are the default and no approver key exists.\n" +
          "  Create one (in a terminal):  strix-guard approver init\n" +
          "  Or opt out explicitly:       strix-guard init --unsigned-approvals\n" +
          "  (Unsigned approvals are files that any process running as you, including the agent, can write.)",
        );
      }
    }
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
      // An entry an older Guard wrote launches an older pinned proxy. Re-point
      // it at this Guard's pinned proxy; the proxy config is left as it is.
      const owned = guardOwnedProxyConfig(entry, paths.serversDir);
      const target = owned ? proxyLaunchEntry(owned, opts.platform) : null;
      if (target && JSON.stringify([entry.command, entry.args]) !== JSON.stringify([target.command, target.args])) {
        plan.push({ serverId, action: "upgrade", reason: `re-pointed to ${PROXY_PACKAGE}@${PROXY_VERSION}`, entry: { ...entry, ...target } });
      } else {
        plan.push({ serverId, action: "skip", reason: "already wrapped" });
      }
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
      proxyConfig: buildProxyConfig({ serverId, entry, paths, webhookUrl: opts.webhook, approver }),
    });
  }

  const wraps = plan.filter((p) => p.action === "wrap");
  const upgrades = plan.filter((p) => p.action === "upgrade");
  if (opts.dryRun) {
    log(`[strix-guard] dry run — would wrap ${wraps.length} server(s) in ${detected.path} (approvals: ${mode}${mode === "signed" && !approver ? ", needs an approver key first" : ""}):`);
    for (const p of plan) log(`  ${p.action.padEnd(4)} ${p.serverId}${p.pack ? ` (pack: ${p.pack})` : ""}${p.reason ? ` — ${p.reason}` : ""}`);
    return { configPath: detected.path, kind: detected.kind, wrapped: 0, upgraded: 0, skipped: plan.filter((p) => p.action === "skip").length, dryRun: true, approvals: mode, plan };
  }

  if (wraps.length > 0 || upgrades.length > 0) {
    // Backup BEFORE any write, then guard-home dirs, then proxy configs,
    // then the client config rewrite — a crash mid-way leaves the backup
    // plus at worst orphaned proxy configs, never a broken client config
    // without a backup.
    // The backup holds the original config, secrets included, so it goes in
    // the guard home (owner-only), never beside a project config that may be
    // committed.
    await fs.mkdir(paths.backupsDir, { recursive: true, mode: 0o700 });
    const tag = createHash("sha256").update(path.resolve(detected.path)).digest("hex").slice(0, 8);
    const backupPath = path.join(
      paths.backupsDir,
      `${path.basename(detected.path)}.${tag}.bak-strix-guard-${Date.now()}`,
    );
    await fs.writeFile(backupPath, raw, { mode: 0o600 });
    await fs.mkdir(paths.serversDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.approvalsDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.receiptsDir, { recursive: true, mode: 0o700 });

    for (const p of wraps) {
      await fs.writeFile(p.proxyConfigPath, JSON.stringify(p.proxyConfig, null, 2) + "\n", { mode: 0o600 });
      servers[p.serverId] = proxyLaunchEntry(p.proxyConfigPath, opts.platform);
    }
    for (const p of upgrades) servers[p.serverId] = p.entry;
    await fs.writeFile(detected.path, JSON.stringify(clientConfig, null, 2) + "\n");

    // Local-only activation state — never transmitted.
    const state = await readState(paths.statePath);
    state.initializedAt ??= new Date().toISOString();
    state.wrappedServers = Array.from(
      new Set([...(state.wrappedServers ?? []), ...wraps.map((p) => p.serverId)]),
    );
    await fs.writeFile(paths.statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });

    if (wraps.length > 0) log(`[strix-guard] wrapped ${wraps.length} server(s) in ${detected.path}`);
    if (upgrades.length > 0) log(`[strix-guard] re-pointed ${upgrades.length} server(s) wrapped by an older Guard to ${PROXY_PACKAGE}@${PROXY_VERSION}`);
    log(`[strix-guard] backup (contains your original config, secrets included; keep it private): ${backupPath}`);
  } else {
    log(`[strix-guard] nothing to wrap in ${detected.path} (all servers already wrapped and current)`);
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
    if (!approver) log("");
    if (!approver) log(`WARNING: unsigned approvals (--unsigned-approvals). Approvals are files in ${paths.approvalsDir}. Any process running as your OS user can write one, including an agent with shell or file-write access, and Guard does not check who wrote it. The recorded approver name is whatever the file says. To require a signature: strix-guard approver init, then strix-guard init.`);
    if (!opts.webhook) {
      log("");
      log("Tip: re-run with --webhook <slack-incoming-webhook-url> to get pinged where you live.");
    }
  }

  let upgraded = [];
  if (approver && !opts.dryRun) {
    upgraded = await requireSignedInExistingConfigs(paths.serversDir, approver, new Set(wraps.map((p) => `${p.serverId}.json`)));
    if (upgraded.length > 0) log(`[strix-guard] signed approvals now required for: ${upgraded.join(", ")} (restart your MCP client)`);
  }
  if (approver) {
    log("");
    log(`Signed approvals: a write now proceeds only when approved with a signature from "${approver.label}" [key ${approver.kid.slice(0, 8)}], made in a terminal with your approver passphrase. This stops an agent forging an approval by writing a file. It does not stop a process that can edit ${paths.serversDir} and restart the proxy, or guess a weak passphrase offline; for that, run the agent as a different OS user.`);
  }

  // Coverage audit: installing the proxy is not the same as covering the
  // route. Read-only; never rewrites any config.
  const coverage = await auditCoverage({
    cwd: opts.cwd, env: opts.env, homeDir: opts.homeDir, configs: opts.auditConfigs,
    wrapped: [detected.path], extraConfigs: opts.auditExtra ?? [],
  });
  log("");
  for (const line of formatCoverage(coverage)) log(line);
  try {
    await fs.mkdir(paths.home, { recursive: true, mode: 0o700 });
    await fs.writeFile(paths.coveragePath, JSON.stringify(coverage, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    log(`[strix-guard] could not write coverage report: ${err?.code ?? err?.message}`);
  }

  return {
    configPath: detected.path,
    kind: detected.kind,
    wrapped: wraps.length,
    upgraded: upgrades.length,
    skipped: plan.filter((p) => p.action === "skip").length,
    dryRun: false,
    approvals: mode,
    plan,
    coverage,
  };
}

/** Make Guard's own per-server proxy configs require signed approvals. */
async function requireSignedInExistingConfigs(serversDir, approver, skip) {
  const done = [];
  const names = await fs.readdir(serversDir).catch(() => []);
  for (const name of names) {
    if (!name.endsWith(".json") || skip.has(name)) continue;
    const file = path.join(serversDir, name);
    try {
      const cfg = JSON.parse(await fs.readFile(file, "utf8"));
      if (!cfg?.approval || cfg.approval.enabled === false) continue;
      applySignedApprovals(cfg.approval, approver);
      await fs.writeFile(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
      done.push(name.replace(/\.json$/, ""));
    } catch {
      /* unreadable proxy config: left as it was; the audit reports it */
    }
  }
  return done;
}

async function readState(statePath) {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch {
    return {};
  }
}
