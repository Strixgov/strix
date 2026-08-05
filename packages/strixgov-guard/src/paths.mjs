/**
 * Path resolution for Strix Guard — the guard home directory and the
 * MCP client-config auto-detection order.
 *
 * Guard home (override with STRIX_GUARD_HOME, used by tests):
 *   ~/.strix-guard/
 *     servers/<id>.json   per-server @strixgov/mcp-proxy config
 *     approvals/          request/response files (the decision channel)
 *     receipts/<id>/      signed receipts per wrapped server
 *     state.json          local-only activation state (never sent anywhere)
 *
 * Client-config detection order (first existing wins; --config overrides):
 *   1. ./.mcp.json                         Claude Code project config
 *   2. Claude Desktop per-OS config
 *   3. ~/.cursor/mcp.json                  Cursor
 */
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

export function guardHome(env = process.env) {
  return env.STRIX_GUARD_HOME && env.STRIX_GUARD_HOME.length > 0
    ? env.STRIX_GUARD_HOME
    : path.join(os.homedir(), ".strix-guard");
}

export function guardPaths(home = guardHome()) {
  return {
    home,
    serversDir: path.join(home, "servers"),
    approvalsDir: path.join(home, "approvals"),
    receiptsDir: path.join(home, "receipts"),
    statePath: path.join(home, "state.json"),
  };
}

export function claudeDesktopConfigPath(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

/**
 * Detect the MCP client config to wrap. Returns { path, kind } or null.
 * `explicit` (from --config) short-circuits detection but must exist.
 */
export function detectClientConfig({ explicit, cwd = process.cwd() } = {}) {
  if (explicit) {
    return existsSync(explicit) ? { path: explicit, kind: "explicit" } : null;
  }
  const candidates = [
    { path: path.join(cwd, ".mcp.json"), kind: "claude-code" },
    { path: claudeDesktopConfigPath(), kind: "claude-desktop" },
    { path: path.join(os.homedir(), ".cursor", "mcp.json"), kind: "cursor" },
  ];
  for (const c of candidates) {
    if (existsSync(c.path)) return c;
  }
  return null;
}
