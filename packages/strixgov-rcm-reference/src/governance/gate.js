/**
 * (d) Strix execution gate.
 *
 * This is the boundary every state-changing action must clear before it runs.
 * It models the Strix lifecycle:
 *   1. A decision is approved for a SPECIFIC action + SPECIFIC params -> a
 *      single-use, time-bound token is issued bound to that intent.
 *   2. At execution, the tool presents the token AND the params it is actually
 *      about to send. The gate re-evaluates admissibility at point-of-use:
 *        - no token for this action            -> blocked (UNAUTHORIZED)
 *        - params differ from what was approved -> blocked (SCOPE_MISMATCH)
 *        - token already used                   -> blocked (REPLAY)
 *        - token expired / revoked              -> blocked (EXPIRED/NOT_FOUND)
 *   3. Every block produces a signed governance-evidence record.
 *
 * The ungoverned path simply doesn't route through here — which is the entire
 * point of the side-by-side.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { ExecutionTokenService, hashActionParams } from './tokens.js';
const ENVIRONMENT = 'demo';
function signEvidence(e) {
    const canonical = [e.evidenceId, e.decision, e.actionType, e.reasonCode, e.at].join('|');
    // Evidence integrity uses the same secret family as tokens; demo-local.
    const secret = process.env.STRIX_DECISION_TOKEN_SECRET || 'demo-evidence-secret-demo-evidence';
    return createHmac('sha256', secret).update(canonical).digest('base64url');
}
export class StrixGate {
    tokens = new ExecutionTokenService();
    tenantId = 'tenant-demo';
    decisionId;
    /** actionType -> token issued for the approved instance of that action. */
    issued = new Map();
    /**
     * Action types that policy classifies as high-risk: attempting one with no
     * approval is INTERCEPTED (held for a human), not denied. Distinguishes a
     * high-risk-but-wanted action from a genuinely out-of-scope one.
     */
    requiresApprovalSet = new Set();
    constructor(decisionId = `dec-${randomUUID().slice(0, 8)}`) {
        this.decisionId = decisionId;
    }
    /**
     * Approve exactly the instructed action(s). Anything the agent later attempts
     * that wasn't approved here has no token and is structurally unauthorized.
     */
    approve(actions) {
        for (const a of actions) {
            const token = this.tokens.issue({
                tenantId: this.tenantId,
                decisionId: this.decisionId,
                actionType: a.actionType,
                environment: ENVIRONMENT,
            }, a.params);
            this.issued.set(a.actionType, token);
        }
    }
    /**
     * Mark action types as high-risk — requiring explicit human approval. An
     * attempt with no active token is INTERCEPTED (routed for approval) rather
     * than blocked outright.
     */
    requireApproval(actionTypes) {
        for (const t of actionTypes)
            this.requiresApprovalSet.add(t);
    }
    /** Revoke the approval for an action mid-flight (demonstrates revocability). */
    revokeApprovalFor(actionType) {
        const token = this.issued.get(actionType);
        if (!token)
            return;
        const jti = token.split('.')[1];
        this.tokens.revoke(jti);
    }
    /**
     * The execution boundary. Returns whether the action may proceed, plus a
     * signed evidence record either way.
     */
    evaluate(actionType, observedParams) {
        const token = this.issued.get(actionType);
        if (!token) {
            // High-risk action with no approval yet: hold it for a human, don't deny.
            if (this.requiresApprovalSet.has(actionType)) {
                return this.intercept(actionType);
            }
            return this.deny(actionType, 'UNAUTHORIZED', `No approved decision authorizes "${actionType}". The agent exceeded its instructed scope; the action was never admitted.`);
        }
        const result = this.tokens.redeem(token, {
            tenantId: this.tenantId,
            decisionId: this.decisionId,
            actionType,
            environment: ENVIRONMENT,
            actionParamsHash: hashActionParams(observedParams),
        });
        if (result.valid) {
            return this.allow(actionType);
        }
        const reason = {
            SCOPE_MISMATCH: `The action about to execute does not match the approved request (parameters diverged). Re-evaluated at point-of-use and refused.`,
            REPLAY: `This action was already executed once. Authorization is single-use; the duplicate cannot redeem.`,
            EXPIRED: `Authorization expired before the action executed. Approvals are time-bound.`,
            NOT_FOUND: `Authorization was revoked or is not present. The in-flight action is no longer admissible.`,
            BAD_SIGNATURE: `Authorization token failed integrity verification.`,
        };
        return this.deny(actionType, result.reason, reason[result.reason]);
    }
    allow(actionType) {
        const base = {
            evidenceId: `ev-${randomUUID().slice(0, 8)}`,
            decision: 'ALLOWED',
            actionType,
            reason: 'Action matched an approved decision and was admitted at execution time.',
            reasonCode: 'ADMITTED',
            at: new Date().toISOString(),
        };
        const evidence = { ...base, signature: signEvidence(base) };
        return { allowed: true, reasonCode: 'ADMITTED', reason: base.reason, evidence };
    }
    intercept(actionType) {
        const base = {
            evidenceId: `ev-${randomUUID().slice(0, 8)}`,
            decision: 'INTERCEPTED',
            actionType,
            reason: 'High-risk action routed for human approval; not auto-executed. On approval, a single-use token admits it exactly once.',
            reasonCode: 'INTERCEPTED',
            at: new Date().toISOString(),
        };
        const evidence = { ...base, signature: signEvidence(base) };
        return { allowed: false, reasonCode: 'INTERCEPTED', reason: base.reason, evidence };
    }
    deny(actionType, reasonCode, reason) {
        const base = {
            evidenceId: `ev-${randomUUID().slice(0, 8)}`,
            decision: 'BLOCKED',
            actionType,
            reason,
            reasonCode,
            at: new Date().toISOString(),
        };
        const evidence = { ...base, signature: signEvidence(base) };
        return { allowed: false, reasonCode, reason, evidence };
    }
}
