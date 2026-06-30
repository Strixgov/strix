/**
 * Generate the screenshot-able HTML views.
 *
 *   tsx src/visualize.ts            -> writes visual/*.html
 *
 * Runs every scenario in both modes through the REAL runtime, captures the
 * events, and renders side-by-side pages. Filming/screenshots use the mock
 * payer (the default, the only safe target). See DEMO-SAFETY-BOUNDARY.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { makePayerAdapter } from './adapters/payer.js';
import { StrixGate } from './governance/gate.js';
import { ExecutionRuntime } from './agent/tools.js';
import { buildScenario } from './scenarios/index.js';
import { EventRecorder } from './visual/recorder.js';
import { renderDeck, renderIndex, renderScenarioPage } from './visual/html.js';
const SCENARIOS = ['duplicate', 'scope-creep', 'injection', 'intercept', 'downcode', 'batch-bleed'];
async function recordRun(id, mode) {
    const config = loadConfig();
    const payer = await makePayerAdapter(config);
    const scenario = buildScenario(id);
    const recorder = new EventRecorder();
    let gate = null;
    if (mode === 'governed') {
        gate = new StrixGate();
        gate.approve(scenario.approved);
        gate.requireApproval(scenario.requiresApproval ?? []);
    }
    const rt = new ExecutionRuntime(payer, recorder, gate);
    for (const call of scenario.calls)
        await rt.execute(call);
    return recorder;
}
async function main() {
    const outDir = join(process.cwd(), 'visual');
    mkdirSync(outDir, { recursive: true });
    const payerName = (await makePayerAdapter(loadConfig())).name;
    // Inline the official baked-cyan logomark so each page stays self-contained.
    const logomarkSvg = readFileSync(join(process.cwd(), 'brand', 'strix-logomark.svg'), 'utf8')
        .replace(/<\?xml[^>]*\?>/g, '')
        .trim();
    const deckItems = [];
    for (const id of SCENARIOS) {
        const scenario = buildScenario(id);
        const ungoverned = (await recordRun(id, 'ungoverned')).events;
        const governed = (await recordRun(id, 'governed')).events;
        const html = renderScenarioPage(scenario, ungoverned, governed, payerName, logomarkSvg);
        writeFileSync(join(outDir, `${id}.html`), html);
        console.log(`wrote visual/${id}.html`);
        deckItems.push({ scenario, ungoverned, governed });
    }
    const index = renderIndex(SCENARIOS.map((id) => ({ id, title: buildScenario(id).title })), logomarkSvg);
    writeFileSync(join(outDir, 'index.html'), index);
    console.log('wrote visual/index.html');
    // Single-page send-ready deck: all scenarios in one self-contained file.
    const deck = renderDeck(deckItems, payerName, logomarkSvg);
    writeFileSync(join(outDir, 'proof-deck.html'), deck);
    console.log('wrote visual/proof-deck.html');
}
main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
