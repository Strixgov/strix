/**
 * Agent Key Registry Source — AA-1 PR 1C.2
 *
 * Resolves the agent-key registry from two sources and merges them with
 * strict precedence:
 *
 *   1. DB-backed entries (the source of truth in production). Caller
 *      supplies these via the `dbEntries` argument; this module is pure
 *      and does NOT talk to a database directly (the strix-platform side
 *      owns the DB reader at `apps/strix-console/src/lib/agents/
 *      agent-key-entries.ts`).
 *
 *   2. Env override entries from `STRIX_AGENT_KEY_REGISTRY`, parsed once
 *      at module-load. JSON array of `AgentKeyEntryInput` shapes.
 *
 * Resolution rules (plan §2.1, load-bearing):
 *
 *   - DB-first: every DB entry is admitted before any env override is
 *     considered.
 *   - Env overrides are ONLY admitted for kids that are not present in
 *     DB. If an env override declares a kid that DB also declares, we
 *     throw `AgentKeyRegistryCollisionError`. Env MUST NEVER silently
 *     shadow DB.
 *   - The "collision" is by kid, not by (agentId, kid). Two entries with
 *     the same kid but different agent IDs are a separate error (caught
 *     at registry add()) — we don't need to discover that here.
 *
 * The "shadow" rule is what makes the env override safe for local dev
 * and CI without becoming a production attack surface — if your env file
 * accidentally contains a key that production DB also has, you'll
 * notice at startup (collision throws), not after a silent override
 * lets a stale env key sign things.
 *
 * See `docs/gates/AA-1-PR-1C2-IMPLEMENTATION-PLAN.md` §2.1 for the
 * locked decisions behind this module.
 */

import type {
  AgentKeyEntryInput,
  ChainVerifier,
  LoadAgentKeysResult,
  RevocationCheck,
} from "./loader.js";
import {
  loadAgentKeyRegistry,
  isAgentAttestationFlagOn,
} from "./loader.js";
import { EMPTY_AGENT_KEY_REGISTRY } from "./registry.js";

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown when an env-override entry declares a kid that is also present
 * in the DB-supplied set. The caller's job is to surface this loudly at
 * boot — never silently swallow it.
 */
export class AgentKeyRegistryCollisionError extends Error {
  readonly code = "AGENT_KEY_REGISTRY_COLLISION" as const;
  constructor(
    readonly kid: string,
    readonly sources: ReadonlyArray<"db" | "env">,
  ) {
    super(
      `AgentKeyRegistry collision on kid "${kid}". Sources: ${sources.join(", ")}. ` +
        `Env overrides must not shadow DB entries. Remove the offending entry from ` +
        `STRIX_AGENT_KEY_REGISTRY or rotate the kid before re-deploying.`,
    );
    this.name = "AgentKeyRegistryCollisionError";
  }
}

/**
 * Thrown when `STRIX_AGENT_KEY_REGISTRY` is set but cannot be parsed as
 * a JSON array of `AgentKeyEntryInput`. We never silently treat an
 * unparseable override as "empty" — that would be a fail-open footgun.
 */
export class AgentKeyEnvParseError extends Error {
  readonly code = "AGENT_KEY_ENV_PARSE" as const;
  constructor(detail: string) {
    super(
      `STRIX_AGENT_KEY_REGISTRY parse failed: ${detail}. Expected JSON array ` +
        `of AgentKeyEntryInput shapes.`,
    );
    this.name = "AgentKeyEnvParseError";
  }
}

// ─── Env parsing ────────────────────────────────────────────────────────────

/**
 * Parse the `STRIX_AGENT_KEY_REGISTRY` env var. Returns an empty array
 * when the var is unset or empty-string. Throws `AgentKeyEnvParseError`
 * on malformed JSON or non-array root.
 *
 * Exported for tests; production callers should go through
 * `resolveAgentKeyRegistry`.
 */
export function parseAgentKeyRegistryEnv(
  raw: string | undefined,
): AgentKeyEntryInput[] {
  if (raw === undefined || raw === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AgentKeyEnvParseError(
      e instanceof Error ? e.message : String(e),
    );
  }

  if (!Array.isArray(parsed)) {
    throw new AgentKeyEnvParseError(
      `expected array root, got ${typeof parsed}`,
    );
  }

  // We do shallow shape validation here — the loader does the deep
  // validation (chain verify, kid format, JWK agreement). The env path
  // is for dev/CI/emergency recovery; if the operator can't write valid
  // JSON, the loader will reject it cleanly with a per-entry code.
  return parsed as AgentKeyEntryInput[];
}

// ─── Public surface ─────────────────────────────────────────────────────────

export interface ResolveAgentKeyRegistryOptions {
  /** DB-sourced entries, in any order. Required arg — never optional. */
  dbEntries: ReadonlyArray<AgentKeyEntryInput>;
  /**
   * Caller-supplied chain verifier. Bind to the SDK's
   * `createDefaultChainVerifier()` on the platform side; tests inject a
   * stub.
   */
  chainVerifier: ChainVerifier;
  /** Optional pre-registration revocation check. */
  revocationCheck?: RevocationCheck;
  /**
   * Override for `STRIX_AGENT_KEY_REGISTRY`. When omitted, the var is
   * read from `process.env`. Tests pass a string to avoid env mutation.
   */
  envOverrideRaw?: string;
  /** Forwarded to `loadAgentKeyRegistry`. */
  flagOverride?: "on" | "off";
}

export interface ResolveAgentKeyRegistryResult extends LoadAgentKeysResult {
  /** Count of entries admitted from each source — handy for boot logging. */
  source: { db: number; env: number };
}

/**
 * Resolve the agent-key registry from DB + env override.
 *
 * Behavior under the master kill switch:
 *   - `STRIX_ACTOR_ATTESTATION_V1=false` (default): empty registry,
 *     empty result. Same posture as `loadAgentKeyRegistry` — the env
 *     override is also ignored when the flag is off, to keep the
 *     dormant state truly dormant.
 */
export function resolveAgentKeyRegistry(
  opts: ResolveAgentKeyRegistryOptions,
): ResolveAgentKeyRegistryResult {
  const flagOn =
    opts.flagOverride === "on" ||
    (opts.flagOverride !== "off" && isAgentAttestationFlagOn());

  if (!flagOn) {
    return {
      registry: EMPTY_AGENT_KEY_REGISTRY,
      loaded: [],
      rejected: [],
      source: { db: 0, env: 0 },
    };
  }

  const envOverrideRaw =
    opts.envOverrideRaw ?? process.env.STRIX_AGENT_KEY_REGISTRY;
  const envEntries = parseAgentKeyRegistryEnv(envOverrideRaw);

  // Build the kid-set of DB entries up front so env collisions throw
  // BEFORE the loader admits anything. Hard-throw posture: a misconfigured
  // env should fail boot, not silently log.
  const dbKids = new Set<string>();
  for (const entry of opts.dbEntries) {
    if (dbKids.has(entry.kid)) {
      // DB-internal collision is the DB reader's problem — but defensively
      // surface it the same way (the table has UNIQUE (tenant_id, kid),
      // but a single-tenant reader returning duplicates is still a bug).
      throw new AgentKeyRegistryCollisionError(entry.kid, ["db", "db"]);
    }
    dbKids.add(entry.kid);
  }

  for (const entry of envEntries) {
    if (dbKids.has(entry.kid)) {
      throw new AgentKeyRegistryCollisionError(entry.kid, ["db", "env"]);
    }
  }

  // DB first, then env. Order matters because the loader walks entries
  // in order; the env-tail position makes it observable in `loaded[]`
  // which entries came from which source (entries are stable-ordered).
  const merged: AgentKeyEntryInput[] = [...opts.dbEntries, ...envEntries];

  const result = loadAgentKeyRegistry({
    entries: merged,
    chainVerifier: opts.chainVerifier,
    revocationCheck: opts.revocationCheck,
    flagOverride: "on", // we already gated on the flag above
  });

  return {
    ...result,
    source: { db: opts.dbEntries.length, env: envEntries.length },
  };
}
