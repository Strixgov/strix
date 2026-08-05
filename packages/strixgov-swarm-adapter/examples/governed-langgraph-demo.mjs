/**
 * Governed LangGraph demo — "bring your LangGraph, Strix governs the tools."
 *
 *   node examples/governed-langgraph-demo.mjs            # local-simulated boundary, no server
 *
 * Shows the LangGraph binding (`@strixgov/swarm-adapter/langgraph`) wrapping the
 * tools two graph nodes call. A planner delegates an ATTENUATED grant to each
 * node; the binding routes every tool call through the Strix boundary first:
 *
 *   - `summary` node was delegated `swarm.demo.writeDealSummary` → the tool
 *     EXECUTES and the model sees a receipt line.
 *   - `risky`  node was delegated only `crm.read` → its attempt to call
 *     `swarm.demo.writeDealSummary` is BLOCKED. The model sees a normal,
 *     reasoned tool refusal (a string), the graph keeps running, and the side
 *     effect never ran.
 *
 * Like the swarm demo's `--dry-run`, only the execute *verdict* is simulated
 * here (a local attenuation check) so it runs with no server and no key. The
 * binding code, the delegate/governedTool seam, and the model-visible text are
 * exactly what runs against a real Strix boundary — swap the simulated adapter
 * for `new SwarmAdapter({ transport: new HttpTransport(...) })` and the same two
 * hooks produce real signed delegations + `npx @strixgov/verifier swarm <id>`.
 *
 * The point this makes for a LangGraph user: you do not rewrite your graph. You
 * wrap each tool's function with `governedToolFunc(...)` and declare hand-offs
 * with `delegateWorkers(...)`. Everything else — the model, the ToolNode, the
 * state machine — is unchanged.
 */

import { governedToolFunc, delegateWorkers } from '../dist/bindings/langgraph.js';

// ── A local, simulated Strix boundary (stands in for the real adapter) ───────
// Mirrors SwarmAdapter's surface: delegate() records an attenuated grant;
// act() ALLOWS only if the acting node was delegated the capability, else it
// returns a BLOCKED verdict exactly like the real boundary's amplification block.
function makeSimulatedAdapter() {
  const grants = new Map(); // agentId -> Set(capability)
  let evidenceSeq = 0;
  return {
    async delegate({ from, to, capabilities }) {
      grants.set(to, new Set(capabilities));
      return `edge-${from}->${to}`;
    },
    async act({ agent, capability }) {
      const granted = grants.get(agent);
      if (granted && granted.has(capability)) {
        return { status: 'EXECUTED', evidenceId: `evi-${++evidenceSeq}`, swarmActionId: `act-${evidenceSeq}` };
      }
      return {
        status: 'BLOCKED',
        blockCode: 'SWARM_AMPLIFICATION',
        blockReason: `${agent} was not delegated ${capability}`,
      };
    },
  };
}

async function main() {
  const adapter = makeSimulatedAdapter();

  // HOOK 1 — the planner hands work to two nodes with attenuated grants.
  // (In a real graph this maps to the edges that route to each node.)
  await delegateWorkers(adapter, 'planner', [
    { to: 'summary', capabilities: ['deal.summarize', 'swarm.demo.writeDealSummary'], budget: 3 },
    { to: 'risky', capabilities: ['crm.read'], budget: 1 },
  ]);

  // HOOK 2 — wrap the tool each node calls. In LangGraph:
  //   const writeDealSummary = tool(governedToolFunc(adapter, 'summary', 'swarm.demo.writeDealSummary'),
  //     { name: 'write_deal_summary', description: '...', schema: z.object({ dealId: z.string() }) });
  const summaryWrite = governedToolFunc(adapter, 'summary', 'swarm.demo.writeDealSummary');
  const riskyWrite = governedToolFunc(adapter, 'risky', 'swarm.demo.writeDealSummary');

  console.log('— LangGraph governed-tool demo (simulated boundary) —\n');

  // The `summary` node's tool call — allowed.
  const okText = await summaryWrite({ dealId: '17' });
  console.log('[node: summary] tool → write_deal_summary({ dealId: "17" })');
  console.log('  model sees:', okText, '\n');

  // The `risky` node's tool call — blocked. The graph does NOT crash; the model
  // gets a reasoned refusal string and can choose a different action.
  const blockedText = await riskyWrite({ dealId: '17' });
  console.log('[node: risky]   tool → write_deal_summary({ dealId: "17" })');
  console.log('  model sees:', blockedText, '\n');

  const pass =
    typeof okText === 'string' && /EXECUTED/.test(okText) &&
    typeof blockedText === 'string' && /BLOCKED/.test(blockedText) && /SWARM_AMPLIFICATION/.test(blockedText);

  console.log(pass
    ? '✓ Allowed node executed; un-delegated node was blocked WITHOUT crashing the graph.\n  Swap the simulated adapter for HttpTransport to get real signed delegations + offline verify.'
    : '✗ Demo invariant failed.');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
