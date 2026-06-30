/**
 * EventRecorder — captures the runtime's events into a structured timeline so
 * the HTML view renders exactly what really happened (no hand-authored visuals).
 */
export class EventRecorder {
    events = [];
    async header() { }
    async instruction() { }
    async note() { }
    async outcome() { }
    agentAction(call) {
        this.events.push({ kind: 'agentAction', tool: call.tool, label: call.label, params: call.params });
    }
    gateDecision(outcome) {
        this.events.push({
            kind: 'gate',
            allowed: outcome.allowed,
            reasonCode: outcome.reasonCode,
            reason: outcome.reason,
            evidenceId: outcome.evidence.evidenceId,
            signature: outcome.evidence.signature,
        });
    }
    payerResult(result) {
        this.events.push({
            kind: 'payer',
            status: result.status,
            detail: result.detail,
            authNumber: result.authNumber,
            consequence: result.consequence,
        });
    }
}
