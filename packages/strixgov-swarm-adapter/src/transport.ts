/**
 * Strix Swarm Adapter v0.1 — transport layer.
 *
 * The adapter is framework-neutral: it turns "agent A delegates to agent B" and
 * "agent B calls a tool" into Strix governed calls. The *transport* is how those
 * calls reach Strix:
 *
 *   - HttpTransport       → a remote deployment (the "bring your swarm" path; the
 *                           customer runs the adapter in their agent process).
 *   - InProcessTransport  → the console's own producer + boundary (embedding/tests;
 *                           see ./in-process-transport.ts, server-only).
 *
 * This file is PORTABLE: it imports only `@strixgov/sdk/swarm` types + fetch, so it
 * can be lifted into a standalone `@strixgov/swarm-adapter` package unchanged.
 */

export interface OpenRunBody {
  swarmRunId: string;
  rootDecisionId: string;
  rootApprovalId: string;
  rootActorId: string;
  capabilityCeiling: string[];
  riskCeiling: string;
  scopeCeiling: Record<string, unknown>;
  budgetCeiling: number | null;
  maxDepth: number;
  maxFanout: number;
  openedAt: string;
  expiresAt: string;
}

export interface RegisterAgentBody {
  agentId: string;
  kid: string;
  /** Who vouches for this key (Gate-J identity = (issuer, kid)). Optional; server defaults to 'swarm-run'. */
  issuer?: string;
  publicKeyJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string };
}

export interface PersistDelegationBody {
  envelope: unknown; // SwarmDelegationEnvelope (signed bytes)
  signature: string;
}

export interface ExecuteBody {
  swarmRunId: string;
  executingDelegationId: string;
  capabilityId: string;
  actionType: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  scope: Record<string, unknown>;
  taskHash: string;
  evidenceId: string;
  swarmActionId: string;
  proposerAgentId: string;
  executingAgentId: string;
  input: unknown;
  decisionToken?: string;
  decisionId?: string;
  actorUserId?: string;
}

export interface ActResult {
  status: 'EXECUTED' | 'BLOCKED';
  blockCode?: string;
  blockReason?: string;
  evidenceId?: string;
  swarmActionId?: string;
  /** True when EXECUTED was an idempotent replay of a prior attempt (the side effect did not re-run). */
  idempotentReplay?: boolean;
}

export interface SwarmTransport {
  openRun(body: OpenRunBody): Promise<{ ok: boolean; error?: string; swarmRunId?: string }>;
  registerAgent(swarmRunId: string, body: RegisterAgentBody): Promise<{ ok: boolean; error?: string }>;
  persistDelegation(swarmRunId: string, body: PersistDelegationBody): Promise<{ ok: boolean; error?: string; delegationId?: string }>;
  execute(body: ExecuteBody): Promise<ActResult>;
  getProof?(swarmRunId: string): Promise<{ status: number; json: unknown }>;
}

// ─── HTTP transport (the "bring your swarm" path) ────────────────────────────────

type FetchLike = typeof fetch;

export class HttpTransport implements SwarmTransport {
  private base: string;
  constructor(
    private opts: { base: string; tenantId: string; token: string; fetchImpl?: FetchLike; timeoutMs?: number },
  ) {
    this.base = opts.base.replace(/\/$/, '');
  }

  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.token}`, 'x-tenant-id': this.opts.tenantId },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20000),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* */ }
    return { status: res.status, json };
  }

  async openRun(body: OpenRunBody) {
    const r = await this.req('POST', '/api/v1/swarm/runs', body);
    return r.status === 201 ? { ok: true, swarmRunId: r.json?.swarmRunId } : { ok: false, error: r.json?.error ?? `HTTP ${r.status}` };
  }
  async registerAgent(swarmRunId: string, body: RegisterAgentBody) {
    const r = await this.req('POST', `/api/v1/swarm/runs/${encodeURIComponent(swarmRunId)}/agents`, body);
    return r.status === 201 ? { ok: true } : { ok: false, error: r.json?.error ?? `HTTP ${r.status}` };
  }
  async persistDelegation(swarmRunId: string, body: PersistDelegationBody) {
    const r = await this.req('POST', `/api/v1/swarm/runs/${encodeURIComponent(swarmRunId)}/delegations`, body);
    return r.status === 201 ? { ok: true, delegationId: r.json?.delegationId } : { ok: false, error: r.json?.error ?? `HTTP ${r.status}` };
  }
  async execute(body: ExecuteBody): Promise<ActResult> {
    const r = await this.req('POST', '/api/v1/swarm/actions/execute', body);
    if (r.status === 200 && r.json?.verification_status === 'EXECUTED') {
      return { status: 'EXECUTED', evidenceId: r.json.evidenceId, swarmActionId: r.json.swarmActionId, idempotentReplay: r.json.idempotentReplay === true };
    }
    return { status: 'BLOCKED', blockCode: r.json?.blockCode ?? `HTTP ${r.status}`, blockReason: r.json?.blockReason };
  }
  async getProof(swarmRunId: string) {
    return this.req('GET', `/api/public/proof/swarm/${encodeURIComponent(swarmRunId)}`);
  }
}
