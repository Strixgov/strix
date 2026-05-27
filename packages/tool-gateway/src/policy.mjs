/**
 * Policy engine.
 *
 * Three-state output: ALLOW, DENY, APPROVAL_REQUIRED. Anything that
 * doesn't match a rule falls to `default`; an absent default is treated
 * as DENY (fail-closed). A malformed ruleset (unknown decision string,
 * non-string capability id) also fails closed.
 *
 * Lookup order:
 *   1. Exact rule for capabilityId
 *   2. Glob prefix rules (e.g. "filesystem.*"), longest prefix wins
 *   3. riskOverride matching the capability's risk level
 *   4. ruleset.default
 *   5. DENY
 *
 * Versioning: every PolicyEngine exposes a content-addressable version
 * string (`sha256:...`) derived deterministically from the ruleset.
 * The gateway binds that string into every receipt's canonical
 * payload, so an auditor can answer "which policy was in force when
 * this receipt was issued?" without trusting any out-of-band record.
 */

import crypto from "node:crypto";
import { canonicalJSON } from "./canonical.mjs";

const VALID_DECISIONS = Object.freeze(["ALLOW", "DENY", "APPROVAL_REQUIRED"]);
const VALID_RISKS = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

function isDecision(d) {
  return typeof d === "string" && VALID_DECISIONS.includes(d);
}

function isRisk(r) {
  return typeof r === "string" && VALID_RISKS.includes(r);
}

/**
 * @param {unknown} ruleset
 * @returns {import("./types.d.ts").PolicyRuleset}
 */
export function validateRuleset(ruleset) {
  if (!ruleset || typeof ruleset !== "object") {
    throw new Error("validateRuleset: ruleset must be an object");
  }
  const rules = ruleset.rules ?? {};
  if (typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error("validateRuleset: rules must be an object map");
  }
  for (const [key, value] of Object.entries(rules)) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(`validateRuleset: invalid rule key '${key}'`);
    }
    if (!isDecision(value)) {
      throw new Error(
        `validateRuleset: rule '${key}' has invalid decision '${value}'`
      );
    }
  }
  if (ruleset.default !== undefined && !isDecision(ruleset.default)) {
    throw new Error(
      `validateRuleset: invalid default decision '${ruleset.default}'`
    );
  }
  if (ruleset.riskOverrides) {
    for (const [risk, dec] of Object.entries(ruleset.riskOverrides)) {
      if (!isRisk(risk)) {
        throw new Error(`validateRuleset: invalid risk level '${risk}'`);
      }
      if (!isDecision(dec)) {
        throw new Error(
          `validateRuleset: invalid risk override decision '${dec}'`
        );
      }
    }
  }
  return ruleset;
}

/**
 * Compute the content-addressable version hash of a policy ruleset.
 * Returns a string of the form `sha256:<hex>`. Two semantically-equal
 * rulesets — same rules, same defaults, same risk overrides — produce
 * the same hash regardless of key insertion order. A new rule, a
 * decision change, or even a flipped riskOverride rotates the hash.
 *
 * The shape we hash is intentionally narrow: just the three fields
 * that affect evaluation. Rulesets that carry editorial metadata
 * (description, owner, etc) hash to the same version as long as the
 * decision surface is identical.
 *
 * @param {import("./types.d.ts").PolicyRuleset} ruleset
 * @returns {string}
 */
export function computePolicyVersion(ruleset) {
  validateRuleset(ruleset);
  const normalized = {
    rules: ruleset.rules ?? {},
    riskOverrides: ruleset.riskOverrides ?? {},
    default: ruleset.default ?? null,
  };
  const bytes = canonicalJSON(normalized);
  const hex = crypto.createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hex}`;
}

export class PolicyEngine {
  /**
   * @param {import("./types.d.ts").PolicyRuleset} ruleset
   * @param {Record<string, import("./types.d.ts").ToolCapability>} capabilities
   */
  constructor(ruleset, capabilities = {}) {
    this.ruleset = validateRuleset(ruleset);
    this.capabilities = capabilities;
    this.version = computePolicyVersion(this.ruleset);
  }

  setRuleset(ruleset) {
    this.ruleset = validateRuleset(ruleset);
    this.version = computePolicyVersion(this.ruleset);
  }

  registerCapability(cap) {
    if (!cap || typeof cap.id !== "string") {
      throw new Error("registerCapability: capability.id is required");
    }
    if (!isRisk(cap.risk)) {
      throw new Error(
        `registerCapability: capability ${cap.id} has invalid risk '${cap.risk}'`
      );
    }
    if (!["READ", "WRITE", "EXECUTE"].includes(cap.mode)) {
      throw new Error(
        `registerCapability: capability ${cap.id} has invalid mode '${cap.mode}'`
      );
    }
    this.capabilities[cap.id] = cap;
  }

  /**
   * @param {import("./types.d.ts").ToolInvocation} invocation
   * @returns {import("./types.d.ts").PolicyEvaluation}
   */
  evaluate(invocation) {
    if (!invocation || typeof invocation.capabilityId !== "string") {
      // Fail-closed: malformed invocation gets DENY with a stable reason.
      return {
        decision: "DENY",
        capabilityId: invocation?.capabilityId ?? "<missing>",
        matchedRule: "<malformed-invocation>",
        risk: "CRITICAL",
        reason: "MALFORMED_INVOCATION",
      };
    }
    const cap = this.capabilities[invocation.capabilityId];
    if (!cap) {
      return {
        decision: "DENY",
        capabilityId: invocation.capabilityId,
        matchedRule: "<unknown-capability>",
        risk: "CRITICAL",
        reason: "UNKNOWN_CAPABILITY",
      };
    }

    const rules = this.ruleset.rules ?? {};

    if (Object.prototype.hasOwnProperty.call(rules, cap.id)) {
      return {
        decision: rules[cap.id],
        capabilityId: cap.id,
        matchedRule: cap.id,
        risk: cap.risk,
        reason: "EXACT_RULE",
      };
    }

    let bestPrefix = "";
    for (const key of Object.keys(rules)) {
      if (!key.endsWith(".*")) continue;
      const prefix = key.slice(0, -2);
      // `prefix.*` matches `prefix.<something>` only — NOT `prefix`
      // itself. Standard glob semantics. An exact-match rule already
      // took priority above.
      if (cap.id.startsWith(prefix + ".")) {
        if (prefix.length > bestPrefix.length) bestPrefix = prefix;
      }
    }
    if (bestPrefix) {
      const ruleKey = bestPrefix + ".*";
      return {
        decision: rules[ruleKey],
        capabilityId: cap.id,
        matchedRule: ruleKey,
        risk: cap.risk,
        reason: "PREFIX_RULE",
      };
    }

    const riskOverride = this.ruleset.riskOverrides?.[cap.risk];
    if (riskOverride) {
      return {
        decision: riskOverride,
        capabilityId: cap.id,
        matchedRule: `<risk:${cap.risk}>`,
        risk: cap.risk,
        reason: "RISK_OVERRIDE",
      };
    }

    if (this.ruleset.default) {
      return {
        decision: this.ruleset.default,
        capabilityId: cap.id,
        matchedRule: "<default>",
        risk: cap.risk,
        reason: "DEFAULT",
      };
    }

    // No rule, no default → fail closed.
    return {
      decision: "DENY",
      capabilityId: cap.id,
      matchedRule: "<fail-closed>",
      risk: cap.risk,
      reason: "NO_MATCH_FAIL_CLOSED",
    };
  }
}
