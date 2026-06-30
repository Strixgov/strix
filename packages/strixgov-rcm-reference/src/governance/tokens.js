/**
 * (d) Execution Token Service — a faithful re-implementation of the Strix
 * decision-token contract from
 * `apps/strix-console/src/lib/decisions/tokens.ts`.
 *
 * Same wire format, same canonical signature payload, same deny reasons, same
 * `actionParamsHash` binding and atomic single-use redemption. This is the real
 * enforcement mechanism — not a mock of it — operating on an in-process token
 * store instead of Postgres. (Set KERNEL_URL to defer to a hosted kernel; the
 * gate exposes that seam.)
 *
 * Token format: stx1.<jti>.<signature>
 * Signature:    HMAC-SHA256(secret,
 *               "stx1|jti|tenantId|decisionId|actionType|environment|expiresAtEpoch|actionParamsHash")
 *
 * Properties (the five Strix invariants, in code):
 *  - Single-use      : redeem is atomic; second redeem -> REPLAY.
 *  - Time-bound      : tokens expire (default 5m) -> EXPIRED.
 *  - Scope-bound     : tenantId/decisionId/actionType/environment verified.
 *  - Intent-bound    : actionParamsHash bound into signature; a diverged
 *                      action's params hash will not match -> SCOPE_MISMATCH.
 *  - Revocable       : revoke(jti) before use -> NOT_FOUND on redeem.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
const TOKEN_PREFIX = 'stx1';
const DEFAULT_TTL_SECONDS = 300;
let _ephemeralSecret = null;
function getSecret() {
    const secret = process.env.STRIX_DECISION_TOKEN_SECRET;
    if (secret) {
        if (secret.length < 32) {
            throw new Error('STRIX_DECISION_TOKEN_SECRET must be at least 32 characters.');
        }
        return secret;
    }
    if (!_ephemeralSecret)
        _ephemeralSecret = randomUUID() + randomUUID();
    return _ephemeralSecret;
}
// --- canonical actionParams hash (matches strix-platform hashActionParams) ---
function canonicalize(value) {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(canonicalize);
    const out = {};
    for (const k of Object.keys(value).sort()) {
        out[k] = canonicalize(value[k]);
    }
    return out;
}
export function hashActionParams(params) {
    if (params === null || params === undefined)
        return '';
    if (typeof params === 'object' && Object.keys(params).length === 0)
        return '';
    return createHash('sha256').update(JSON.stringify(canonicalize(params))).digest('hex');
}
// --- signature ---
function buildSignaturePayload(p) {
    return [
        TOKEN_PREFIX,
        p.jti,
        p.tenantId,
        p.decisionId,
        p.actionType,
        p.environment || '',
        p.expiresAt.toString(),
        p.actionParamsHash,
    ].join('|');
}
function sign(p) {
    return createHmac('sha256', getSecret()).update(buildSignaturePayload(p)).digest('base64url');
}
function verifySig(p, sig) {
    const expected = sign(p);
    try {
        return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    }
    catch {
        return false;
    }
}
function parse(token) {
    if (typeof token !== 'string')
        return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX)
        return null;
    return { jti: parts[1], signature: parts[2] };
}
/**
 * In-process execution-token service. One instance per scenario run.
 */
export class ExecutionTokenService {
    store = new Map();
    /** Issue a token bound to an approved action + its exact params. */
    issue(scope, approvedParams, ttlSeconds = DEFAULT_TTL_SECONDS) {
        const payload = {
            ...scope,
            jti: randomUUID(),
            expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
            actionParamsHash: hashActionParams(approvedParams),
        };
        const signature = sign(payload);
        this.store.set(payload.jti, { payload, redeemedAt: null, revoked: false });
        return `${TOKEN_PREFIX}.${payload.jti}.${signature}`;
    }
    /** Revoke an issued token before it is used (mid-flight revocation). */
    revoke(jti) {
        const entry = this.store.get(jti);
        if (entry)
            entry.revoked = true;
    }
    /**
     * Atomically redeem a token, enforcing every invariant. The caller passes the
     * hash of the params it is *actually about to execute* — if the agent veered,
     * that hash will not match the bound one and redemption fails SCOPE_MISMATCH.
     */
    redeem(token, expected) {
        const parsed = parse(token);
        if (!parsed)
            return { valid: false, reason: 'NOT_FOUND' };
        const entry = this.store.get(parsed.jti);
        if (!entry || entry.revoked)
            return { valid: false, reason: 'NOT_FOUND', jti: parsed.jti };
        if (!verifySig(entry.payload, parsed.signature)) {
            return { valid: false, reason: 'BAD_SIGNATURE', jti: parsed.jti };
        }
        if (Math.floor(Date.now() / 1000) > entry.payload.expiresAt) {
            return { valid: false, reason: 'EXPIRED', jti: parsed.jti };
        }
        const p = entry.payload;
        if (p.tenantId !== expected.tenantId ||
            p.decisionId !== expected.decisionId ||
            p.actionType !== expected.actionType ||
            p.environment !== expected.environment) {
            return { valid: false, reason: 'SCOPE_MISMATCH', jti: parsed.jti };
        }
        // Intent binding: the action about to execute must match what was approved.
        if (p.actionParamsHash !== expected.actionParamsHash) {
            return { valid: false, reason: 'SCOPE_MISMATCH', jti: parsed.jti };
        }
        // Atomic single-use: first redeem wins, every subsequent one is REPLAY.
        if (entry.redeemedAt !== null) {
            return { valid: false, reason: 'REPLAY', jti: parsed.jti };
        }
        entry.redeemedAt = Date.now();
        return {
            valid: true,
            jti: parsed.jti,
            scope: {
                tenantId: p.tenantId,
                decisionId: p.decisionId,
                actionType: p.actionType,
                environment: p.environment,
            },
            actionParamsHash: p.actionParamsHash,
        };
    }
}
