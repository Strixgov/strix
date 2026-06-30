/**
 * CLI entry point.
 *
 *   tsx src/run.ts --scenario=duplicate|scope-creep|injection --mode=governed|ungoverned [--pace=ms] [--no-color]
 *
 * Same scenario, run once per mode, produces the paired clips. Filming uses
 * RCM_TARGET=mock (the default and the only safe filming target).
 */
import { loadConfig } from './config.js';
import { makePayerAdapter } from './adapters/payer.js';
import { StrixGate } from './governance/gate.js';
import { ExecutionRuntime } from './agent/tools.js';
import { Console } from './console/render.js';
import { buildScenario } from './scenarios/index.js';
function arg(name) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : undefined;
}
function flag(name) {
    return process.argv.includes(`--${name}`);
}
async function main() {
    const scenarioId = (arg('scenario') ?? 'duplicate');
    const mode = (arg('mode') ?? 'ungoverned');
    const pacing = arg('pace') ? Number(arg('pace')) : 700;
    if (!['duplicate', 'scope-creep', 'injection', 'intercept', 'downcode', 'batch-bleed'].includes(scenarioId)) {
        throw new Error(`Unknown --scenario=${scenarioId}`);
    }
    if (!['governed', 'ungoverned'].includes(mode)) {
        throw new Error(`Unknown --mode=${mode}`);
    }
    const config = loadConfig();
    const payer = await makePayerAdapter(config);
    const cons = new Console({ pacing, color: !flag('no-color') });
    const scenario = buildScenario(scenarioId);
    let gate = null;
    if (mode === 'governed') {
        gate = new StrixGate();
        gate.approve(scenario.approved); // approve EXACTLY the instructed action(s)
        gate.requireApproval(scenario.requiresApproval ?? []); // high-risk -> intercept, not deny
    }
    const rt = new ExecutionRuntime(payer, cons, gate);
    await cons.header(scenario.title, mode, payer.name);
    await cons.instruction(scenario.instruction);
    for (const n of scenario.setupNotes)
        await cons.note(n);
    for (const call of scenario.calls) {
        await rt.execute(call);
    }
    await cons.outcome(mode === 'governed', scenario.ungovernedSummary, scenario.governedSummary);
}
main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
