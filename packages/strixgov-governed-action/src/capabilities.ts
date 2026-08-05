/**
 * Capability resolution — the PROOF-1 boundary of this package.
 *
 * A governed action is only worth anything if the capability id it declares is
 * REAL. Operating Doctrine v1 §3 makes "consequential" mechanical, not
 * editorial: an action qualifies only if it is registered at a risk tier that
 * requires an execution token (HIGH/CRITICAL) or sits on an irreversible
 * boundary. "Carries some capabilityId" is explicitly NOT a qualifying
 * condition — every governed capability at every tier carries one.
 *
 * So this module refuses to invent ids. It resolves against the already-shipped
 * classifications in @strixgov/capabilities-mcp-common and reports, honestly,
 * whether the resolved capability can back a first proof.
 *
 * The honest state of the three connectors named in the onboarding target:
 *
 *   GitHub — 6 of 33 classified capabilities are HIGH/CRITICAL, including
 *     mcp.github.merge_pull_request (CRITICAL; a merge cannot be un-merged
 *     atomically — revert is a NEW commit). Qualifies.
 *
 *   Slack — 0 of 13 classified capabilities are HIGH or CRITICAL. The pack's
 *     own header states there is no CRITICAL Slack capability today. A Slack
 *     action can therefore be governed and recorded, but it CANNOT back a
 *     PROOF-1-qualifying first proof, and this module says so rather than
 *     silently promoting it. Reclassifying a Slack send as HIGH is a policy
 *     decision for the capability registry's owner — not something a client
 *     library may assume.
 *
 *   REST — caller-declared. We cannot classify an arbitrary endpoint, so the
 *     caller must pass a capability id that their own registry recognises, and
 *     we mark the qualification as UNKNOWN rather than guessing.
 */

/** Risk tiers as classified by the capability packs. */
export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Whether a resolved capability can back a proof that counts toward TTFP/PRR.
 *
 * Deliberately three-state. A library that collapsed UNKNOWN into either
 * QUALIFIES or NOT_CONSEQUENTIAL would be asserting something it cannot know
 * about a caller's private registry.
 */
export type ProofQualification =
  | { status: 'QUALIFIES'; tier: 'HIGH' | 'CRITICAL'; reason: string }
  | { status: 'NOT_CONSEQUENTIAL'; tier: RiskTier; reason: string }
  | { status: 'UNKNOWN'; reason: string };

export interface ResolvedCapability {
  capabilityId: string;
  /** Present only when this package could classify it from a shipped pack. */
  tier?: RiskTier;
  qualification: ProofQualification;
}

/** A classification entry, structurally matching the mcp-common pack shape. */
export interface CapabilityClassification {
  id: string;
  name?: string;
  risk: string;
  mode?: string;
  description?: string;
}

const CONSEQUENTIAL_TIERS = new Set(['HIGH', 'CRITICAL']);

function normalizeTier(risk: string): RiskTier | undefined {
  const t = String(risk ?? '').toUpperCase();
  return t === 'LOW' || t === 'MEDIUM' || t === 'HIGH' || t === 'CRITICAL' ? t : undefined;
}

/**
 * Resolve a capability id against a set of classifications.
 *
 * Pass the pack you actually installed, e.g.
 *
 *   import { githubCapabilities } from '@strixgov/capabilities-mcp-common/github';
 *   resolveCapability('mcp.github.merge_pull_request', githubCapabilities);
 *
 * The classifications argument is injected rather than imported here on
 * purpose: this package must not force a dependency on any particular pack, and
 * a caller with their own registry should be able to use their own.
 */
export function resolveCapability(
  capabilityId: string,
  classifications: readonly CapabilityClassification[] = [],
): ResolvedCapability {
  if (typeof capabilityId !== 'string' || capabilityId.trim() === '') {
    throw new TypeError('capabilityId must be a non-empty string');
  }
  const id = capabilityId.trim();

  // Reject the placeholder shapes the /strix-wire contract test also refuses,
  // so a demo id can never be mistaken for a governed action.
  if (/^(test|dummy|unknown|null|none|todo|placeholder|example|sample)$/i.test(id)) {
    throw new Error(
      `capabilityId "${id}" looks like a placeholder. A governed action must ` +
        'name a real registered capability — a proof bound to a placeholder ' +
        'proves nothing (Operating Doctrine v1, PROOF-1).',
    );
  }

  const hit = classifications.find((c) => c.id === id);
  if (!hit) {
    return {
      capabilityId: id,
      qualification: {
        status: 'UNKNOWN',
        reason:
          `"${id}" is not present in the ${classifications.length} classification(s) ` +
          'supplied, so this package cannot determine its risk tier. It may still ' +
          'be a real capability in your own registry — pass that registry to ' +
          'classify it, or treat the qualification as unproven.',
      },
    };
  }

  const tier = normalizeTier(hit.risk);
  if (!tier) {
    return {
      capabilityId: id,
      qualification: {
        status: 'UNKNOWN',
        reason: `"${id}" carries an unrecognized risk value ${JSON.stringify(hit.risk)}; refusing to infer a tier.`,
      },
    };
  }

  if (CONSEQUENTIAL_TIERS.has(tier)) {
    return {
      capabilityId: id,
      tier,
      qualification: {
        status: 'QUALIFIES',
        tier: tier as 'HIGH' | 'CRITICAL',
        reason: `"${id}" is classified ${tier}, a tier that requires an execution token.`,
      },
    };
  }

  return {
    capabilityId: id,
    tier,
    qualification: {
      status: 'NOT_CONSEQUENTIAL',
      tier,
      reason:
        `"${id}" is classified ${tier}. It can be governed and recorded, but per ` +
        'Operating Doctrine v1 §3 only HIGH/CRITICAL (or an irreversible ' +
        'boundary) counts toward Time-to-First-Proof. Do not present a receipt ' +
        'for this action as a qualifying first proof.',
    },
  };
}

/** True only for a capability this package could prove is consequential. */
export function qualifiesAsFirstProof(resolved: ResolvedCapability): boolean {
  return resolved.qualification.status === 'QUALIFIES';
}
