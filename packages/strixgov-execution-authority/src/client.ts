/**
 * The HTTP client for the Strix Execution Authority Boundary.
 *
 * Four calls, in the order a consumer makes them:
 *   evaluate(proposal)        -> GRANTED | APPROVAL_REQUIRED | REFUSED
 *   redeem(grant, execution)  -> PERMIT | REFUSE | UNAVAILABLE   (immediately before the handler)
 *   reportOutcome(grantId, …) -> the signed terminal for the decision
 *   getEvidence / verify      -> the public proof, checked with @strixgov/verifier
 *
 * Answers and problems are kept apart everywhere. An HTTP-level failure (a
 * 5xx, a network error, a malformed body, an unreachable key set) is never
 * turned into a refusal or a permit: `redeem` reports UNAVAILABLE and the
 * caller must not execute; `evaluate` and `reportOutcome` throw
 * `StrixUnavailableError`.
 */
import { verify as verifyEvidence } from '@strixgov/verifier';
import { BOUND_FIELDS, CONTRACT, proposalProblem, type CurrentExecution, type ProposedExecution, type SignedGrant } from './contract.js';
import { verifyGrant, type GrantVerification } from './grant.js';
import { trustFromDocuments, type AuthorityTrust } from './trust.js';

export class StrixUnavailableError extends Error {
  readonly status: number | null;
  readonly code: string;
  constructor(code: string, message: string, status: number | null = null) {
    super(`${code}: ${message}`);
    this.name = 'StrixUnavailableError';
    this.code = code;
    this.status = status;
  }
}

export interface ClientOptions {
  /** Origin of the Strix deployment, e.g. https://www.strixgov.com. */
  baseUrl: string;
  /** The v1 service credential (`Authorization: Bearer`). */
  token: string;
  /** The Strix tenant id (the cuid, never a slug) sent as X-Tenant-Id. */
  strixTenantId: string;
  /** The issuer every grant must name. Defaults to the origin of `baseUrl`. */
  issuer?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Upper bound on a grant's window; longer grants are refused. Default 1h. */
  maxLifetimeMs?: number;
}

export type EvaluateResult =
  | { status: 'GRANTED'; grant: SignedGrant; strixDecisionId: string }
  | { status: 'APPROVAL_REQUIRED'; strixDecisionId: string; approvalsRequired: number; approvalsGranted: number }
  | { status: 'REFUSED'; strixDecisionId: string | null; reasonCode: string };

export type RedeemResult =
  | { status: 'PERMIT'; grantId: string; strixDecisionId: string; consumedAt: string }
  | {
      status: 'REFUSE';
      /** Who refused: this SDK's own verification, or Strix centrally. */
      refusedBy: 'local' | 'strix';
      reasonCode: string;
      detail: string;
      mismatchedFields?: string[];
      /** Strix's signed denial record for the refusal, when it recorded one. */
      refusalEvidenceId?: string;
    }
  | { status: 'UNAVAILABLE'; code: string; detail: string; httpStatus: number | null };

export interface OutcomeReport {
  outcome: 'EXECUTED' | 'FAILED' | 'UNKNOWN';
  handlerEntered: boolean;
  observedConsequence?: Record<string, unknown> | null;
  reportedBy: string;
  detail?: string;
}

export type OutcomeResult =
  | { status: 'RECORDED'; strixDecisionId: string; state: string; replay: boolean; signed: boolean; evidenceId: string | null; evidenceHash: string | null; proofPath: string | null }
  | { status: 'REFUSED'; reasonCode: string; detail: string };

/** Refusals this SDK settles without presenting the grant: a forged or untrusted artifact is not shown to Strix. */
const LOCAL_ONLY_REFUSALS = new Set(['AUTHORITY_MALFORMED', 'AUTHORITY_ISSUER_MISMATCH', 'AUTHORITY_KEY_INVALID', 'AUTHORITY_SIGNATURE_INVALID', 'AUTHORITY_LIFETIME_EXCEEDED']);

export class StrixExecutionAuthorityClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly strixTenantId: string;
  private readonly issuer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly maxLifetimeMs: number | undefined;
  private trustCache: { trust: AuthorityTrust; validUntil: number; generation: number } | null = null;

  constructor(opts: ClientOptions) {
    const url = new URL(opts.baseUrl);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('baseUrl must be https (loopback excepted for tests)');
    }
    this.baseUrl = url.origin;
    this.token = opts.token;
    this.strixTenantId = opts.strixTenantId;
    this.issuer = opts.issuer ?? url.origin;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
    this.maxLifetimeMs = opts.maxLifetimeMs;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'X-Tenant-Id': this.strixTenantId, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: auth ? this.authHeaders() : { Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
    } catch (err) {
      throw new StrixUnavailableError('TRANSPORT_ERROR', err instanceof Error ? err.message : String(err));
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      throw new StrixUnavailableError('MALFORMED_RESPONSE', `HTTP ${res.status} without a JSON body`, res.status);
    }
    return { status: res.status, json };
  }

  /**
   * Trust for grant verification: Strix's published authority key set plus its
   * signed, current revocation document. Cached until the revocation
   * document's own validUntil; a generation that regresses is refused.
   */
  async loadTrust(opts: { force?: boolean } = {}): Promise<AuthorityTrust> {
    const now = this.now();
    if (!opts.force && this.trustCache && now.getTime() < this.trustCache.validUntil) return this.trustCache.trust;
    const keys = await this.call('GET', '/.well-known/strix-authority-keys.json', undefined, false);
    if (keys.status !== 200) throw new StrixUnavailableError('KEY_SET_UNAVAILABLE', `HTTP ${keys.status}`, keys.status);
    const rev = await this.call('GET', '/api/public/authority/revocations', undefined, false);
    if (rev.status !== 200) throw new StrixUnavailableError('REVOCATIONS_UNAVAILABLE', `HTTP ${rev.status}`, rev.status);
    let composed: ReturnType<typeof trustFromDocuments>;
    try {
      composed = trustFromDocuments(keys.json, rev.json, {
        expectedIssuer: this.issuer,
        asOf: now,
        minGeneration: this.trustCache?.generation,
        maxLifetimeMs: this.maxLifetimeMs,
      });
    } catch (err) {
      throw new StrixUnavailableError('TRUST_INVALID', err instanceof Error ? err.message : String(err));
    }
    this.trustCache = { trust: composed.trust, validUntil: Date.parse(composed.validUntil), generation: composed.generation };
    return composed.trust;
  }

  /** Ask Strix for bounded authority over one exact proposed execution. Idempotent by proposalId. */
  async evaluate(proposal: ProposedExecution, opts: { minimumApprovals?: number } = {}): Promise<EvaluateResult> {
    const problem = proposalProblem(proposal);
    if (problem) throw new StrixUnavailableError('PROPOSAL_INVALID', problem);
    const body = { contract: CONTRACT, proposal, minimumApprovals: opts.minimumApprovals ?? 1 };
    const r = await this.call('POST', `/api/v1/authority/requests/${encodeURIComponent(proposal.proposalId)}`, body);
    if (r.status !== 200) throw problemFrom(r);
    const j = r.json as Record<string, unknown>;
    if (j.status === 'GRANTED' && j.grant && typeof j.grant === 'object') {
      const grant = j.grant as SignedGrant;
      return { status: 'GRANTED', grant, strixDecisionId: grant.payload?.strixDecisionId };
    }
    if (j.status === 'APPROVAL_REQUIRED') {
      return { status: 'APPROVAL_REQUIRED', strixDecisionId: String(j.strixDecisionId), approvalsRequired: Number(j.approvalsRequired), approvalsGranted: Number(j.approvalsGranted) };
    }
    if (j.status === 'REFUSED') return { status: 'REFUSED', strixDecisionId: (j.strixDecisionId as string | null) ?? null, reasonCode: String(j.reasonCode) };
    throw new StrixUnavailableError('MALFORMED_RESPONSE', 'evaluate answer has no recognized status', r.status);
  }

  /** Verify a grant locally against held trust and the execution about to run. Consumes nothing. */
  async verifyGrant(grant: unknown, execution: CurrentExecution): Promise<GrantVerification> {
    const trust = await this.loadTrust();
    return verifyGrant(grant, trust, execution, this.now());
  }

  /**
   * Redeem the grant for EXACTLY `execution`, immediately before the handler.
   * Only a PERMIT permits execution. Local verification runs first; a forged or
   * untrusted artifact is refused here and never presented. Everything else is
   * presented to Strix, which consumes atomically and records a signed
   * refusal when it refuses. Any HTTP problem is UNAVAILABLE.
   */
  async redeem(grant: unknown, execution: CurrentExecution, consumedBy: string): Promise<RedeemResult> {
    let local: GrantVerification;
    try {
      local = await this.verifyGrant(grant, execution);
    } catch (err) {
      const e = err instanceof StrixUnavailableError ? err : new StrixUnavailableError('TRUST_UNAVAILABLE', String(err));
      return { status: 'UNAVAILABLE', code: e.code, detail: e.message, httpStatus: e.status };
    }
    if (!local.valid && LOCAL_ONLY_REFUSALS.has(local.reason)) {
      return { status: 'REFUSE', refusedBy: 'local', reasonCode: local.reason, detail: local.detail, mismatchedFields: local.mismatchedFields };
    }
    const g = grant as SignedGrant;
    const consequence = Object.fromEntries(BOUND_FIELDS.map((k) => [k, (execution as Record<string, unknown>)[k]]));
    let r: { status: number; json: unknown };
    try {
      r = await this.call('POST', `/api/v1/authority/grants/${encodeURIComponent(g.payload.grantId)}/consume`, { grant, consequence, consumedBy });
    } catch (err) {
      const e = err as StrixUnavailableError;
      return { status: 'UNAVAILABLE', code: e.code, detail: e.message, httpStatus: e.status };
    }
    const j = (r.json ?? {}) as Record<string, unknown>;
    if (r.status === 200 && j.status === 'CONSUMED' && typeof j.grantId === 'string' && typeof j.consumedAt === 'string') {
      return { status: 'PERMIT', grantId: j.grantId, strixDecisionId: String(j.strixDecisionId ?? g.payload.strixDecisionId), consumedAt: j.consumedAt };
    }
    if (r.status === 409 && j.status === 'REFUSED') {
      return {
        status: 'REFUSE',
        refusedBy: 'strix',
        reasonCode: String(j.reasonCode),
        detail: String(j.detail ?? ''),
        mismatchedFields: local.valid ? undefined : local.mismatchedFields,
        ...(typeof j.refusalEvidenceId === 'string' ? { refusalEvidenceId: j.refusalEvidenceId } : {}),
      };
    }
    const e = problemFrom(r);
    return { status: 'UNAVAILABLE', code: e.code, detail: e.message, httpStatus: e.status };
  }

  /** Report what happened after the handler ran. Only meaningful for a consumed grant. */
  async reportOutcome(grantId: string, report: OutcomeReport): Promise<OutcomeResult> {
    const r = await this.call('POST', `/api/v1/authority/grants/${encodeURIComponent(grantId)}/outcome`, report);
    const j = (r.json ?? {}) as Record<string, unknown>;
    if (r.status === 200 && j.status === 'RECORDED') {
      return {
        status: 'RECORDED',
        strixDecisionId: String(j.strixDecisionId),
        state: String(j.state),
        replay: j.replay === true,
        signed: j.signed === true,
        evidenceId: (j.evidenceId as string | null) ?? null,
        evidenceHash: (j.evidenceHash as string | null) ?? null,
        proofPath: (j.proofPath as string | null) ?? null,
      };
    }
    if (r.status === 409 && j.status === 'REFUSED') return { status: 'REFUSED', reasonCode: String(j.reasonCode), detail: String(j.detail ?? '') };
    throw problemFrom(r);
  }

  /** The public proof record for a decision, exactly as Strix serves it. `null` when there is none. */
  async getEvidence(strixDecisionId: string): Promise<unknown | null> {
    const r = await this.call('GET', `/api/public/proof/${encodeURIComponent(strixDecisionId)}`, undefined, false);
    if (r.status === 404) return null;
    if (r.status !== 200) throw problemFrom(r);
    return r.json;
  }

  /**
   * Independent verification of the evidence with `@strixgov/verifier`: the
   * public proof record re-canonicalized and its Ed25519 signature checked
   * against the evidence JWKS. Needs no Strix credential.
   */
  async verify(strixDecisionId: string): Promise<{ verificationStatus: string; verificationReason: string | null; signatureValid: boolean; hashValid: boolean; record: unknown }> {
    const r = (await verifyEvidence(strixDecisionId, { proofBase: this.baseUrl, jwksBase: this.baseUrl })) as {
      verificationStatus: string;
      verificationReason: string | null;
      signatureValid: boolean;
      hashValid: boolean;
      record: unknown;
    };
    return { verificationStatus: r.verificationStatus, verificationReason: r.verificationReason, signatureValid: r.signatureValid, hashValid: r.hashValid, record: r.record };
  }
}

function problemFrom(r: { status: number; json: unknown }): StrixUnavailableError {
  const err = ((r.json ?? {}) as { error?: { code?: string; message?: string } }).error;
  return new StrixUnavailableError(err?.code ?? `HTTP_${r.status}`, err?.message ?? `HTTP ${r.status}`, r.status);
}
