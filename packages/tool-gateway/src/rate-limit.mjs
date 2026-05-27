/**
 * Per-capability sliding-window rate limiter.
 *
 * Configuration is keyed by capability id; values are
 *
 *   { windowMs, max, perActor? }
 *
 * Glob-style prefixes are supported: a key ending in `.*` matches any
 * capabilityId that starts with the prefix (e.g. `filesystem.*` matches
 * `filesystem.read`, `filesystem.write`). The most-specific matching key
 * wins (longest prefix > glob > absent).
 *
 * `perActor: true` partitions the bucket by `invocation.actorId`. Without
 * it the limit is shared across all callers.
 *
 * The limiter is in-memory and single-process. For multi-process /
 * distributed enforcement, swap in a Redis-backed driver (out of scope
 * for v0.2 — the interface is `check({capabilityId, actorId})` so a
 * future driver lands without touching the gateway).
 *
 * Why advisory not policy: rate limits are operationally tunable (a
 * traffic spike, a backfill, a noisy bot). Folding them into the
 * deterministic policy hash would force a `policyVersion` bump every
 * time an SRE adjusts a quota, which would invalidate every receipt's
 * comparable lineage. Keeping them at the gateway boundary lets us
 * tighten/relax limits without rotating the policy version.
 */

const DEFAULT_BUCKET_KEY = "__shared__";

/**
 * @typedef {{ windowMs: number, max: number, perActor?: boolean, maxActors?: number }} RateLimitRule
 */

export class RateLimiter {
  /**
   * @param {Record<string, RateLimitRule>} [rules]
   * @param {{ now?: () => number, maxActors?: number }} [opts]
   */
  constructor(rules = {}, opts = {}) {
    this._rules = normaliseRules(rules);
    /** Map<ruleKey, Map<bucketKey, number[]>> */
    this._buckets = new Map();
    this._now = opts.now ?? (() => Date.now());
    // Global default cap on unique per-actor buckets per rule.
    // Prevents unbounded memory growth when an adversary sends requests
    // with many unique actorId values. Evicts by insertion order (FIFO)
    // when the cap is reached. Per-rule maxActors override takes priority.
    this._maxActors = opts.maxActors ?? 10_000;
  }

  /**
   * @param {{ capabilityId: string, actorId?: string }} ctx
   * @returns {{ allowed: boolean, remaining: number, resetAt?: number, reason?: string, ruleKey?: string }}
   */
  check(ctx) {
    const match = this._match(ctx.capabilityId);
    if (!match) {
      return { allowed: true, remaining: Infinity };
    }
    const { ruleKey, rule } = match;
    const bucketKey = rule.perActor ? ctx.actorId ?? DEFAULT_BUCKET_KEY : DEFAULT_BUCKET_KEY;
    let perRule = this._buckets.get(ruleKey);
    if (!perRule) {
      perRule = new Map();
      this._buckets.set(ruleKey, perRule);
    }
    let timestamps = perRule.get(bucketKey);
    if (!timestamps) {
      // Enforce unique-actor cap before inserting a new bucket.
      // Evicts the oldest-inserted actor (Map insertion order is stable).
      const maxActors = rule.maxActors ?? this._maxActors;
      if (perRule.size >= maxActors) {
        perRule.delete(perRule.keys().next().value);
      }
      timestamps = [];
      perRule.set(bucketKey, timestamps);
    }
    const now = this._now();
    const cutoff = now - rule.windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= rule.max) {
      const oldest = timestamps[0];
      return {
        allowed: false,
        remaining: 0,
        resetAt: oldest + rule.windowMs,
        reason: "RATE_LIMITED",
        ruleKey,
      };
    }
    timestamps.push(now);
    return {
      allowed: true,
      remaining: rule.max - timestamps.length,
      ruleKey,
    };
  }

  /**
   * Resolve the most specific rule for a capability id.
   *
   * @param {string} capabilityId
   * @returns {{ ruleKey: string, rule: RateLimitRule } | null}
   */
  _match(capabilityId) {
    if (this._rules.exact.has(capabilityId)) {
      return {
        ruleKey: capabilityId,
        rule: this._rules.exact.get(capabilityId),
      };
    }
    let best = null;
    for (const { prefix, rule, key } of this._rules.prefixes) {
      if (capabilityId.startsWith(prefix)) {
        if (!best || prefix.length > best.prefix.length) {
          best = { prefix, rule, key };
        }
      }
    }
    return best ? { ruleKey: best.key, rule: best.rule } : null;
  }

  /**
   * Force-clear a bucket. Useful for tests or admin override.
   *
   * @param {string} [capabilityId]
   * @param {string} [actorId]
   */
  reset(capabilityId, actorId) {
    if (!capabilityId) {
      this._buckets.clear();
      return;
    }
    const match = this._match(capabilityId);
    if (!match) return;
    const perRule = this._buckets.get(match.ruleKey);
    if (!perRule) return;
    if (!actorId) {
      perRule.clear();
      return;
    }
    perRule.delete(actorId);
  }
}

/**
 * @param {Record<string, RateLimitRule>} rules
 */
function normaliseRules(rules) {
  /** @type {Map<string, RateLimitRule>} */
  const exact = new Map();
  /** @type {Array<{ prefix: string, rule: RateLimitRule, key: string }>} */
  const prefixes = [];
  for (const [key, rule] of Object.entries(rules ?? {})) {
    if (!rule || typeof rule !== "object") continue;
    if (typeof rule.windowMs !== "number" || rule.windowMs <= 0) {
      throw new TypeError(
        `RateLimiter: rule '${key}' has invalid windowMs (${rule.windowMs})`,
      );
    }
    if (typeof rule.max !== "number" || rule.max <= 0) {
      throw new TypeError(
        `RateLimiter: rule '${key}' has invalid max (${rule.max})`,
      );
    }
    if (key.endsWith(".*")) {
      prefixes.push({ prefix: key.slice(0, -1), rule, key });
    } else {
      exact.set(key, rule);
    }
  }
  return { exact, prefixes };
}
