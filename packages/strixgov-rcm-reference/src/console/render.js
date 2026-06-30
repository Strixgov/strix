/**
 * Filmable console renderer.
 *
 * Deliberately high-contrast and slow enough to read on camera: agent actions
 * in cyan, payer reactions in yellow/red, the Strix gate decision as a bold
 * ALLOWED/BLOCKED banner with the signed evidence id. Keep output stable —
 * scenarios are deterministic so every take looks identical.
 */
const C = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    gray: '\x1b[90m',
    bgRed: '\x1b[41m\x1b[97m',
    bgGreen: '\x1b[42m\x1b[30m',
    bgYellow: '\x1b[43m\x1b[30m',
};
export class Console {
    pacing;
    useColor;
    constructor(opts = {}) {
        this.pacing = opts.pacing ?? 0;
        this.useColor = opts.color ?? true;
    }
    c(code, s) {
        return this.useColor ? `${code}${s}${C.reset}` : s;
    }
    async beat() {
        if (this.pacing > 0)
            await new Promise((r) => setTimeout(r, this.pacing));
    }
    line(s = '') {
        process.stdout.write(s + '\n');
    }
    async header(scenario, mode, payerName) {
        this.line();
        this.line(this.c(C.bold, '═'.repeat(72)));
        this.line(this.c(C.bold, `  SCENARIO: ${scenario}`));
        const modeLabel = mode === 'governed'
            ? this.c(C.green, 'GOVERNED by Strix')
            : this.c(C.red, 'UNGOVERNED (policy + guardrails only)');
        this.line(`  MODE:     ${modeLabel}`);
        this.line(this.c(C.gray, `  Payer:    ${payerName}`));
        this.line(this.c(C.bold, '═'.repeat(72)));
        await this.beat();
    }
    async instruction(text) {
        this.line();
        this.line(this.c(C.bold, '▎ Instruction to the agent'));
        this.line(this.c(C.dim, '  ' + text));
        await this.beat();
    }
    async note(text) {
        this.line(this.c(C.gray, '  · ' + text));
        await this.beat();
    }
    agentAction(call) {
        this.line();
        this.line(this.c(C.cyan, `→ AGENT ACTION  ${call.tool}`));
        this.line(this.c(C.cyan, `  ${call.label}`));
        const intent = Object.entries(call.params)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join('  ');
        if (intent)
            this.line(this.c(C.gray, `  intent: ${intent}`));
    }
    gateDecision(outcome) {
        if (outcome.reasonCode === 'INTERCEPTED') {
            this.line(this.c(C.bgYellow, ' STRIX: HELD [INTERCEPTED] '));
            this.line(this.c(C.yellow, '  ' + outcome.reason));
        }
        else if (outcome.allowed) {
            this.line(this.c(C.bgGreen, ' STRIX: ADMITTED ') + ' ' + this.c(C.green, outcome.reason));
        }
        else {
            this.line(this.c(C.bgRed, ` STRIX: BLOCKED [${outcome.reasonCode}] `));
            this.line(this.c(C.red, '  ' + outcome.reason));
        }
        this.line(this.c(C.gray, `  signed evidence ${outcome.evidence.evidenceId}  sig:${outcome.evidence.signature.slice(0, 24)}…`));
    }
    payerResult(result, governed) {
        const tag = result.status === 'ACCEPTED'
            ? this.c(C.green, 'PAYER: ACCEPTED')
            : this.c(C.yellow, `PAYER: ${result.status}`);
        this.line('  ' + tag + this.c(C.gray, `  ${result.detail}`));
        if (result.authNumber)
            this.line(this.c(C.gray, `         auth ${result.authNumber}`));
        if (result.consequence) {
            // The damage. In ungoverned runs this is the punchline.
            this.line(this.c(C.red, this.c(C.bold, '  ⚠ CONSEQUENCE: ') + result.consequence));
        }
    }
    async outcome(governed, ungovernedSummary, governedSummary) {
        this.line();
        this.line(this.c(C.bold, '─'.repeat(72)));
        const summary = governed ? governedSummary : ungovernedSummary;
        const color = governed ? C.green : C.red;
        this.line(this.c(C.bold, '  RESULT: ') + this.c(color, summary));
        this.line(this.c(C.bold, '─'.repeat(72)));
        this.line();
        await this.beat();
    }
}
