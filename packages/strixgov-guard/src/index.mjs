/**
 * @strixgov/guard — the seatbelt for MCP agents.
 *
 * Programmatic surface for the CLI commands. The proxy that actually
 * enforces governance is @strixgov/mcp-proxy; this package only writes
 * configuration and operates the human side of the approval loop.
 */
export { runInit, buildProxyConfig, packForServer, isAlreadyWrapped } from "./init.mjs";
export { listPending, respond } from "./approvals.mjs";
export { guardHome, guardPaths, detectClientConfig, claudeDesktopConfigPath } from "./paths.mjs";
