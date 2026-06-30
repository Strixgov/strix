import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario } from '../src/scenarios/index.js';
import { StrixGate } from '../src/governance/gate.js';
import { ExecutionTokenService, hashActionParams } from '../src/governance/tokens.js';
/** Replays a scenario through a fresh gate and returns the per-call reason codes. */
function governedReasonCodes(id) {
    const scenario = buildScenario(id);
    const gate = new StrixGate();
    gate.approve(scenario.approved);
    return scenario.calls.map((c) => gate.evaluate(c.tool, c.params).reasonCode);
}
test('duplicate: second identical submission is blocked REPLAY', () => {
    assert.deepEqual(governedReasonCodes('duplicate'), ['ADMITTED', 'REPLAY']);
});
test('scope-creep: the unapproved write-off is blocked UNAUTHORIZED', () => {
    assert.deepEqual(governedReasonCodes('scope-creep'), ['ADMITTED', 'UNAUTHORIZED']);
});
test('injection: the diverged (wrong-code) action is blocked SCOPE_MISMATCH', () => {
    assert.deepEqual(governedReasonCodes('injection'), ['SCOPE_MISMATCH']);
});
test('downcode: a legitimate downcode within the approved family is ADMITTED', () => {
    const scenario = buildScenario('downcode');
    const gate = new StrixGate();
    gate.approve(scenario.approved); // approved for the MRI-abdomen family scope
    const codes = scenario.calls.map((c) => gate.evaluate(c.tool, c.params).reasonCode);
    assert.deepEqual(codes, ['ADMITTED']);
});
test('downcode: a code OUTSIDE the approved family is refused (SCOPE_MISMATCH)', () => {
    // The family approval must not become a blanket pass. A submission whose
    // scope key differs (a code outside the approved family) does not redeem.
    const scenario = buildScenario('downcode');
    const gate = new StrixGate();
    gate.approve(scenario.approved);
    const outOfFamily = { ...scenario.calls[0].params, cptScope: 'MRI-PELVIS-FAMILY[72195|72196|72197]' };
    assert.equal(gate.evaluate('submitPriorAuth', outOfFamily).reasonCode, 'SCOPE_MISMATCH');
});
test('intercept: a high-risk, unapproved submission is HELD (INTERCEPTED), not denied', () => {
    const scenario = buildScenario('intercept');
    const gate = new StrixGate();
    gate.approve(scenario.approved); // empty — the action is intentionally unapproved
    gate.requireApproval(scenario.requiresApproval ?? []);
    const outcomes = scenario.calls.map((c) => gate.evaluate(c.tool, c.params));
    assert.deepEqual(outcomes.map((o) => o.reasonCode), ['INTERCEPTED']);
    // Held, not executed: the gate does not admit it (no payer call follows).
    assert.equal(outcomes[0].allowed, false);
    // And it is distinct from an out-of-scope denial.
    assert.notEqual(outcomes[0].reasonCode, 'UNAUTHORIZED');
});
test('intercept without the high-risk flag would be a plain UNAUTHORIZED denial', () => {
    // Proves INTERCEPTED is driven by the requiresApproval classification, not
    // by the action itself — without the flag, an unapproved action is denied.
    const scenario = buildScenario('intercept');
    const gate = new StrixGate();
    // no requireApproval() call this time
    const outcome = gate.evaluate(scenario.calls[0].tool, scenario.calls[0].params);
    assert.equal(outcome.reasonCode, 'UNAUTHORIZED');
});
test('batch-bleed: a wrong-patient submission is blocked SCOPE_MISMATCH', () => {
    // The approval is bound to the intended patient; a submission carrying the
    // prior patient's member ID (context bleed in a batch) does not redeem it.
    assert.deepEqual(governedReasonCodes('batch-bleed'), ['SCOPE_MISMATCH']);
});
test('ungoverned has no gate: every call would reach the payer', () => {
    // Sanity: with no approvals, the gate would block everything — proving the
    // ungoverned path differs only by NOT routing through the gate.
    for (const id of ['duplicate', 'scope-creep', 'injection']) {
        const scenario = buildScenario(id);
        const gate = new StrixGate(); // no approvals
        for (const c of scenario.calls) {
            assert.equal(gate.evaluate(c.tool, c.params).allowed, false);
        }
    }
});
test('token service: single-use redemption is atomic', () => {
    const svc = new ExecutionTokenService();
    const scope = { tenantId: 't', decisionId: 'd', actionType: 'a', environment: 'demo' };
    const params = { x: 1 };
    const token = svc.issue(scope, params);
    const expected = { ...scope, actionParamsHash: hashActionParams(params) };
    assert.equal(svc.redeem(token, expected).valid, true);
    const second = svc.redeem(token, expected);
    assert.equal(second.valid, false);
    assert.equal(second.reason, 'REPLAY');
});
test('token service: revocation makes an issued token NOT_FOUND', () => {
    const svc = new ExecutionTokenService();
    const scope = { tenantId: 't', decisionId: 'd', actionType: 'a', environment: 'demo' };
    const token = svc.issue(scope, {});
    const jti = token.split('.')[1];
    svc.revoke(jti);
    const r = svc.redeem(token, { ...scope, actionParamsHash: '' });
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'NOT_FOUND');
});
test('token service: expired token is rejected EXPIRED', () => {
    const svc = new ExecutionTokenService();
    const scope = { tenantId: 't', decisionId: 'd', actionType: 'a', environment: 'demo' };
    const token = svc.issue(scope, {}, -1); // already expired
    const r = svc.redeem(token, { ...scope, actionParamsHash: '' });
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'EXPIRED');
});
test('config: production target is forbidden', async () => {
    const prev = process.env.RCM_TARGET;
    process.env.RCM_TARGET = 'production';
    const { loadConfig } = await import('../src/config.js');
    assert.throws(() => loadConfig(), /forbidden/);
    process.env.RCM_TARGET = prev;
});
