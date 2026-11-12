/**
 * Guard Coverage Audit — separates "the proxy is installed" from "the
 * route is covered".
 *
 * Guard governs calls that pass through the proxy. A second client
 * config that still launches the same MCP server directly is a route
 * the proxy never sees. This audit READS the client configs Guard knows
 * about and reports, per server, whether each entry is proxied or
 * direct. It never modifies a config and never executes a server.
 *
 * Honesty rules (pinned by test):
 *  - Overall status is never "complete". The best it can say is
 *    COVERAGE_ESTABLISHED_FOR_KNOWN_CONFIGS: nothing direct was found in
 *    the places Guard looked. Other clients, direct APIs, other
 *    credentials and unknown configs are outside the audit.
 *  - A config that exists but cannot be read or parsed is
 *    NOT_ESTABLISHED, never treated as covered.
 *  - A direct entry for a server that is also proxied elsewhere is
 *    COVERAGE_INCOMPLETE, and names both configs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { knownClientConfigs } from "./paths.mjs";
import { isAlreadyWrapped } from "./init.mjs";

export const COVERAGE_SCHEMA = "strix-guard-coverage/v1";

const CANNOT_ESTABLISH =
  "A configuration audit cannot prove no other execution path exists (other clients, direct APIs, other credentials, unexamined integrations). Stronger assurance needs credential custody and resource-side authorization.";

/** Stable identity for "the same upstream server", independent of the entry name. */
export function upstreamFingerprint(command, args = []) {
  return [command ?? "", ...args].map(String).join("\u0000").toLowerCase();
}

/** The upstream a proxied entry points at, read from its Guard proxy config. */
async function proxiedUpstream(entry) {
  const args = entry?.args ?? [];
  const i = args.indexOf("--config");
  if (i < 0 || !args[i + 1]) return null;
  try {
    const cfg = JSON.parse(await fs.readFile(args[i + 1], "utf8"));
    if (cfg?.upstream?.command) {
      return {
        command: cfg.upstream.command,
        args: cfg.upstream.args ?? [],
        signedApprovals: cfg.approval?.requireSignedResponse === true,
      };
    }
  } catch {
    /* proxy config unreadable: upstream unknown, reported as such */
  }
  return null;
}

/**
 * @param {{cwd?:string, homeDir?:string, platform?:string, env?:object, configs?:{path:string,kind:string}[]}} opts
 */
export async function auditCoverage(opts = {}) {
  const known = knownClientConfigs(opts);
  const knownPaths = new Set(known.map((c) => path.resolve(c.path)));
  const configs = [];
  const seen = new Set();
  const add = (c) => {
    const k = path.resolve(c.path);
    if (!seen.has(k)) { seen.add(k); configs.push(c); }
  };
  // The config Guard just wrapped is always audited, wherever it lives.
  for (const p of opts.wrapped ?? []) add({ path: p, kind: "wrapped" });
  // Siblings the operator names are audited too.
  for (const p of opts.extraConfigs ?? []) add({ path: p, kind: "named" });
  for (const c of opts.configs ?? known) add(c);
  // Guard cannot discover siblings outside the known locations. If it
  // wrapped a config out there and was not told about any sibling, say so.
  const wrappedOutside = (opts.wrapped ?? []).some((p) => !knownPaths.has(path.resolve(p)));
  const scopeLimited = wrappedOutside && (opts.extraConfigs ?? []).length === 0;
  const entries = [];
  const notEstablished = [];
  const checked = [];

  for (const c of configs) {
    let raw;
    try {
      raw = await fs.readFile(c.path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") {
        checked.push({ ...c, status: "ABSENT" });
        continue;
      }
      checked.push({ ...c, status: "NOT_ESTABLISHED", reason: `unreadable: ${err?.code ?? "error"}` });
      notEstablished.push({ path: c.path, kind: c.kind, reason: `unreadable: ${err?.code ?? "error"}` });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      checked.push({ ...c, status: "NOT_ESTABLISHED", reason: "not valid JSON" });
      notEstablished.push({ path: c.path, kind: c.kind, reason: "not valid JSON" });
      continue;
    }
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object") {
      checked.push({ ...c, status: "NO_SERVERS" });
      continue;
    }
    checked.push({ ...c, status: "READ", servers: Object.keys(servers).length });
    for (const [serverId, entry] of Object.entries(servers)) {
      if (!entry || typeof entry.command !== "string") {
        entries.push({ configPath: c.path, kind: c.kind, serverId, route: "UNKNOWN", reason: "no command (remote or unsupported entry)" });
        continue;
      }
      if (isAlreadyWrapped(entry)) {
        const up = await proxiedUpstream(entry);
        if (!up) {
          // Naming the proxy is not covering the route: with no readable
          // proxy config that points at an upstream, the route is not established.
          entries.push({
            configPath: c.path, kind: c.kind, serverId, route: "UNKNOWN",
            reason: "it launches the proxy but its proxy config could not be read or names no upstream",
          });
          continue;
        }
        entries.push({
          configPath: c.path, kind: c.kind, serverId, route: "PROXIED",
          fingerprint: upstreamFingerprint(up.command, up.args),
          approvals: up.signedApprovals ? "SIGNED" : "UNAUTHENTICATED_FILE",
        });
      } else {
        entries.push({
          configPath: c.path, kind: c.kind, serverId, route: "DIRECT",
          fingerprint: upstreamFingerprint(entry.command, entry.args),
        });
      }
    }
  }

  const proxied = entries.filter((e) => e.route === "PROXIED");
  const direct = entries.filter((e) => e.route === "DIRECT");
  const findings = [];
  for (const d of direct) {
    const sameServer = proxied.filter(
      (p) => (p.fingerprint && p.fingerprint === d.fingerprint) || p.serverId === d.serverId,
    );
    findings.push({
      code: "DIRECT_ROUTE_PRESENT",
      serverId: d.serverId,
      configPath: d.configPath,
      alsoProxiedIn: sameServer.map((p) => p.configPath),
      message: sameServer.length
        ? `Server "${d.serverId}" is launched directly in ${d.configPath} although it is proxied in ${sameServer[0].configPath}. Calls through this entry bypass Guard.`
        : `Server "${d.serverId}" in ${d.configPath} is launched directly. Calls through this entry are not governed by Guard.`,
    });
  }
  for (const e of entries.filter((x) => x.route === "UNKNOWN")) {
    findings.push({ code: "ROUTE_NOT_ESTABLISHED", serverId: e.serverId, configPath: e.configPath, message: `Server "${e.serverId}" in ${e.configPath}: ${e.reason}.` });
  }
  for (const n of notEstablished) {
    findings.push({ code: "CONFIG_NOT_ESTABLISHED", configPath: n.path, message: `${n.path} could not be audited (${n.reason}); not treated as covered.` });
  }

  const nothingRead = !checked.some((c) => c.status === "READ");
  if (nothingRead && !scopeLimited) {
    findings.push({
      code: "SIBLINGS_NOT_EXAMINED",
      message: "No client config could be read, so nothing was audited. Pass --audit-config <path> for each config to check.",
    });
  }
  if (scopeLimited) {
    findings.push({
      code: "SIBLINGS_NOT_EXAMINED",
      message: "The wrapped config is outside Guard's known client-config locations, and no other config was named. Sibling configs elsewhere were NOT examined. Name them with --audit-config <path>.",
    });
  }
  const status = findings.some((f) => f.code !== "SIBLINGS_NOT_EXAMINED")
    ? "COVERAGE_INCOMPLETE"
    : scopeLimited || nothingRead
      ? "COVERAGE_SCOPE_LIMITED"
      : "COVERAGE_ESTABLISHED_FOR_KNOWN_CONFIGS";
  return {
    schema: COVERAGE_SCHEMA,
    status,
    auditedAt: new Date().toISOString(),
    configsChecked: checked,
    entries,
    findings,
    limits: CANNOT_ESTABLISH,
  };
}

/** Human-readable lines for a report (warnings first). */
export function formatCoverage(report) {
  const lines = [];
  if (report.status === "COVERAGE_INCOMPLETE") {
    lines.push("[strix-guard] WARNING: coverage incomplete — some routes are not governed by Guard:");
    for (const f of report.findings) lines.push(`  - ${f.message}`);
    lines.push("  Guard did NOT modify these configs. To govern a route, re-run: strix-guard init --config <path>");
  } else if (report.status === "COVERAGE_SCOPE_LIMITED") {
    lines.push("[strix-guard] NOTE: coverage NOT established beyond the config just wrapped:");
    for (const f of report.findings) lines.push(`  - ${f.message}`);
  } else {
    lines.push("[strix-guard] No direct routes found in the configs audited.");
    lines.push("  This is not proof of complete protection.");
  }
  lines.push(`  Limits: ${report.limits}`);
  return lines;
}
