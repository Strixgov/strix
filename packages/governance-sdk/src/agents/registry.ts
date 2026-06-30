/**
 * Agent Key Registry — AA-1 PR 1C.1
 *
 * Implements the locked surface from
 * `docs/architecture/actor-attestation-v1.md` contractVersion 1.0.0 §C
 * and the implementation spec at
 * `docs/gates/ACTOR-ATTESTATION-V1-AGENT-PROMPT.md` Part IV §C.
 *
 * Held-PR status: this module is part of the AA-1 dormant track. Per §J
 * of `docs/gates/GATE-REPORT-ACTOR-ATTESTATION-V1.md`, no signer (PR 1C.2)
 * or verifier (PR 1C.3) wires up against this registry until strix-platform
 * #892 Resolution A is operationally closed — running 1C.x under
 * multi-issuer ambiguity defeats verifier rules 2 + 3 (signature validity
 * + revocation), which assume one trust root.
 *
 * SDK-side, pure data lookup. Chain verification (OB-1 — root-signed
 * operational-key attestation) happens at the loader boundary on the
 * strix-platform side, where `solo-builder-core/src/operational-key-attestation.ts`
 * is reachable. This module NEVER calls into pinned roots itself — that
 * would be a layering violation and would require duplicating the
 * SCJ v1 + Ed25519 verify path that already lives in solo-builder-core.
 *
 * What this PR (1C.1) lands:
 *   - `RegisteredAgentKey` and `AgentKeyRegistry` interfaces (locked from
 *     §C of the prompt — reordering fields is a breaking-contract change).
 *   - `parseAgentKid` strict format check.
 *   - `InMemoryAgentKeyRegistry` reference impl + invariants enforced at
 *     `add()` (kid format, agentId/kid agreement, kid uniqueness).
 *
 * What lands later (1C.1b / 1C.2 / 1C.3 — held on #892):
 *   - strix-platform loader that verifies each entry's
 *     `OperationalKeyAttestation` against a pinned root before `add()`.
 *   - `/.well-known/strix-jwks.json` agent-namespace extension
 *     (flag-gated on `STRIX_ACTOR_ATTESTATION_V1`).
 *   - Signer + verifier consumers of this registry.
 */

/**
 * Public-key shape served in JWKS for agent kids. RFC 7517 OKP-flavored;
 * Ed25519 only.
 *
 * We do not type this as `JsonWebKey` from `lib.dom`/`@types/node` — the
 * governance-sdk's tsconfig `lib` is ES2022 and the field set we actually
 * use is narrow. Aligns byte-for-byte with `solo-builder-core/src/operational-key-attestation.ts:Ed25519Jwk`.
 */
export interface AgentPublicKeyJwk {
  kty: "OKP";
  crv: "Ed25519";
  /** base64url-encoded 32-byte public key */
  x: string;
  /** Mirrors the registry entry's `kid`. Required when this JWK is served
   *  via `/.well-known/strix-jwks.json`. */
  kid?: string;
  /** RFC 7517 advisory fields; never used for trust decisions. */
  use?: "sig";
  alg?: "EdDSA";
  key_ops?: ReadonlyArray<"verify">;
}

/**
 * A single registered agent signing key entry. Field order matches §C
 * of the agent prompt; reordering invalidates the SDK's public contract.
 *
 * `rootAttestationKid` records the pinned root that attested this key
 * via `OperationalKeyAttestation` (OB-1). The chain itself is verified at
 * registry-load time on the platform side — by the time an entry reaches
 * this module, the chain has already been validated. Storing the root
 * kid makes the trust relationship inspectable from a `resolveByKid`
 * result without re-running cryptography.
 */
export interface RegisteredAgentKey {
  agentId: string;
  kid: string;
  publicKeyJwk: AgentPublicKeyJwk;
  /** Strict RFC 3339 timestamp; the loader is responsible for validation. */
  registeredAt: string;
  rootAttestationKid: string;
}

/**
 * Read-only lookup surface that signer (1C.2) and verifier (1C.3) call
 * into. Both call sites MUST NOT read keys from request data or env
 * directly — only from this registry. Enforced by lint + audit tests in
 * later PRs.
 */
export interface AgentKeyRegistry {
  /** Returns `null` if the kid is unknown (caller emits CLASS_KEY_UNKNOWN). */
  resolveByKid(kid: string): RegisteredAgentKey | null;
  /** Returns all kids for an agent (rotation: 0..n). Empty array if unknown. */
  resolveByAgentId(agentId: string): RegisteredAgentKey[];
}

/**
 * Agent kid format. The spec at architecture doc §"Decision 3" reserves
 * `agent-<agentId>-<YYYY-MM>` and pins it as load-bearing.
 *
 * Constraints:
 *   - `<agentId>` matches the `AgentDefinition.agentId` value, which by
 *     convention is kebab-case starting with a letter
 *     (`agents/runtime.ts:AgentRegistry`).
 *   - `<YYYY>` is the registration year; `<MM>` is two-digit zero-padded
 *     month (1–12).
 *
 * Year/month range checks are intentionally lenient — calendar validation
 * is the loader's job, not the parser's. The parser is a structural gate
 * only.
 */
const AGENT_KID_PATTERN = /^agent-([a-z][a-z0-9-]*)-(\d{4})-(\d{2})$/;

export interface ParsedAgentKid {
  agentId: string;
  year: number;
  month: number;
}

export function parseAgentKid(kid: string): ParsedAgentKid | null {
  const match = AGENT_KID_PATTERN.exec(kid);
  if (!match) return null;
  const [, agentId, yyyy, mm] = match;
  const month = Number.parseInt(mm, 10);
  if (month < 1 || month > 12) return null;
  return {
    agentId,
    year: Number.parseInt(yyyy, 10),
    month,
  };
}

// ─── Errors (stable codes — surfaced by the loader in PR 1C.1b) ─────────────

export class AgentKidFormatError extends Error {
  readonly code = "AGENT_KID_FORMAT" as const;
  readonly kid: string;
  constructor(kid: string) {
    super(
      `Invalid agent kid "${kid}". Expected format: agent-<agentId>-<YYYY-MM> ` +
        `(kebab-case agentId, four-digit year, two-digit month).`,
    );
    this.kid = kid;
    this.name = "AgentKidFormatError";
  }
}

export class AgentIdMismatchError extends Error {
  readonly code = "AGENT_ID_MISMATCH" as const;
  constructor(
    readonly kidAgentId: string,
    readonly entryAgentId: string,
    readonly kid: string,
  ) {
    super(
      `agentId mismatch on registry entry: kid "${kid}" parses as agentId ` +
        `"${kidAgentId}" but entry declares "${entryAgentId}".`,
    );
    this.name = "AgentIdMismatchError";
  }
}

export class AgentKidCollisionError extends Error {
  readonly code = "AGENT_KID_COLLISION" as const;
  constructor(readonly kid: string) {
    super(
      `kid collision: "${kid}" is already registered with a different ` +
        `public key. Rotate to a new kid before re-registering.`,
    );
    this.name = "AgentKidCollisionError";
  }
}

// ─── In-memory reference implementation ──────────────────────────────────────

/**
 * In-memory registry. Suitable as a fixture for tests and as the storage
 * primitive that the platform-side loader (PR 1C.1b) hydrates from
 * env-config or DB. The loader is the only thing that should perform OB-1
 * chain verification before calling `add()` — this class trusts its inputs
 * for trust-root chaining and only enforces structural invariants.
 *
 * Structural invariants enforced at `add()`:
 *   1. Kid matches the locked format (`AgentKidFormatError`).
 *   2. Kid's encoded agentId matches the entry's `agentId` (T6 lite —
 *      prevents accidentally registering content-001's key under
 *      ops-002's namespace).
 *   3. Kid is unique within the registry. Idempotent re-add with the
 *      same `publicKeyJwk.x` is allowed (re-running a loader on the same
 *      config is not an error); divergent `x` for the same kid throws
 *      `AgentKidCollisionError`.
 *
 * Out of scope here (the loader handles all of these):
 *   - Verifying `registeredAt` is strict RFC 3339.
 *   - Verifying the entry's `rootAttestationKid` points to a real pinned
 *     root.
 *   - Verifying the `OperationalKeyAttestation` chain (OB-1).
 *   - Revocation list checks (OB-3).
 */
export class InMemoryAgentKeyRegistry implements AgentKeyRegistry {
  private readonly byKid = new Map<string, RegisteredAgentKey>();
  private readonly byAgentId = new Map<string, RegisteredAgentKey[]>();

  /**
   * Register an entry. See class-level docstring for invariants. Throws
   * on any structural violation; never returns a partial state.
   */
  add(entry: RegisteredAgentKey): void {
    const parsed = parseAgentKid(entry.kid);
    if (parsed === null) throw new AgentKidFormatError(entry.kid);
    if (parsed.agentId !== entry.agentId) {
      throw new AgentIdMismatchError(parsed.agentId, entry.agentId, entry.kid);
    }

    const existing = this.byKid.get(entry.kid);
    if (existing !== undefined) {
      // Idempotent: same public key body → no-op. Different body → throw.
      if (existing.publicKeyJwk.x !== entry.publicKeyJwk.x) {
        throw new AgentKidCollisionError(entry.kid);
      }
      return;
    }

    this.byKid.set(entry.kid, entry);
    const list = this.byAgentId.get(entry.agentId) ?? [];
    list.push(entry);
    this.byAgentId.set(entry.agentId, list);
  }

  resolveByKid(kid: string): RegisteredAgentKey | null {
    return this.byKid.get(kid) ?? null;
  }

  resolveByAgentId(agentId: string): RegisteredAgentKey[] {
    const list = this.byAgentId.get(agentId);
    return list === undefined ? [] : [...list];
  }

  /** Total kids registered across all agents. Used by health probes / tests. */
  get size(): number {
    return this.byKid.size;
  }
}

/**
 * The empty registry. Used as the safe default when the AA-1 feature flag
 * is off — `resolveByKid` always returns `null`, so the verifier short-
 * circuits to `CLASS_KEY_UNKNOWN` for every kid (and the SDK never claims
 * `actorClassVerified: true` against an empty trust set).
 */
export const EMPTY_AGENT_KEY_REGISTRY: AgentKeyRegistry = Object.freeze({
  resolveByKid: () => null,
  resolveByAgentId: () => [],
});
