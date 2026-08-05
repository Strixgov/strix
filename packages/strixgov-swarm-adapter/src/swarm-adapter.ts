/**
 * Strix Swarm Adapter v0.1 — the framework-neutral bridge.
 *
 *   Real agent framework (Claude Agent SDK / CrewAI / LangGraph / OpenAI Swarm)
 *        ↓   your agents decide WHAT to delegate / WHICH tool to call
 *   SwarmAdapter            ← this file: turns those decisions into…
 *        ↓
 *   signed delegation edge  (delegator signs with its OWN key — ST-10)
 *        ↓
 *   Strix governed execution route
 *        ↓
 *   tool / side effect      (only if governance passed)
 *        ↓
 *   proof graph + independent verifier
 *
 * The adapter owns the *governance bridge* — keypairs, signing, routing, proof. It
 * does NOT decide anything; the binding (your framework) calls `delegate(...)` when
 * one agent hands work to another and `act(...)` when an agent calls a tool. Swap
 * the scripted decisions in the tests/examples for your framework's agents and the
 * run is a real, governed, independently-verifiable swarm.
 *
 * v0.1 scope: a single delegating "root" agent fanning out to workers (depth-1).
 * Multi-hop re-delegation (a worker delegating onward) is a tracked follow-on.
 */

import { generateKeyPairSync, createHash, type KeyObject } from 'node:crypto';
import { signSwarmDelegation, type RiskLevel, type SwarmAuthority } from '@strixgov/sdk/swarm';
import type { SwarmTransport, ActResult } from './transport.js';

export interface OpenRunSpec {
  /** The depth-1 authorized agent — the one that delegates to workers (the planner). */
  rootAgentId: string;
  /** An EXECUTED decision that anchors the run (SW-1). */
  rootDecisionId: string;
  rootApprovalId?: string;
  rootActorId?: string;
  /** Maximal capabilities any agent in the run may exercise. */
  capabilityCeiling: string[];
  scopeCeiling?: Record<string, unknown>;
  riskCeiling?: RiskLevel;
  /** Total governed actions allowed across the run (SW-5). null = unbounded. */
  budgetCeiling?: number | null;
  maxDepth?: number;
  maxFanout?: number;
  ttlMs?: number;
  swarmRunId?: string;
  /** Hashed → the taskHash that binds every edge + action in this run (ST-2). */
  taskDescriptor?: string;
}

export interface DelegateSpec {
  /** Delegator. In v0.1 (depth-1) this must be the run's rootAgentId. */
  from: string;
  /** Delegatee (the worker). */
  to: string;
  /** A subset of the parent's capabilities (attenuation, SW-2). */
  capabilities: string[];
  scope?: Record<string, unknown>;
  riskCeiling?: RiskLevel;
  /** Action budget for this worker (≤ parent budget, SW-5). */
  budget: number;
  delegationId?: string;
  nonce?: string;
}

export interface ActSpec {
  /** The worker performing the action. */
  agent: string;
  /** The capability/tool it calls. */
  capability: string;
  input: unknown;
  riskLevel?: RiskLevel;
  evidenceId?: string;
  swarmActionId?: string;
  /**
   * Idempotency key (R-4). Reuse the SAME key across retries of one logical action
   * and Strix replays the prior governed result instead of re-executing. Fixes both
   * the swarmActionId and evidenceId deterministically; overridden by explicit
   * swarmActionId/evidenceId if those are also set.
   */
  idempotencyKey?: string;
}

interface RunState {
  swarmRunId: string;
  rootAgentId: string;
  maxDepth: number;
  openedAt: string;
  expiresAt: string;
  taskHash: string;
  ceiling: SwarmAuthority;
}

function publicJwk(k: KeyObject): { kty: 'OKP'; crv: 'Ed25519'; x: string } {
  const j = k.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
  return { kty: 'OKP', crv: 'Ed25519', x: j.x };
}

export class SwarmAdapter {
  private keys = new Map<string, { privateKey: KeyObject; publicKey: KeyObject; kid: string }>();
  private registered = new Set<string>();
  private edges = new Map<string, { delegationId: string; scope: Record<string, unknown> }>(); // by delegatee
  private run?: RunState;
  private seq = 0;

  constructor(
    private opts: { transport: SwarmTransport; tenantId: string; environment: string; now?: () => Date },
  ) {}

  /** Get (lazily creating) an agent's ephemeral keypair. Private keys stay in-process. */
  private keyFor(agentId: string) {
    let k = this.keys.get(agentId);
    if (!k) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      k = { privateKey, publicKey, kid: `swarm:${agentId}` };
      this.keys.set(agentId, k);
    }
    return k;
  }

  /** Inject a known keypair (e.g. an AA-1-attested agent identity) instead of an ephemeral one. */
  setAgentKey(agentId: string, privateKey: KeyObject, publicKey: KeyObject, kid?: string) {
    this.keys.set(agentId, { privateKey, publicKey, kid: kid ?? `swarm:${agentId}` });
  }

  private async ensureRegistered(agentId: string) {
    if (this.registered.has(agentId)) return;
    const k = this.keyFor(agentId);
    const r = await this.opts.transport.registerAgent(this.requireRun().swarmRunId, {
      agentId, kid: k.kid, publicKeyJwk: publicJwk(k.publicKey),
    });
    if (!r.ok) throw new Error(`registerAgent(${agentId}) failed: ${r.error}`);
    this.registered.add(agentId);
  }

  private requireRun(): RunState {
    if (!this.run) throw new Error('openRun() must be called before delegate()/act()');
    return this.run;
  }

  async openRun(spec: OpenRunSpec): Promise<string> {
    const now = this.opts.now?.() ?? new Date();
    const swarmRunId = spec.swarmRunId ?? `swarm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const openedAt = new Date(now.getTime() - 60_000).toISOString();
    const expiresAt = new Date(now.getTime() + (spec.ttlMs ?? 6 * 3600_000)).toISOString();
    const taskHash = 'sha256:' + createHash('sha256').update(spec.taskDescriptor ?? swarmRunId).digest('hex');
    const scopeCeiling = spec.scopeCeiling ?? {};
    const riskCeiling = spec.riskCeiling ?? 'medium';
    const budgetCeiling = spec.budgetCeiling ?? null;
    const maxDepth = spec.maxDepth ?? 3;

    const res = await this.opts.transport.openRun({
      swarmRunId,
      rootDecisionId: spec.rootDecisionId,
      rootApprovalId: spec.rootApprovalId ?? `appr_${swarmRunId}`,
      rootActorId: spec.rootActorId ?? 'human-operator',
      capabilityCeiling: spec.capabilityCeiling,
      riskCeiling,
      scopeCeiling,
      budgetCeiling,
      maxDepth,
      maxFanout: spec.maxFanout ?? 8,
      openedAt,
      expiresAt,
    });
    if (!res.ok) throw new Error(`openRun failed: ${res.error}`);

    this.run = {
      swarmRunId, rootAgentId: spec.rootAgentId, maxDepth, openedAt, expiresAt, taskHash,
      ceiling: {
        capabilities: spec.capabilityCeiling, riskCeiling, scope: scopeCeiling,
        notBefore: openedAt, notAfter: expiresAt, budget: budgetCeiling ?? undefined,
      },
    };
    await this.ensureRegistered(spec.rootAgentId);
    return swarmRunId;
  }

  /** Sign + persist a delegation edge (the delegator's decision to hand work to a worker). */
  async delegate(spec: DelegateSpec): Promise<string> {
    const run = this.requireRun();
    if (spec.from !== run.rootAgentId) {
      throw new Error(`v0.1 supports depth-1 only: delegator must be the run root agent (${run.rootAgentId}), got ${spec.from}`);
    }
    await this.ensureRegistered(spec.from);
    const k = this.keyFor(spec.from);
    const delegationId = spec.delegationId ?? `edge-${spec.to}`;
    const scope = spec.scope ?? run.ceiling.scope;

    const signed = signSwarmDelegation(
      {
        payload: {
          schemaVersion: 1, delegationId, swarmRunId: run.swarmRunId, parentDelegationId: null, depth: 1,
          delegatorAgentId: spec.from, delegateeAgentId: spec.to, capabilitySubset: spec.capabilities,
          riskCeiling: spec.riskCeiling ?? run.ceiling.riskCeiling, scopeSubset: scope, budget: spec.budget,
          taskHash: run.taskHash, nonce: spec.nonce ?? `n-${spec.to}`,
          notBefore: run.openedAt, notAfter: run.expiresAt, issuedAt: run.openedAt,
        },
        environment: this.opts.environment, tenantId: this.opts.tenantId, parentAuthority: run.ceiling,
        parentDepth: 0, maxDepth: run.maxDepth, parentDelegateeAgentId: run.rootAgentId,
      },
      k.privateKey,
    );

    const r = await this.opts.transport.persistDelegation(run.swarmRunId, { envelope: signed.envelope, signature: signed.signature });
    if (!r.ok) throw new Error(`delegate ${spec.from}→${spec.to} rejected: ${r.error}`);
    this.edges.set(spec.to, { delegationId, scope });
    return delegationId;
  }

  /** Route a worker's tool call through the governed boundary. Returns EXECUTED or BLOCKED. */
  async act(spec: ActSpec): Promise<ActResult> {
    const run = this.requireRun();
    const edge = this.edges.get(spec.agent);
    if (!edge) throw new Error(`agent ${spec.agent} has no delegation in this run — delegate() to it first`);
    const n = ++this.seq;
    // Idempotency key (R-4): a stable key makes a retry replay rather than re-run.
    const key = spec.idempotencyKey;
    return this.opts.transport.execute({
      swarmRunId: run.swarmRunId,
      executingDelegationId: edge.delegationId,
      capabilityId: spec.capability,
      actionType: spec.capability,
      riskLevel: spec.riskLevel ?? 'low',
      scope: edge.scope,
      taskHash: run.taskHash,
      evidenceId: spec.evidenceId ?? (key ? `evi-${run.swarmRunId}-${key}` : `evi-${run.swarmRunId}-${n}`),
      swarmActionId: spec.swarmActionId ?? (key ? `act-${run.swarmRunId}-${key}` : `act-${run.swarmRunId}-${n}`),
      proposerAgentId: spec.agent,
      executingAgentId: spec.agent,
      input: spec.input,
    });
  }

  get runId(): string | undefined {
    return this.run?.swarmRunId;
  }

  async proof() {
    const run = this.requireRun();
    return this.opts.transport.getProof?.(run.swarmRunId);
  }
}
