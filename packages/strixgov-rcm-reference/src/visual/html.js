/**
 * HTML renderer for the proof kit. Produces a self-contained, dark-themed,
 * side-by-side page per scenario — built to open in a browser and screenshot
 * for the lead package. Driven entirely by captured runtime events.
 */
function esc(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}
function statusClass(status) {
    if (status === 'ACCEPTED')
        return 'ok';
    if (status === 'REJECTED')
        return 'bad';
    return 'warn'; // DUPLICATE / FLAGGED
}
/**
 * Primary Strix logo lockup per the design system: baked-cyan mark (inlined so
 * pages stay self-contained), Arial Black wordmark tracked +0.08em, and the
 * "Execution control" tagline. The mark color #3BB5C9 is baked into the SVG —
 * never recolored.
 */
function lockup(logomarkSvg) {
    return `<div class="lockup">
      <span class="mark">${logomarkSvg}</span>
      <span class="wm"><span class="word">STRIX</span><span class="tag">Execution control</span></span>
    </div>`;
}
function renderEvents(events) {
    return events
        .map((e) => {
        if (e.kind === 'agentAction') {
            const chips = Object.entries(e.params)
                .map(([k, v]) => `<span class="chip"><b>${esc(k)}</b>=${esc(v)}</span>`)
                .join('');
            return `
          <div class="card agent">
            <div class="card-head"><span class="tag">AGENT ACTION</span><code>${esc(e.tool)}</code></div>
            <div class="card-body">${esc(e.label)}</div>
            <div class="chips">${chips}</div>
          </div>`;
        }
        if (e.kind === 'gate') {
            const intercepted = e.reasonCode === 'INTERCEPTED';
            const cls = intercepted ? 'hold' : e.allowed ? 'admit' : 'block';
            const banner = intercepted
                ? `STRIX · HELD [${esc(e.reasonCode)}]`
                : e.allowed
                    ? 'STRIX · ADMITTED'
                    : `STRIX · BLOCKED [${esc(e.reasonCode)}]`;
            return `
          <div class="card gate ${cls}">
            <div class="gate-banner">${banner}</div>
            <div class="card-body">${esc(e.reason)}</div>
            <div class="evidence">signed evidence <code>${esc(e.evidenceId)}</code> · sig:${esc(e.signature.slice(0, 28))}…</div>
          </div>`;
        }
        // payer
        const cons = e.consequence
            ? `<div class="consequence">⚠ CONSEQUENCE — ${esc(e.consequence)}</div>`
            : '';
        const auth = e.authNumber ? `<span class="auth">auth ${esc(e.authNumber)}</span>` : '';
        return `
        <div class="card payer">
          <div class="card-head"><span class="pill ${statusClass(e.status)}">PAYER · ${esc(e.status)}</span>${auth}</div>
          <div class="card-body">${esc(e.detail)}</div>
          ${cons}
        </div>`;
    })
        .join('');
}
function column(side, events, summary) {
    const title = side === 'governed' ? 'GOVERNED' : 'UNGOVERNED';
    const sub = side === 'governed' ? 'Strix execution gate' : 'policy + guardrails only';
    return `
    <section class="col ${side}">
      <header class="col-head">
        <span class="dot"></span>
        <div><h2>${title}</h2><p>${sub}</p></div>
      </header>
      <div class="timeline">${renderEvents(events)}</div>
      <footer class="summary">${esc(summary)}</footer>
    </section>`;
}
export function renderScenarioPage(scenario, ungoverned, governed, payerName, logomarkSvg) {
    const notes = scenario.setupNotes.map((n) => `<li>${esc(n)}</li>`).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Strix RCM Proof · ${esc(scenario.title)}</title>
<style>${CSS}</style></head>
<body>
  <div class="wrap">
    ${lockup(logomarkSvg)}
    <h1>${esc(scenario.title)}</h1>
    <div class="meta">
      <div class="instruction"><span class="lbl">Instruction to the agent</span>${esc(scenario.instruction)}</div>
      <div class="veer"><span class="lbl">What happened at runtime</span><ul>${notes}</ul></div>
      <div class="payer-line">Payer endpoint: <code>${esc(payerName)}</code> · synthetic data only</div>
    </div>
    <div class="cols">
      ${column('ungoverned', ungoverned, scenario.ungovernedSummary)}
      ${column('governed', governed, scenario.governedSummary)}
    </div>
    <div class="foot">Same agent · same task · same payer. The only difference is whether each action is re-evaluated at the moment it executes.</div>
  </div>
</body></html>`;
}
export function renderIndex(scenarios, logomarkSvg) {
    const items = scenarios
        .map((s) => `<li><a href="./${esc(s.id)}.html">${esc(s.title)}</a></li>`)
        .join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>Strix RCM Governance Proof</title><style>${CSS}</style></head>
<body><div class="wrap">
  ${lockup(logomarkSvg)}
  <h1>RCM Governance Proof — governed vs. ungoverned</h1>
  <p class="lead">Same prior-authorization agent, same task, on a real X12-278 stack with synthetic patients. Each scenario stops a wrong, duplicated, or out-of-scope action at the moment it executes.</p>
  <ul class="index">${items}</ul>
</div></body></html>`;
}
/**
 * Single-page "proof deck" — all scenarios stacked in one self-contained,
 * brandable HTML file. This is the send-ready artifact: one attachment a lead
 * can open in any browser (no install), screenshot, or screen-record.
 */
export function renderDeck(items, payerName, logomarkSvg) {
    const blocks = items
        .map(({ scenario, ungoverned, governed }) => {
        const notes = scenario.setupNotes.map((n) => `<li>${esc(n)}</li>`).join('');
        return `
      <section class="deck-scenario">
        <h2 class="deck-title">${esc(scenario.title)}</h2>
        <div class="meta">
          <div class="instruction"><span class="lbl">Instruction to the agent</span>${esc(scenario.instruction)}</div>
          <div class="veer"><span class="lbl">What happened at runtime</span><ul>${notes}</ul></div>
        </div>
        <div class="cols">
          ${column('ungoverned', ungoverned, scenario.ungovernedSummary)}
          ${column('governed', governed, scenario.governedSummary)}
        </div>
      </section>`;
    })
        .join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Strix · RCM Governance Proof</title>
<style>${CSS}</style></head>
<body>
  <div class="wrap">
    ${lockup(logomarkSvg)}
    <h1>The same agent, the same task — once governed.</h1>
    <p class="lead">A prior-authorization agent runs six tasks drawn from real revenue-cycle failure modes, on a real X12&nbsp;278 surface with synthetic patients. Each runs twice: once with policy + guardrails only, once governed by a Strix execution gate. Guardrails check the plan; Strix re-checks the action at the moment it executes.</p>
    <p class="payer-line">Payer endpoint: <code>${esc(payerName)}</code> · synthetic data only · no production system touched</p>
    ${blocks}
    <div class="foot">Same agent · same task · same payer. The only variable is whether each action is re-evaluated at the moment it executes. — strixgov.com</div>
  </div>
</body></html>`;
}
const CSS = `
/* Aligned to the Strix design system (colors_and_type.css): dark-navy surface
   stack, fg text ramp, Arial brand font. Logo cyan #3BB5C9 is the mark color
   (baked in the SVG); the brand accent blue #2F81F7 is intentionally separate. */
:root{--bg:#0B1120;--panel:#0E1629;--card:#121C33;--line:#1E2A47;
--ink:#E6EDF3;--mut:#7D8590;--cyan:#3BB5C9;--green:#3FB950;--red:#F85149;--amber:#D29922;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.5 Arial,'Helvetica Neue',Helvetica,sans-serif;
-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
code,.chip b{font-family:'JetBrains Mono','SF Mono',Menlo,Consolas,monospace}
.wrap{max-width:1180px;margin:0 auto;padding:32px 28px 48px}
.lockup{display:flex;align-items:center;gap:13px}
.lockup .mark svg{height:34px;width:auto;display:block}
.lockup .wm{display:flex;flex-direction:column;gap:3px}
.lockup .word{font:900 22px/1 Arial,'Helvetica Neue',Helvetica,sans-serif;letter-spacing:.08em;color:var(--ink)}
.lockup .tag{font:500 9px/1 Arial,'Helvetica Neue',Helvetica,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--mut)}
h1{font-size:28px;margin:.5em 0 .6em}
.lead{color:var(--mut);max-width:760px}
.meta{display:grid;gap:14px;background:var(--panel);border:1px solid var(--line);
border-radius:14px;padding:18px 20px;margin:18px 0 24px}
.lbl{display:block;text-transform:uppercase;letter-spacing:.1em;font-size:11px;
color:var(--mut);margin-bottom:4px}
.veer ul{margin:.2em 0 0;padding-left:18px;color:var(--ink)}
.veer li{margin:.2em 0}
.payer-line{color:var(--mut);font-size:13px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.col{background:var(--panel);border:1px solid var(--line);border-radius:14px;
padding:16px;display:flex;flex-direction:column}
.col-head{display:flex;align-items:center;gap:12px;padding-bottom:12px;
border-bottom:1px solid var(--line);margin-bottom:14px}
.col-head h2{margin:0;font-size:18px;letter-spacing:.06em}
.col-head p{margin:0;color:var(--mut);font-size:12px}
.dot{width:12px;height:12px;border-radius:50%}
.ungoverned .dot{background:var(--red);box-shadow:0 0 12px var(--red)}
.governed .dot{background:var(--green);box-shadow:0 0 12px var(--green)}
.timeline{display:flex;flex-direction:column;gap:12px;flex:1}
.card{border:1px solid var(--line);border-radius:11px;padding:12px 14px;background:#0e1420}
.card-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.card-body{font-size:14px}
.tag{font-size:10px;letter-spacing:.1em;background:#11313a;color:var(--cyan);
padding:3px 7px;border-radius:6px;font-weight:700}
.card.agent{border-left:3px solid var(--cyan)}
.card.agent code{color:var(--cyan)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{font-size:11px;background:#0b1220;border:1px solid var(--line);
border-radius:6px;padding:2px 7px;color:var(--mut)}
.chip b{color:var(--ink)}
.gate-banner{font-weight:800;letter-spacing:.04em;font-size:13px;margin-bottom:6px}
.card.admit{border-left:3px solid var(--green);background:#0c1b16}
.card.admit .gate-banner{color:var(--green)}
.card.block{border-left:3px solid var(--red);background:#1c1113}
.card.block .gate-banner{color:var(--red)}
.card.hold{border-left:3px solid var(--amber);background:#1d1707}
.card.hold .gate-banner{color:var(--amber)}
.evidence{margin-top:8px;font-size:11px;color:var(--mut)}
.evidence code{color:var(--ink)}
.pill{font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px}
.pill.ok{background:#0c2a1f;color:var(--green)}
.pill.warn{background:#2c2410;color:var(--amber)}
.pill.bad{background:#2a1213;color:var(--red)}
.auth{font-size:12px;color:var(--mut)}
.consequence{margin-top:10px;background:#241012;border:1px solid #5a2630;
color:#ffb4b4;border-radius:8px;padding:9px 11px;font-size:13px;font-weight:600}
.summary{margin-top:14px;padding-top:12px;border-top:1px solid var(--line);
font-size:13px;color:var(--ink)}
.ungoverned .summary{color:#ffc9c9}
.governed .summary{color:#bff3df}
.foot{margin-top:22px;text-align:center;color:var(--mut);font-size:13px}
.index{list-style:none;padding:0;display:grid;gap:10px;max-width:620px}
.index a{display:block;background:var(--panel);border:1px solid var(--line);
border-radius:11px;padding:14px 16px;color:var(--ink);text-decoration:none;font-weight:600}
.index a:hover{border-color:var(--cyan)}
.deck-scenario{margin-top:40px;padding-top:28px;border-top:1px solid var(--line)}
.deck-title{font-size:21px;margin:0 0 14px;letter-spacing:.01em}
@media(max-width:840px){.cols{grid-template-columns:1fr}}
`;
