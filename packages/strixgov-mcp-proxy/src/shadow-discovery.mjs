/**
 * Shadow discovery — runtime reconciliation for static governed-surface
 * discovery (GSD-1 Phase 4; program doc:
 * solo-builder-core/docs/proposals/governed-surface-discovery-v1.md).
 *
 * Static scanners (the /strix-wire scanner, `solo govern scan`, the
 * Semgrep pack) can only find action points that pattern-match in
 * source. They structurally cannot see (a) tools an upstream MCP server
 * exposes that no companion capability pack has classified, or (b) the
 * genuinely runtime-decided agent tool call. The proxy already sits on
 * the live tool-call path, so it is the natural observation point: this
 * module records what the upstream ACTUALLY advertises and what the
 * agent ACTUALLY calls, and reports the delta against the classified
 * capability registry.
 *
 * Two honesty rules, both load-bearing:
 *
 *   1. **Observation only, never enforcement.** Shadow discovery reads
 *      the same events the proxy already handles; it never changes a
 *      verdict, never blocks a call, never touches the policy /
 *      approval / receipt pipeline. Every enforcement decision remains
 *      with governMCPServer.
 *
 *   2. **Unsigned measurement, never proof.** The shadow log and every
 *      snapshot carry a mandatory `measurement` disclaimer and are
 *      shaped nothing like a signed receipt (no signature, no kid, no
 *      canonical payload). A shadow report says "the runtime saw X" —
 *      it proves nothing and must never be rendered as if it did.
 *
 * Output surfaces:
 *   - in-memory `snapshot()` for programmatic consumers / the CLI,
 *   - an append-only JSONL log at `<storagePath>/shadow-discovery.jsonl`
 *     when a storagePath is configured (same lifecycle as receipts).
 */

import fs from "node:fs";
import path from "node:path";

export const SHADOW_MEASUREMENT_DISCLAIMER =
  "unsigned measurement, never proof — runtime observation only";

export const SHADOW_LOG_BASENAME = "shadow-discovery.jsonl";

/**
 * Create a shadow-discovery recorder.
 *
 * @param {{
 *   serverId?: string,
 *   capabilities?: Array<{ name?: string, id?: string }>,
 *   storagePath?: string | null,
 *   onAudit?: (event: { kind: string, detail: object }) => void,
 *   now?: () => string,
 * }} [opts]
 */
export function createShadowDiscovery(opts = {}) {
  const serverId = opts.serverId ?? "proxy";
  const now = opts.now ?? (() => new Date().toISOString());

  // The classified universe: tool names the companion capability pack
  // (or an inline caller-managed list) already knows. A tool outside
  // this set still executes under the gateway's generic fallback
  // classification — but static discovery never saw it, which is
  // exactly what this module exists to surface.
  const classifiedNames = new Set(
    (opts.capabilities ?? [])
      .map((cap) => cap?.name)
      .filter((name) => typeof name === "string" && name.length > 0),
  );

  const logPath = opts.storagePath
    ? path.join(opts.storagePath, SHADOW_LOG_BASENAME)
    : null;

  /** @type {Map<string, { name: string, description?: string, classified: boolean }>} */
  const advertised = new Map();
  /** @type {Map<string, number>} */
  const calls = new Map();
  /** @type {Map<string, number>} */
  const unclassifiedCalls = new Map();

  function audit(kind, detail) {
    if (typeof opts.onAudit === "function") {
      try { opts.onAudit({ kind, detail }); } catch { /* observation must never throw */ }
    }
  }

  function appendLog(entry) {
    if (!logPath) return;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(
        logPath,
        JSON.stringify({
          measurement: SHADOW_MEASUREMENT_DISCLAIMER,
          serverId,
          at: now(),
          ...entry,
        }) + "\n",
        "utf8",
      );
    } catch {
      // Best-effort telemetry: a full disk or read-only mount must never
      // take down the governed call path this module merely observes.
    }
  }

  return {
    logPath,

    /**
     * Record the upstream's advertised tool universe (a tools/list
     * response). Newly-seen unclassified tools are logged + audited —
     * each one is a surface static discovery missed.
     *
     * @param {Array<{ name: string, description?: string }>} tools
     */
    recordToolList(tools) {
      if (!Array.isArray(tools)) return;
      const newlyUnclassified = [];
      for (const tool of tools) {
        const name = tool?.name;
        if (typeof name !== "string" || name.length === 0) continue;
        const known = advertised.has(name);
        const classified = classifiedNames.has(name);
        advertised.set(name, { name, description: tool.description, classified });
        if (!known && !classified) newlyUnclassified.push(name);
      }
      if (newlyUnclassified.length > 0) {
        audit("shadow.unclassified-tools", { serverId, tools: newlyUnclassified });
        appendLog({ kind: "tool-list", unclassified: newlyUnclassified, advertised: tools.length });
      }
    },

    /**
     * Record a tool invocation flowing through the proxy. Counting
     * happens regardless of the governance verdict — a denied call is
     * still an observed action surface.
     *
     * @param {string} name
     */
    recordCall(name) {
      if (typeof name !== "string" || name.length === 0) return;
      calls.set(name, (calls.get(name) ?? 0) + 1);
      if (!classifiedNames.has(name)) {
        const n = (unclassifiedCalls.get(name) ?? 0) + 1;
        unclassifiedCalls.set(name, n);
        // First sighting of each unclassified tool gets an audit event
        // + a log line; repeat calls only bump the counter (a chatty
        // agent shouldn't flood the shadow log).
        if (n === 1) {
          audit("shadow.unclassified-call", { serverId, tool: name });
          appendLog({ kind: "unclassified-call", tool: name });
        }
      }
    },

    /**
     * The reconciliation report: what the runtime saw vs what static
     * classification covers. Type-disjoint from receipts by
     * construction (no signature-shaped fields), with the mandatory
     * measurement disclaimer on every snapshot.
     */
    snapshot() {
      const advertisedList = [...advertised.values()];
      return {
        measurement: SHADOW_MEASUREMENT_DISCLAIMER,
        serverId,
        classifiedCapabilityCount: classifiedNames.size,
        advertisedToolCount: advertisedList.length,
        unclassifiedAdvertised: advertisedList
          .filter((t) => !t.classified)
          .map((t) => t.name)
          .sort(),
        callCounts: Object.fromEntries([...calls.entries()].sort()),
        unclassifiedCallCounts: Object.fromEntries([...unclassifiedCalls.entries()].sort()),
      };
    },
  };
}
