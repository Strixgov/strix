/**
 * @strixgov/swarm-adapter/langgraph — binding for LangGraph / LangChain.js.
 *
 * LangGraph executes tools through LangChain's tool abstraction: a tool is a
 * function `(input) => Promise<string | content>` created with
 * `tool(func, { name, description, schema })` from `@langchain/core/tools`, and a
 * `ToolNode` (or the prebuilt ReAct agent) dispatches the model's tool calls to
 * those functions. Whatever the function returns becomes the `ToolMessage`
 * content the model reads on its next turn.
 *
 * This binding produces that `func` from the Strix adapter, so a tool call is
 * routed through the Strix boundary first: the registered server-side capability
 * handler runs ONLY if governance passes. A blocked call comes back as a normal
 * tool string the model can SEE and reason about (the bad branch dies without
 * crashing the graph), and the side effect never ran — no receipt was written.
 *
 * Deliberately imports NOTHING from `@langchain/core` or `@langchain/langgraph`
 * — it only emits the documented return shape (a string, or LangChain message
 * content). So the adapter package stays dependency-light and the integrator
 * wires the function into `tool(...)`:
 *
 *   import { tool } from '@langchain/core/tools';
 *   import { ToolNode } from '@langchain/langgraph/prebuilt';
 *   import { z } from 'zod';
 *   import { SwarmAdapter, HttpTransport } from '@strixgov/swarm-adapter';
 *   import { governedToolFunc, delegateWorkers } from '@strixgov/swarm-adapter/langgraph';
 *
 *   const adapter = new SwarmAdapter({ transport: new HttpTransport({ base, tenantId, token }), tenantId, environment: 'prod' });
 *   await adapter.openRun({ rootAgentId: 'planner', rootDecisionId, capabilityCeiling: [...], budgetCeiling: 9 });
 *
 *   // HOOK 1 — declare each node's attenuated grant when you wire the graph.
 *   await delegateWorkers(adapter, 'planner', [
 *     { to: 'summary', capabilities: ['deal.summarize', 'swarm.demo.writeDealSummary'], budget: 3 },
 *     { to: 'risky',   capabilities: ['crm.read'], budget: 1 },
 *   ]);
 *
 *   // HOOK 2 — wrap the tool a node calls. The function is governed.
 *   const writeDealSummary = tool(
 *     governedToolFunc(adapter, 'summary', 'swarm.demo.writeDealSummary'),
 *     { name: 'write_deal_summary', description: 'Write the deal summary note', schema: z.object({ dealId: z.string() }) },
 *   );
 *   const toolNode = new ToolNode([writeDealSummary]);
 *
 * The function returns a STRING by default (LangChain's most portable tool
 * return). Set `contentMode: 'content'` to return the
 * `[{ type: 'text', text }]` content-array shape some LangChain versions accept.
 */

import type { SwarmAdapter, DelegateSpec } from '../swarm-adapter.js';
import { governedTool, GovernedBlockError } from '../govern-tool.js';

/** LangChain content-array shape, when `contentMode: 'content'` is selected. */
export type LangChainToolContent = Array<{ type: 'text'; text: string }>;

export interface GovernedToolFuncOptions {
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  /**
   * `'string'` (default) — return the model-visible text directly (the most
   * portable LangChain tool return). `'content'` — return the
   * `[{ type:'text', text }]` content-array shape.
   */
  contentMode?: 'string' | 'content';
  /** Map the executed result to the text the model sees. Default: a compact receipt line. */
  renderResult?: (result: { evidenceId?: string; swarmActionId?: string }) => string;
  /** Map a governed block to the text the model sees. Default: a clear, reasoned refusal. */
  renderBlock?: (err: GovernedBlockError) => string;
}

function wrap(text: string, mode: 'string' | 'content'): string | LangChainToolContent {
  return mode === 'content' ? [{ type: 'text', text }] : text;
}

/**
 * Produce a LangGraph / LangChain tool function that routes `capability` through
 * Strix on behalf of `agentId`. Returns an async `(input) => string | content`:
 *   - allowed → text describing the executed governed action (receipt ids).
 *   - blocked → text refusal the model can reason about. The side effect never
 *               ran; no receipt was written. (Does NOT throw — a thrown error in
 *               a LangChain tool surfaces as an opaque graph failure; a returned
 *               string keeps the bad branch legible to the model, which is the
 *               whole point of the governed-tool seam.)
 *
 * A genuine transport/runtime error (not a governance block) is re-thrown so the
 * graph's normal error handling sees it — a network failure is not a refusal.
 */
export function governedToolFunc(
  adapter: Pick<SwarmAdapter, 'act'>,
  agentId: string,
  capability: string,
  opts: GovernedToolFuncOptions = {},
) {
  const call = governedTool(adapter as SwarmAdapter, agentId, capability, { riskLevel: opts.riskLevel });
  const mode = opts.contentMode ?? 'string';
  const renderResult =
    opts.renderResult ??
    ((r) => `Strix EXECUTED ${capability} (evidenceId=${r.evidenceId ?? '—'}). Verify: npx @strixgov/verifier swarm.`);
  const renderBlock =
    opts.renderBlock ??
    ((e) =>
      `Strix BLOCKED ${capability}: ${e.blockCode ?? 'BLOCKED'}${e.blockReason ? ` — ${e.blockReason}` : ''}. ` +
      `This node was not delegated that authority; the action did not run. Choose a different action.`);

  return async function governedLangGraphTool(input: unknown): Promise<string | LangChainToolContent> {
    try {
      const r = await call(input);
      return wrap(renderResult(r), mode);
    } catch (e) {
      if (e instanceof GovernedBlockError) {
        return wrap(renderBlock(e), mode);
      }
      throw e; // a real transport/runtime error, not a governance refusal
    }
  };
}

export interface WorkerGrant extends Omit<DelegateSpec, 'from'> {}

/**
 * Declare each node's attenuated grant in one call (depth-1 fan-out). Wire this
 * when you build the graph, before it runs — it signs + persists the delegation
 * edges the boundary will verify each tool call against. Map a LangGraph task
 * hand-off (one node spawning/routing to another) onto one grant.
 */
export async function delegateWorkers(
  adapter: Pick<SwarmAdapter, 'delegate'>,
  from: string,
  grants: WorkerGrant[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const g of grants) {
    ids.push(await adapter.delegate({ from, ...g }));
  }
  return ids;
}
