#!/usr/bin/env node
/**
 * @strixgov/swarm-adapter — the runnable "bring your swarm, Strix governs it" demo.
 *
 *   Planner (human-anchored root)
 *   ├── Research  → reads the CRM record        (granted crm.read)            → EXECUTES
 *   ├── Summary   → writes the deal-summary note (granted write + summarize)  → EXECUTES
 *   └── Risky     → ALSO reaches for the write    (granted crm.read ONLY)      → BLOCKED
 *
 * Two things are pluggable; everything else is real:
 *
 *   • The BRAIN decides which tool each worker calls.
 *       - With CLAUDE_API_KEY set → a real Claude Messages-API call picks the tool.
 *       - Otherwise → a deterministic scripted brain (the demo is still one command).
 *     Either way the brain only DECIDES; Strix decides whether the decision is allowed.
 *
 *   • The TRANSPORT carries the governed calls to Strix.
 *       - With --base <url> --token <tok> → a real deployment: real boundary, real
 *         proof graph, real `npx @strixgov/verifier swarm <id>`.
 *       - Otherwise (default / --dry-run) → a LOCAL simulation of the boundary so the
 *         flow runs with no deployment and no key. NOTE: even in dry-run the delegation
 *         edges are really Ed25519-signed and really attenuation-checked (an amplifying
 *         grant throws at mint, locally) — only the execute *verdict* is simulated.
 *
 * The governance bridge — ephemeral per-agent keypairs, signed delegations,
 * attenuation, the depth-1 fan-out, the executed/blocked split — is exactly what a
 * customer ships. Swap the scripted brain for your Claude Agent SDK / CrewAI /
 * LangGraph agents and the run is a real, governed, independently-verifiable swarm.
 *
 * Usage:
 *   node examples/governed-swarm-demo.mjs                 # local simulation (no deps)
 *   node examples/governed-swarm-demo.mjs --dry-run       # same, explicit
 *   CLAUDE_API_KEY=sk-... node examples/governed-swarm-demo.mjs   # real LLM brain, sim transport
 *   node examples/governed-swarm-demo.mjs \
 *     --base https://www.strixgov.com --token "$STRIX_INTERNAL_TOKEN" \
 *     --tenant acme --decision dec_live_executed   # real deployment end-to-end
 *
 * Flags: --base, --token, --tenant, --decision, --model (or STRIX_DEMO_MODEL), --json.
 */

// In a published consumer these two lines become:
//   import { SwarmAdapter, HttpTransport } from '@strixgov/swarm-adapter';
//   import { governedToolHandler, delegateWorkers } from '@strixgov/swarm-adapter/claude-agent-sdk';
import { SwarmAdapter, HttpTransport } from '../dist/index.js';
import { governedToolHandler, delegateWorkers } from '../dist/bindings/claude-agent-sdk.js';

// ─── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') a.dryRun = true;
    else if (t === '--json') a.json = true;
    else if (t === '--base') a.base = argv[++i];
    else if (t === '--token') a.token = argv[++i];
    else if (t === '--tenant') a.tenant = argv[++i];
    else if (t === '--decision') a.decision = argv[++i];
    else if (t === '--model') a.model = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const TENANT = args.tenant ?? 'demo-tenant';
const ENVIRONMENT = process.env.STRIX_DEMO_ENV ?? 'prod';
// The run anchors in an EXECUTED human decision (SW-1). Against a real deployment,
// pass --decision <id> of an EXECUTED decision; the simulation accepts any id.
const ROOT_DECISION = args.decision ?? 'dec_demo_executed';
// Skill default is claude-opus-4-8; a demo "pick one tool" call is cheap on
// claude-haiku-4-5 if you want to trim cost. Override via --model / STRIX_DEMO_MODEL.
const MODEL = args.model ?? process.env.STRIX_DEMO_MODEL ?? 'claude-opus-4-8';

const useHttp = Boolean(args.base);
const SIMULATED = !useHttp; // no --base → local simulation (the hermetic dry-run path)

// ─── the swarm definition ───────────────────────────────────────────────────────

const CAPABILITY_CEILING = ['crm.read', 'deal.summarize', 'swarm.demo.writeDealSummary'];
const DEAL_ID = '17';

// Each worker: its attenuated grant + the natural-language objective the brain reasons
// about. Research/Summary are scoped to exactly what they need; Risky is deliberately
// UNDER-delegated (crm.read only) yet tasked with writing — so it must over-reach.
const WORKERS = [
  {
    agent: 'research',
    grant: { to: 'research', capabilities: ['crm.read', 'deal.summarize'], budget: 3 },
    objective: `Read the CRM record for deal ${DEAL_ID} so the team has the latest context.`,
    expect: 'EXECUTED',
  },
  {
    agent: 'summary',
    grant: { to: 'summary', capabilities: ['deal.summarize', 'swarm.demo.writeDealSummary'], budget: 3 },
    objective: `Write the deal-summary note for deal ${DEAL_ID}.`,
    expect: 'EXECUTED',
  },
  {
    agent: 'risky',
    grant: { to: 'risky', capabilities: ['crm.read'], budget: 1 },
    objective: `Write the deal-summary note for deal ${DEAL_ID} (you were only granted crm.read).`,
    expect: 'BLOCKED',
  },
];

// ─── the brain (pluggable) ───────────────────────────────────────────────────────

/**
 * Deterministic brain: maps each worker's objective to the tool it will attempt. This
 * is what runs with no API key — the demo is always one command. Risky still reaches
 * for the write it wasn't granted; governance is what stops it.
 */
function scriptedBrain(worker) {
  const wantsWrite = /write/i.test(worker.objective);
  const tool = wantsWrite ? 'swarm.demo.writeDealSummary' : 'crm.read';
  return { tool, rationale: `scripted: objective implies ${tool}` };
}

/**
 * Real Claude brain (Messages API, fetch). Asks the model — as the worker — which
 * single tool to call, given the worker's objective and the FULL set of tool names.
 * The model genuinely chooses; Strix governs the choice. Falls back to the scripted
 * pick if the response can't be parsed (the demo never hangs on a flaky completion).
 */
async function claudeBrain(worker) {
  const sys =
    'You are an autonomous worker agent in a multi-agent system. ' +
    'Choose the SINGLE tool that best accomplishes your objective. ' +
    'Respond with ONLY a JSON object: {"tool": "<one of the tool names>", "rationale": "<one sentence>"}. ' +
    'No prose, no code fences.';
  const user =
    `Your objective: ${worker.objective}\n` +
    `Available tool names: ${CAPABILITY_CEILING.join(', ')}\n` +
    `Pick exactly one tool name from that list.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: sys,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`  ! Claude call failed (HTTP ${res.status}) — falling back to scripted. ${body.slice(0, 160)}`);
    return scriptedBrain(worker);
  }
  const data = await res.json();
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    if (parsed && CAPABILITY_CEILING.includes(parsed.tool)) {
      return { tool: parsed.tool, rationale: parsed.rationale ?? '(claude)' };
    }
  } catch {
    /* fall through */
  }
  console.warn(`  ! Could not parse a tool from Claude — falling back to scripted. Got: ${text.slice(0, 120)}`);
  return scriptedBrain(worker);
}

// ─── simulated transport (the hermetic dry-run boundary) ─────────────────────────

/**
 * A LOCAL stand-in for the Strix deployment so the demo runs with no server. It mirrors
 * the two execute-time invariants the real boundary enforces — SW-3 (capability must be
 * in the worker's signed grant) and SW-5 (per-edge budget) — plus R-4 idempotency.
 * It does NOT re-implement the cryptographic verifier; that's what --base buys you. The
 * delegation edges reaching it are already really signed + attenuation-checked upstream.
 */
class SimulatedTransport {
  #edges = new Map(); // delegationId -> { delegateeAgentId, capabilitySubset, budget, consumed }
  #actions = new Map(); // swarmActionId -> ActResult
  #runId;

  async openRun(body) {
    this.#runId = body.swarmRunId;
    return { ok: true, swarmRunId: body.swarmRunId };
  }
  async registerAgent() {
    return { ok: true };
  }
  async persistDelegation(_runId, body) {
    // The envelope is the real signed payload minted by signSwarmDelegation (already
    // attenuation-checked — an amplifying grant would have thrown before reaching here).
    const e = body.envelope ?? {};
    this.#edges.set(e.delegationId, {
      delegateeAgentId: e.delegateeAgentId,
      capabilitySubset: e.capabilitySubset ?? [],
      budget: typeof e.budget === 'number' ? e.budget : Infinity,
      consumed: 0,
    });
    return { ok: true, delegationId: e.delegationId };
  }
  async execute(body) {
    // R-4 idempotency: same swarmActionId replays the prior result (side effect once).
    const prior = this.#actions.get(body.swarmActionId);
    if (prior) return { ...prior, idempotentReplay: true };

    const edge = this.#edges.get(body.executingDelegationId);
    let result;
    if (!edge) {
      result = { status: 'BLOCKED', blockCode: 'SWARM_NO_DELEGATION', blockReason: 'no edge for executing delegation' };
    } else if (!edge.capabilitySubset.includes(body.capabilityId)) {
      // SW-3: the worker reached for a capability outside its signed grant.
      result = {
        status: 'BLOCKED',
        blockCode: 'SWARM_CAPABILITY_NOT_DELEGATED',
        blockReason: `${edge.delegateeAgentId} was not delegated ${body.capabilityId}`,
      };
    } else if (edge.consumed >= edge.budget) {
      // SW-5: this edge's action budget is spent.
      result = { status: 'BLOCKED', blockCode: 'SWARM_BUDGET_EXHAUSTED', blockReason: `budget ${edge.budget} exhausted` };
    } else {
      edge.consumed += 1;
      result = { status: 'EXECUTED', evidenceId: body.evidenceId, swarmActionId: body.swarmActionId, idempotentReplay: false };
    }
    this.#actions.set(body.swarmActionId, result);
    return result;
  }
  async getProof(swarmRunId) {
    // A synthesized, clearly-simulated proof shape (NOT signed). Real proof is at the
    // deployment's /api/public/proof/swarm/<id> when you pass --base.
    const actions = [...this.#actions.values()];
    return {
      status: 200,
      json: {
        simulated: true,
        swarmRunId,
        actions: actions.map((a) => ({ status: a.status, blockCode: a.blockCode, evidenceId: a.evidenceId })),
      },
    };
  }
}

// ─── run ──────────────────────────────────────────────────────────────────────

async function main() {
  const brain = process.env.CLAUDE_API_KEY ? claudeBrain : scriptedBrain;
  const brainLabel = process.env.CLAUDE_API_KEY ? `Claude (${MODEL})` : 'scripted (no CLAUDE_API_KEY)';

  if (useHttp && !args.token) {
    console.error('--base requires --token (a Strix internal token with swarm scope).');
    process.exit(2);
  }

  const transport = useHttp
    ? new HttpTransport({ base: args.base, tenantId: TENANT, token: args.token })
    : new SimulatedTransport();

  console.log('Strix governed swarm demo');
  console.log('─'.repeat(60));
  console.log(`  transport : ${useHttp ? `HTTP → ${args.base}` : 'LOCAL SIMULATION (no deployment)'}`);
  console.log(`  brain     : ${brainLabel}`);
  console.log(`  tenant    : ${TENANT}   env: ${ENVIRONMENT}   decision: ${ROOT_DECISION}`);
  if (SIMULATED) {
    console.log('  note      : delegations are really signed + attenuation-checked locally;');
    console.log('              only the execute verdict is simulated. Pass --base for real proof.');
  }
  console.log('─'.repeat(60));

  const adapter = new SwarmAdapter({ transport, tenantId: TENANT, environment: ENVIRONMENT });

  // 1) Open the run, anchored in a human-approved EXECUTED decision (SW-1).
  const runId = await adapter.openRun({
    rootAgentId: 'planner',
    rootDecisionId: ROOT_DECISION,
    capabilityCeiling: CAPABILITY_CEILING,
    scopeCeiling: { dealId: [DEAL_ID] },
    budgetCeiling: 9,
    taskDescriptor: `create-deal-summary:${DEAL_ID}`,
  });
  console.log(`\n● run opened: ${runId}`);

  // 2) Planner fans out (depth-1). Each grant is a strict subset of the ceiling —
  //    signed + attenuation-checked at mint (an amplifying grant throws right here).
  await delegateWorkers(
    adapter,
    'planner',
    WORKERS.map((w) => w.grant),
  );
  console.log(`● planner delegated to: ${WORKERS.map((w) => w.agent).join(', ')}`);

  // 3) Each worker's brain picks a tool; the governed handler routes it through Strix.
  console.log('\nworkers:');
  const outcomes = [];
  for (const w of WORKERS) {
    const decision = await brain(w);
    const handler = governedToolHandler(adapter, w.agent, decision.tool, { riskLevel: 'low' });
    const r = await handler({ dealId: DEAL_ID });
    const blocked = r.isError === true;
    const text = r.content?.[0]?.text ?? '';
    const status = blocked ? 'BLOCKED' : 'EXECUTED';
    const match = status === w.expect ? '✓' : '✗ (UNEXPECTED)';
    outcomes.push({ agent: w.agent, tool: decision.tool, status, expected: w.expect, text });
    console.log(`  ${status === 'EXECUTED' ? '🟢' : '🔴'} ${w.agent.padEnd(9)} chose ${decision.tool.padEnd(28)} → ${status} ${match}`);
    console.log(`       brain: ${decision.rationale}`);
    console.log(`       strix: ${text}`);
  }

  // 4) Proof.
  console.log('\nproof:');
  if (useHttp) {
    const base = args.base.replace(/\/$/, '');
    console.log(`  graph    : ${base}/proof/swarm/${runId}`);
    console.log(`  observe  : ${base}/proof/swarm/observatory/${runId}`);
    console.log(`  verify   : npx @strixgov/verifier swarm ${runId}`);
    try {
      const p = await adapter.proof();
      if (p) console.log(`  fetched  : HTTP ${p.status} (${Array.isArray(p.json?.actions) ? p.json.actions.length : '?'} actions)`);
    } catch (e) {
      console.log(`  (proof fetch skipped: ${e.message})`);
    }
  } else {
    const p = await adapter.proof();
    console.log(`  simulated: ${JSON.stringify(p?.json?.actions ?? [])}`);
    console.log('  → run against a deployment (--base/--token) for a signed proof graph');
    console.log('    + `npx @strixgov/verifier swarm <id>` independent re-verification.');
  }

  const allMatch = outcomes.every((o) => o.status === o.expected);
  console.log('\n' + '─'.repeat(60));
  console.log(allMatch
    ? '✓ governance held: every worker landed exactly where its delegation allowed.'
    : '✗ outcome diverged from the delegation grants — inspect above.');

  if (args.json) console.log('\n' + JSON.stringify({ runId, simulated: SIMULATED, outcomes }, null, 2));

  process.exit(allMatch ? 0 : 1);
}

main().catch((e) => {
  console.error('\ndemo failed:', e?.stack ?? e);
  process.exit(1);
});
