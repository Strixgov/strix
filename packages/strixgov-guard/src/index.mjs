/**
 * @strixgov/guard — the seatbelt for MCP agents.
 *
 * Programmatic surface for the CLI commands. The proxy that actually
 * enforces governance is @strixgov/mcp-proxy; this package only writes
 * configuration and operates the human side of the approval loop.
 */
export { runInit, buildProxyConfig, packForServer, isAlreadyWrapped, proxyLaunchEntry, resolveApprovalMode, guardOwnedProxyConfig, PROXY_VERSION } from "./init.mjs";
export { runUninstall } from "./uninstall.mjs";
export { listPending, respond } from "./approvals.mjs";
export { guardHome, guardPaths, detectClientConfig, claudeDesktopConfigPath, knownClientConfigs } from "./paths.mjs";
export { auditCoverage, formatCoverage, upstreamFingerprint, COVERAGE_SCHEMA } from "./coverage.mjs";
export { createApproverKey, readApproverPublic, approveSigned, approverPaths, MIN_PASSPHRASE_LENGTH } from "./approver.mjs";
