/**
 * @strixgov/swarm-adapter/claude-agent-sdk — binding for the Claude Agent SDK.
 *
 * The Claude Agent SDK defines a tool as
 *   tool(name, description, inputSchema, handler)
 * where `handler(args) => Promise<{ content: [{ type:'text', text }] }>`.
 *
 * This binding produces that `handler` from the Strix adapter, so a tool call is
 * routed through the Strix boundary first: the registered server-side capability
 * handler runs only if governance passes; a blocked call comes back as a normal
 * tool result (isError) the model can SEE and reason about — the bad branch dies
 * without crashing the agent, and the side effect never ran.
 *
 * Deliberately imports NOTHING from `@anthropic-ai/claude-agent-sdk` — it only
 * emits the SDK's documented result shape. So the adapter package stays
 * dependency-light, and the integrator wires the handler into `tool(...)`:
 *
 *   import { tool, createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
 *   import { z } from 'zod';
 *   import { SwarmAdapter, HttpTransport } from '@strixgov/swarm-adapter';
 *   import { governedToolHandler, delegateWorkers } from '@strixgov/swarm-adapter/claude-agent-sdk';
 *
 *   const adapter = new SwarmAdapter({ transport: new HttpTransport({ base, tenantId, token }), tenantId, environment: 'prod' });
 *   await adapter.openRun({ rootAgentId: 'planner', rootDecisionId, capabilityCeiling: [...], budgetCeiling: 9 });
 *
 *   // HOOK 1 — declare each sub-agent's attenuated grant when you wire the swarm.
 *   await delegateWorkers(adapter, 'planner', [
 *     { to: 'summary', capabilities: ['deal.summarize', 'swarm.demo.writeDealSummary'], budget: 3 },
 *     { to: 'risky',   capabilities: ['crm.read'], budget: 1 },
 *   ]);
 *
 *   // HOOK 2 — wrap the tool the sub-agent calls. The handler is governed.
 *   const writeDealSummary = tool(
 *     'write_deal_summary', 'Write the deal summary note',
 *     { dealId: z.string() },
 *     governedToolHandler(adapter, 'summary', 'swarm.demo.writeDealSummary'),
 *   );
 *   const server = createSdkMcpServer({ name: 'strix-governed', tools: [writeDealSummary] });
 *
 *   // Restrict each Agent SDK sub-agent to its governed tools via options.agents.
 *   await query({ prompt, options: { mcpServers: { 'strix-governed': { type: 'sdk', name: 'strix-governed', instance: server } } } });
 */

import type { SwarmAdapter, DelegateSpec } from '../swarm-adapter.js';
import { governedTool, GovernedBlockError } from '../govern-tool.js';

/** The Claude Agent SDK tool-handler result shape (mirrored, not imported). */
export interface SdkCallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface GovernedToolHandlerOptions {
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  /** Map the executed result to the text the agent sees. Default: a compact JSON receipt. */
  renderResult?: (result: { evidenceId?: string; swarmActionId?: string }) => string;
  /** Map a governed block to the text the agent sees. Default: a clear refusal. */
  renderBlock?: (err: GovernedBlockError) => string;
}

/**
 * Produce a Claude Agent SDK tool handler that routes `capability` through Strix
 * on behalf of `agentId`. Returns the SDK's `{ content, isError? }` shape:
 *   - allowed  → content describes the executed governed action (receipt ids).
 *   - blocked  → isError:true + a refusal the model can reason about. The side
 *                effect never ran; no receipt was written.
 */
export function governedToolHandler(
  adapter: SwarmAdapter,
  agentId: string,
  capability: string,
  opts: GovernedToolHandlerOptions = {},
) {
  const call = governedTool(adapter, agentId, capability, { riskLevel: opts.riskLevel });
  const renderResult = opts.renderResult ?? ((r) => `Strix EXECUTED ${capability} (evidenceId=${r.evidenceId ?? '—'}). Verify: npx @strixgov/verifier swarm.`);
  const renderBlock = opts.renderBlock ?? ((e) => `Strix BLOCKED ${capability}: ${e.blockCode ?? 'BLOCKED'}${e.blockReason ? ` — ${e.blockReason}` : ''}. This agent was not delegated that authority; choose a different action.`);

  return async function handler(args: unknown): Promise<SdkCallToolResult> {
    try {
      const r = await call(args);
      return { content: [{ type: 'text', text: renderResult(r) }] };
    } catch (e) {
      if (e instanceof GovernedBlockError) {
        return { isError: true, content: [{ type: 'text', text: renderBlock(e) }] };
      }
      throw e; // a real transport/runtime error, not a governance refusal
    }
  };
}

export interface WorkerGrant extends Omit<DelegateSpec, 'from'> {}

/**
 * Declare each sub-agent's attenuated grant in one call (depth-1 fan-out). Wire
 * this when you set up the swarm, before the agents run — it signs + persists the
 * delegation edges the boundary will verify each tool call against.
 */
export async function delegateWorkers(
  adapter: SwarmAdapter,
  from: string,
  grants: WorkerGrant[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const g of grants) {
    ids.push(await adapter.delegate({ from, ...g }));
  }
  return ids;
}
