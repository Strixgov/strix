/**
 * @strixgov/mcp-proxy
 *
 * Public API. Two entry points:
 *
 *   - `startProxy(opts)` — programmatic. Used by the CLI; tests use it
 *     with `transport: { kind: "test", ... }`.
 *   - `loadConfig(path)` — read a proxy config JSON. CLI uses this;
 *     consumers can use it directly to validate a config before
 *     committing it to disk.
 *
 * Mode 3 (Capability-Enforced) is the v0.2.0 upgrade path. The seam
 * is documented in src/proxy.mjs (`buildUpstreamIface`); the
 * cryptographic primitive is already shipped at
 * `@strixgov/mcp-token-validator`.
 */

export { startProxy } from "./proxy.mjs";
export { loadConfig, resolveCapabilities } from "./config.mjs";
export {
  createShadowDiscovery,
  SHADOW_LOG_BASENAME,
  SHADOW_MEASUREMENT_DISCLAIMER,
} from "./shadow-discovery.mjs";
