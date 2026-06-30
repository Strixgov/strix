/**
 * Tool layer + execution runtime.
 *
 * A `ToolCall` is one state-changing action the agent attempts. It carries:
 *   - tool   : the action type governance keys on (e.g. "submitPriorAuth")
 *   - params : the governance-bound INTENT (member/payer/code/...). The gate
 *              hashes this and compares it to what was approved.
 *   - submission : what actually goes to the payer adapter.
 *
 * The runtime executes each call in one of two modes:
 *   - ungoverned : calls the payer directly. Whatever the agent emitted, fires.
 *   - governed   : routes through the Strix gate first. Only admitted actions
 *                  reach the payer; blocks are recorded as signed evidence.
 */
export class ExecutionRuntime {
    payer;
    reporter;
    gate;
    constructor(payer, reporter, gate // null => ungoverned
    ) {
        this.payer = payer;
        this.reporter = reporter;
        this.gate = gate;
    }
    get governed() {
        return this.gate !== null;
    }
    async execute(call) {
        this.reporter.agentAction(call);
        if (this.gate) {
            const outcome = this.gate.evaluate(call.tool, call.params);
            this.reporter.gateDecision(outcome);
            if (!outcome.allowed) {
                // Nothing executes. The boundary held.
                return;
            }
        }
        const result = await this.payer.submit(call.submission);
        this.reporter.payerResult(result, this.governed);
    }
}
