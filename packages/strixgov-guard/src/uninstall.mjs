/**
 * `strix-guard uninstall` — put a client config's servers back the way they
 * were before Guard wrapped them.
 *
 * Each wrapped entry names its Guard proxy config (`--config <file>`), and
 * that file holds the original upstream command, args and env verbatim. This
 * restores each entry from its own proxy config rather than copying a whole
 * backup over the client config, so edits made to the client config after
 * `init` (new servers, other settings) are kept.
 *
 * It only restores entries whose proxy config lives in this Guard home's
 * servers directory. An entry that launches the proxy with some other config
 * is not Guard's and is left alone, and so is an entry whose proxy config is
 * missing or names no upstream: those are reported, never guessed at.
 *
 * The client config is backed up first. ~/.strix-guard is not deleted:
 * receipts stay verifiable offline, and deleting the directory is the user's
 * decision.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { guardHome, guardPaths, detectClientConfig } from "./paths.mjs";
import { isAlreadyWrapped, guardOwnedProxyConfig } from "./init.mjs";

/**
 * @param {{ config?: string, dryRun?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, log?: (l: string) => void }} opts
 */
export async function runUninstall(opts = {}) {
  const log = opts.log ?? console.error;
  const paths = guardPaths(guardHome(opts.env ?? process.env));
  const detected = detectClientConfig({ explicit: opts.config, cwd: opts.cwd });
  if (!detected) {
    throw new Error(opts.config
      ? `strix-guard uninstall: config not found: ${opts.config}`
      : "strix-guard uninstall: no MCP client config found. Pass --config <path>.");
  }
  const raw = await fs.readFile(detected.path, "utf8");
  let clientConfig;
  try {
    clientConfig = JSON.parse(raw);
  } catch (err) {
    throw new Error(`strix-guard uninstall: could not parse ${detected.path}: ${err.message}`);
  }
  const servers = clientConfig?.mcpServers ?? {};

  const plan = [];
  for (const [serverId, entry] of Object.entries(servers)) {
    if (!isAlreadyWrapped(entry)) continue;
    const cfgPath = guardOwnedProxyConfig(entry, paths.serversDir);
    if (!cfgPath) {
      plan.push({ serverId, action: "skip", reason: "launches the proxy with a config outside this Guard home; not Guard's to restore" });
      continue;
    }
    let up = null;
    try {
      up = JSON.parse(await fs.readFile(cfgPath, "utf8"))?.upstream ?? null;
    } catch {
      /* reported below */
    }
    if (!up || typeof up.command !== "string" || up.command.length === 0) {
      plan.push({ serverId, action: "skip", reason: `proxy config ${cfgPath} is missing or names no upstream; restore this entry from a backup in ${paths.backupsDir}` });
      continue;
    }
    const restored = { command: up.command, args: Array.isArray(up.args) ? up.args : [], ...(up.env ? { env: up.env } : {}) };
    plan.push({ serverId, action: "restore", restored });
  }

  const restores = plan.filter((p) => p.action === "restore");
  if (!opts.dryRun && restores.length > 0) {
    await fs.mkdir(paths.backupsDir, { recursive: true, mode: 0o700 });
    const tag = createHash("sha256").update(path.resolve(detected.path)).digest("hex").slice(0, 8);
    const backupPath = path.join(paths.backupsDir, `${path.basename(detected.path)}.${tag}.bak-strix-guard-uninstall-${Date.now()}`);
    await fs.writeFile(backupPath, raw, { mode: 0o600 });
    for (const p of restores) servers[p.serverId] = p.restored;
    await fs.writeFile(detected.path, JSON.stringify(clientConfig, null, 2) + "\n");
    log(`[strix-guard] backup of the wrapped config: ${backupPath}`);
  }

  log(`[strix-guard] ${opts.dryRun ? "dry run — would restore" : "restored"} ${restores.length} server(s) in ${detected.path}`);
  for (const p of plan) log(`  ${p.action.padEnd(7)} ${p.serverId}${p.reason ? ` — ${p.reason}` : ""}`);
  if (plan.length === 0) log("  (no Guard-wrapped servers in this config)");
  if (!opts.dryRun && restores.length > 0) {
    log("");
    log("Restart your MCP client. These servers now run without Guard: no approvals, no receipts.");
    log(`${paths.home} was kept (receipts stay verifiable). Delete it yourself if you no longer need them.`);
  }
  return { configPath: detected.path, restored: opts.dryRun ? 0 : restores.length, dryRun: !!opts.dryRun, plan };
}
