/**
 * @strixgov/governed-action — wrap one consequential mutation in a governed,
 * independently verifiable action.
 *
 * This is the installable form of the path the `/strix-wire` Claude Code skill
 * previously only reached by copying a helper file into your repository. The
 * protocol is deliberately identical:
 *
 *   1. Ask the kernel whether the action is allowed (POST /api/v1/evaluate) and
 *      capture the returned decisionId.
 *   2. If allowed, run the operation. If denied or approval-gated, throw BEFORE
 *      running it — the side effect must never happen on a block path.
 *   3. Record an evidence row (POST /api/v1/evidence/ingest).
 *   4. Close the proof loop (POST /api/v1/decisions/{id}/receipt), which
 *      Ed25519-signs the decision and returns a genuinely verifiable evidenceId.
 *
 * Step 4 is what makes the final line a real `Status: VERIFIED` rather than an
 * unsigned record. It degrades gracefully: the mutation already succeeded and is
 * never undone for want of a receipt, so the caller gets `signedEvidenceId: null`
 * instead of a thrown error — and the fields are never fabricated (PROOF-1).
 *
 * CANONICALIZATION: imported from @strixgov/sdk, never re-implemented. CJ-1
 * requires every signer and verifier in the platform to serialize through SCJ
 * v1; a second implementation here would be exactly the drift that contract
 * exists to prevent.
 *
 * Zero-account: with no STRIX_API_KEY / STRIX_TENANT_ID configured, a
 * short-lived sandbox credential is auto-provisioned. The sandbox tenant
 * auto-executes only a closed set of capability ids; every other id still goes
 * through that tenant's real risk gating.
 */

import { canonicalizeJSONScjV1Mirror } from '@strixgov/sdk';

export {
  resolveCapability,
  qualifiesAsFirstProof,
  type RiskTier,
  type ProofQualification,
  type ResolvedCapability,
  type CapabilityClassification,
} from './capabilities.js';

const DEFAULT_URL = 'https://www.strixgov.com';
const EVALUATE_PATH = '/api/v1/evaluate';
const EVIDENCE_PATH = '/api/v1/evidence/ingest';
const SANDBOX_PROVISION_PATH = '/api/public/sandbox/provision';
const DEFAULT_TIMEOUT_MS = 5000;

// ── Errors ─────────────────────────────────────────────────────────────────

export class StrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrixError';
  }
}
/** The kernel refused. The operation was NOT run. */
export class StrixDenied extends StrixError {
  constructor(message: string) { super(message); this.name = 'StrixDenied'; }
}
/** Out-of-band approval is required. The operation was NOT run. */
export class StrixApprovalRequired extends StrixError {
  constructor(message: string) { super(message); this.name = 'StrixApprovalRequired'; }
}
/** The kernel was unreachable. The operation was NOT run — fail closed. */
export class StrixUnreachable extends StrixError {
  constructor(message: string) { super(message); this.name = 'StrixUnreachable'; }
}

// ── Hashing ────────────────────────────────────────────────────────────────

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function newEvidenceId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string; getRandomValues: (a: Uint8Array) => Uint8Array };
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── Transport ──────────────────────────────────────────────────────────────

/** Remove the credential from anything that could reach a log or an exception. */
function makeScrubber(apiKey: string): (text: string) => string {
  return (text: string) => {
    if (!apiKey) return text;
    return text.split(`Bearer ${apiKey}`).join('Bearer <redacted>').split(apiKey).join('<redacted>');
  };
}

async function postJSON(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  scrub: (t: string) => string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: canonicalizeJSONScjV1Mirror(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new StrixUnreachable(`network error: ${scrub((err as Error).message)}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();

  // An HTTP error here is a TRANSPORT/AUTH failure and NEVER a governance
  // verdict. The kernel expresses a denial as HTTP 200 with `action: 'deny'`
  // (classified by the caller below), so nothing reaching this branch has been
  // evaluated by policy at all.
  //
  // This used to map every 4xx to StrixDenied, which asserted "governance
  // refused you" when governance was never consulted. Caught by running the
  // demo through a network egress allowlist: the proxy's
  // `403 Host not in allowlist` surfaced as StrixDenied, and the CLI duly
  // printed "The operation did NOT run. That is the system working." It had NOT
  // run — but that was infrastructure, not the system working, and an operator
  // would have gone hunting for a policy bug that does not exist. The same
  // wrong reason would have covered an expired API key (401) and a wrong
  // endpoint (404).
  //
  // The safety property is unchanged — every path here still fails closed and
  // the wrapped operation never runs. Only the reported reason changes, from a
  // confident false verdict to an honest "no decision was obtained".
  if (!resp.ok) {
    const detail = scrub(text.slice(0, 200));
    const why =
      resp.status === 401 || resp.status === 403
        ? 'no decision obtained — credential or network egress, not a policy verdict'
        : 'no decision obtained';
    throw new StrixUnreachable(`strix ${resp.status} (${why}): ${detail}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new StrixUnreachable(`strix returned non-JSON: ${scrub(text.slice(0, 200))}`);
  }
}

async function provisionSandbox(
  base: string,
  timeoutMs: number,
): Promise<{ apiKey: string; tenantId: string }> {
  const resp = await postJSON(`${base}${SANDBOX_PROVISION_PATH}`, {}, {}, timeoutMs, (t) => t);
  const apiKey = typeof resp.apiKey === 'string' ? resp.apiKey : '';
  const tenantId = typeof resp.tenantId === 'string' ? resp.tenantId : '';
  if (!apiKey || !tenantId) {
    throw new StrixError(
      'sandbox auto-provisioning returned no credentials — set STRIX_API_KEY and ' +
        'STRIX_TENANT_ID explicitly, or retry shortly.',
    );
  }
  return { apiKey, tenantId };
}

// ── Public surface ─────────────────────────────────────────────────────────

export interface GovernedActionInput {
  /** A REAL registered capability id, e.g. "mcp.github.merge_pull_request". */
  capabilityId: string;
  /** Non-secret request parameters. Hashed, and recorded on the success path. */
  payload: Record<string, unknown>;
  /** Who ran it. Defaults to STRIX_ACTOR, then "governed-action". */
  actor?: string;
  apiKey?: string;
  tenantId?: string;
  strixUrl?: string;
  timeoutMs?: number;
}

export interface GovernedActionResult<T> {
  result: T;
  /** Client-generated id of the unsigned evidence/ingest audit row. */
  evidenceId: string;
  /**
   * These are null when the evaluate response carried no decisionId, or when
   * the receipt call failed. The mutation still ran. They are never fabricated.
   */
  decisionId: string | null;
  signedEvidenceId: string | null;
  proofUrl: string | null;
  /** Always @latest-pinned (INSTALL-1), constructed here rather than trusted. */
  verifyCommand: string | null;
}

function env(): Record<string, string | undefined> {
  return (typeof process !== 'undefined' && process.env) || {};
}

/**
 * Govern one consequential mutation.
 *
 * @throws StrixDenied            kernel refused; operation NOT run
 * @throws StrixApprovalRequired  approval needed; operation NOT run
 * @throws StrixUnreachable       kernel unreachable; operation NOT run
 * @throws whatever the operation itself throws, after a best-effort failure
 *         evidence row and FAILED receipt
 */
export async function governedAction<T>(
  input: GovernedActionInput,
  operation: () => Promise<T> | T,
): Promise<GovernedActionResult<T>> {
  const e = env();
  // `||` not `??`: an empty-but-set value must behave like an unset one.
  const base = (input.strixUrl || e.STRIX_API_URL || DEFAULT_URL).replace(/\/+$/, '');
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let apiKey = (input.apiKey ?? e.STRIX_API_KEY ?? '').trim();
  let tenantId = (input.tenantId ?? e.STRIX_TENANT_ID ?? '').trim();
  if (!apiKey || !tenantId) {
    const p = await provisionSandbox(base, timeout);
    apiKey = p.apiKey;
    tenantId = p.tenantId;
  }

  const scrub = makeScrubber(apiKey);
  const actor = (input.actor ?? e.STRIX_ACTOR ?? '').trim() || 'governed-action';
  const headers = { Authorization: `Bearer ${apiKey}`, 'X-Tenant-Id': tenantId };
  const payloadHash = await sha256Hex(canonicalizeJSONScjV1Mirror(input.payload));

  // 1. Evaluate BEFORE running anything.
  const decision = await postJSON(
    `${base}${EVALUATE_PATH}`,
    {
      capabilityId: input.capabilityId,
      actor: { id: actor, role: 'operator' },
      context: { payloadHash, source: 'governed-action' },
    },
    headers,
    timeout,
    scrub,
  );

  const decisionId = typeof decision.decisionId === 'string' ? decision.decisionId : null;
  const verdict = String(decision.action ?? decision.decision ?? '').toLowerCase();

  if (verdict === 'deny') {
    throw new StrixDenied(`${input.capabilityId}: ${scrub(String(decision.reason ?? 'policy denied'))}`);
  }
  if (verdict === 'escalate' || verdict === 'require_approval') {
    throw new StrixApprovalRequired(
      `${input.capabilityId} requires approval before it can execute. Approve the ` +
        'decision in the Strix console, then retry.',
    );
  }
  if (verdict !== 'allow') {
    throw new StrixError(`unexpected kernel decision: ${scrub(verdict)}`);
  }

  // 2. Run.
  const started = Date.now();
  let result: T;
  try {
    result = await operation();
  } catch (err) {
    await recordEvidence({
      base, headers, timeout, scrub, tenantId, actor,
      capabilityId: input.capabilityId, payloadHash, resultHash: null,
      outcome: 'error', durationMs: Date.now() - started,
    }).catch(() => undefined);
    if (decisionId) {
      await postReceipt(base, headers, timeout, scrub, decisionId, false).catch(() => undefined);
    }
    throw err;
  }

  // 3. Record evidence.
  const resultHash = await sha256Hex(canonicalizeJSONScjV1Mirror(toJSONable(result)));
  const evidenceId = await recordEvidence({
    base, headers, timeout, scrub, tenantId, actor,
    capabilityId: input.capabilityId, payloadHash, resultHash,
    outcome: 'ok', durationMs: Date.now() - started, payload: input.payload,
  });

  // 4. Close the proof loop. Degrades gracefully — never undoes the mutation.
  let signedEvidenceId: string | null = null;
  let proofUrl: string | null = null;
  let verifyCommand: string | null = null;
  if (decisionId) {
    try {
      const receipt = await postReceipt(base, headers, timeout, scrub, decisionId, true, toJSONable(result));
      signedEvidenceId = typeof receipt.evidenceId === 'string' ? receipt.evidenceId : null;
      proofUrl = typeof receipt.proofUrl === 'string' ? receipt.proofUrl : null;
      if (signedEvidenceId) {
        verifyCommand = `npx @strixgov/verifier@latest ${signedEvidenceId}`;
      }
    } catch {
      /* the mutation already succeeded; leave the fields null rather than guess */
    }
  }

  return { result, evidenceId, decisionId, signedEvidenceId, proofUrl, verifyCommand };
}

interface EvidenceArgs {
  base: string;
  headers: Record<string, string>;
  timeout: number;
  scrub: (t: string) => string;
  tenantId: string;
  actor: string;
  capabilityId: string;
  payloadHash: string;
  resultHash: string | null;
  outcome: 'ok' | 'error';
  durationMs: number;
  /** Success path only — a failed operation's params are never persisted. */
  payload?: Record<string, unknown>;
}

async function recordEvidence(p: EvidenceArgs): Promise<string> {
  const evidenceId = newEvidenceId();
  // Server-side dedup identity is (tenantId, evidenceHash). Binding the fresh
  // evidenceId into the hashed material makes every execution a distinct row
  // while keeping a retry of the SAME record idempotent.
  const evidenceHash = await sha256Hex(
    canonicalizeJSONScjV1Mirror({
      capabilityId: p.capabilityId,
      evidenceId,
      outcome: p.outcome,
      payloadHash: p.payloadHash,
      resultHash: p.resultHash,
    }),
  );
  const resp = await postJSON(
    `${p.base}${EVIDENCE_PATH}`,
    {
      records: [{
        tenantId: p.tenantId,
        capabilityId: p.capabilityId,
        actorId: p.actor,
        actorRole: 'operator',
        decision: 'allow',
        reason: p.outcome === 'ok' ? 'governed action executed' : 'governed action failed after allow',
        source: 'governed-action',
        evidenceHash,
        evidenceId,
        timestamp: new Date().toISOString(),
        metadata: {
          payloadHash: p.payloadHash,
          resultHash: p.resultHash,
          outcome: p.outcome,
          durationMs: p.durationMs,
          ...(p.payload !== undefined ? { payload: p.payload } : {}),
        },
      }],
    },
    p.headers, p.timeout, p.scrub,
  );
  const ingested = Number(resp.ingested ?? 0);
  const skipped = Number(resp.skipped ?? 0);
  if (ingested + skipped < 1) {
    throw new StrixError(
      `evidence endpoint accepted 0 records (ingested=${ingested}, skipped=${skipped})`,
    );
  }
  return evidenceId;
}

async function postReceipt(
  base: string,
  headers: Record<string, string>,
  timeout: number,
  scrub: (t: string) => string,
  decisionId: string,
  success: boolean,
  result?: unknown,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { success };
  if (result !== undefined) body.result = result;
  return postJSON(
    `${base}/api/v1/decisions/${encodeURIComponent(decisionId)}/receipt`,
    body, headers, timeout, scrub,
  );
}

// ── The REST path ──────────────────────────────────────────────────────────

export interface GovernedFetchInit extends Omit<RequestInit, 'signal'> {
  /** Request timeout for the wrapped call itself, separate from kernel calls. */
  timeoutMs?: number;
}

export interface GovernedResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Parsed JSON when the response is JSON, else the raw text. */
  body: unknown;
}

/**
 * Govern an arbitrary HTTP mutation — the "or a REST endpoint" path.
 *
 * The recorded payload deliberately carries the method, the URL and the request
 * body, but NOT request headers: headers are where credentials live, and this
 * package must never hash or transmit them into an evidence row.
 *
 *   const { verifyCommand } = await governedFetch(
 *     'mcp.github.merge_pull_request',
 *     'https://api.github.com/repos/o/r/pulls/1/merge',
 *     { method: 'PUT', headers: { Authorization: `Bearer ${token}` } },
 *   );
 *
 * A non-2xx response is returned, not thrown: the call genuinely happened and
 * the evidence should reflect that. Only a transport failure throws.
 */
export async function governedFetch(
  capabilityId: string,
  url: string,
  init: GovernedFetchInit = {},
  options: Omit<GovernedActionInput, 'capabilityId' | 'payload'> = {},
): Promise<GovernedActionResult<GovernedResponse>> {
  const method = (init.method ?? 'GET').toUpperCase();
  const { timeoutMs: callTimeout, headers: _drop, ...rest } = init;

  let requestBody: unknown;
  if (typeof init.body === 'string') {
    try { requestBody = JSON.parse(init.body); } catch { requestBody = init.body; }
  } else if (init.body !== undefined && init.body !== null) {
    requestBody = '<non-string body omitted from evidence>';
  }

  const payload: Record<string, unknown> = { method, url };
  if (requestBody !== undefined) payload.requestBody = requestBody;

  return governedAction<GovernedResponse>({ ...options, capabilityId, payload }, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callTimeout ?? 30_000);
    try {
      const resp = await fetch(url, { ...init, ...rest, signal: controller.signal });
      const text = await resp.text();
      let body: unknown = text;
      const ct = resp.headers.get('content-type') ?? '';
      if (ct.includes('json') && text) {
        try { body = JSON.parse(text); } catch { /* keep raw text */ }
      }
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      return { status: resp.status, ok: resp.ok, headers, body };
    } finally {
      clearTimeout(timer);
    }
  });
}

function toJSONable(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (['boolean', 'number', 'string'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(toJSONable);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJSONable(v);
    return out;
  }
  return String(value);
}
