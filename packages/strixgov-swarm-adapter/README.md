# @strixgov/swarm-adapter

**Bring your swarm. Strix governs it.**

A framework-neutral bridge that turns a real multi-agent run — Claude Agent SDK,
CrewAI, LangGraph, OpenAI Swarm, or your own runtime — into **signed delegations →
governed tool calls → independently-verifiable proof**, without Strix becoming an
agent framework.

```
your agent framework
   ↓   your agents decide WHAT to delegate / WHICH tool to call
SwarmAdapter            (this package — owns the governance bridge only)
   ↓
signed delegation edge  (delegator signs with its OWN key)
   ↓
Strix governed execution route
   ↓
tool / side effect      (runs ONLY if governance passed)
   ↓
proof graph + npx @strixgov/verifier swarm <id>
```

The adapter **decides nothing** — your agents make every decision; the adapter
makes those decisions governed and provable.

## Install

```
npm install @strixgov/swarm-adapter @strixgov/sdk
```

## Try it (one command, no deployment)

```
node examples/governed-swarm-demo.mjs --dry-run
```

Runs the canonical Planner → Research / Summary / Risky swarm. Research and Summary
execute; Risky reaches for a write it was never delegated and is **blocked**. The
delegation edges are really Ed25519-signed and attenuation-checked locally — only the
execute *verdict* is simulated, so it runs with no server and no key.

- **Real LLM brain:** `CLAUDE_API_KEY=sk-... node examples/governed-swarm-demo.mjs`
  — Claude picks each worker's tool; Strix still governs the choice.
- **Real deployment, end-to-end proof:**
  `node examples/governed-swarm-demo.mjs --base https://www.strixgov.com --token "$STRIX_INTERNAL_TOKEN" --tenant acme --decision <executed-decision-id>`
  — real boundary, real proof graph, real `npx @strixgov/verifier swarm <id>`.

## Two integration hooks

```ts
import { SwarmAdapter, HttpTransport, governedTool, GovernedBlockError } from '@strixgov/swarm-adapter';

const adapter = new SwarmAdapter({
  transport: new HttpTransport({ base: 'https://www.strixgov.com', tenantId, token }),
  tenantId,
  environment: 'prod',
});

// Open a run, anchored in an EXECUTED Strix decision.
await adapter.openRun({
  rootAgentId: 'planner',
  rootDecisionId: '<EXECUTED decision id>',
  capabilityCeiling: ['crm.read', 'deal.summarize', 'swarm.demo.writeDealSummary'],
  scopeCeiling: { dealId: ['17'] },
  budgetCeiling: 9,
});

// HOOK 1 — when one agent hands work to another, declare the (attenuated) grant.
await adapter.delegate({ from: 'planner', to: 'summary', capabilities: ['deal.summarize', 'swarm.demo.writeDealSummary'], budget: 3 });
await adapter.delegate({ from: 'planner', to: 'risky',   capabilities: ['crm.read'], budget: 1 });

// HOOK 2 — wrap each framework tool so the call is governed.
const writeDealSummary = governedTool(adapter, 'summary', 'swarm.demo.writeDealSummary');
await writeDealSummary({ dealId: '17' }); // EXECUTED → server-side handler ran

const risky = governedTool(adapter, 'risky', 'swarm.demo.writeDealSummary');
try { await risky({ dealId: '17' }); }
catch (e) { if (e instanceof GovernedBlockError) { /* the agent sees a normal tool refusal */ } }
```

Then view `https://<host>/proof/swarm/<id>/graph` and verify offline:
`npx @strixgov/verifier swarm <id>`.

## LangGraph

The same two hooks, expressed in LangGraph / LangChain.js terms. You do **not**
rewrite your graph — you wrap each tool's function and declare hand-offs.

```ts
import { tool } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { SwarmAdapter, HttpTransport } from '@strixgov/swarm-adapter';
import { governedToolFunc, delegateWorkers } from '@strixgov/swarm-adapter/langgraph';

const adapter = new SwarmAdapter({ transport: new HttpTransport({ base, tenantId, token }), tenantId, environment: 'prod' });
await adapter.openRun({ rootAgentId: 'planner', rootDecisionId, capabilityCeiling: [...], budgetCeiling: 9 });

// HOOK 1 — declare each node's attenuated grant (map a graph hand-off → one grant).
await delegateWorkers(adapter, 'planner', [
  { to: 'summary', capabilities: ['deal.summarize', 'swarm.demo.writeDealSummary'], budget: 3 },
  { to: 'risky',   capabilities: ['crm.read'], budget: 1 },
]);

// HOOK 2 — the tool function is governed. Allowed → executes; blocked → the model
// gets a reasoned refusal string (the graph keeps running; the side effect never ran).
const writeDealSummary = tool(
  governedToolFunc(adapter, 'summary', 'swarm.demo.writeDealSummary'),
  { name: 'write_deal_summary', description: 'Write the deal summary note', schema: z.object({ dealId: z.string() }) },
);
const toolNode = new ToolNode([writeDealSummary]);
```

`governedToolFunc` returns a string by default (the most portable LangChain tool
return); pass `{ contentMode: 'content' }` for the `[{ type:'text', text }]`
content-array shape. A governance block is returned as a string the model can
reason about; only a real transport/runtime error throws.

**Try it (one command, no server, no LangGraph install):**

```
node examples/governed-langgraph-demo.mjs
```

Runs a planner → `summary` / `risky` graph through the binding: the delegated
`summary` node's tool executes; the `risky` node's un-delegated write is blocked
with a real `SWARM_AMPLIFICATION` reason and the graph does not crash. Only the
execute *verdict* is simulated locally — the binding, the two hooks, and the
model-visible text are exactly what runs against a real Strix boundary.

## v0.1 scope

- **Depth-1 delegation** (one root/planner agent → workers). Multi-hop re-delegation
  is v0.2 (the chain verifier already supports arbitrary depth).
- **Ephemeral run-scoped keys** by default; inject AA-1-attested identities via
  `setAgentKey(agentId, privateKey, publicKey, kid)`.
- Transports: `HttpTransport` (this package). An in-process transport (calling the
  Strix boundary directly) ships inside the Strix Console for embedding/tests.

## License

MIT — Strix's verification + integration primitives are open by design. The
protected runtime/control core is separate. See `LICENSING_BOUNDARY.md`.
