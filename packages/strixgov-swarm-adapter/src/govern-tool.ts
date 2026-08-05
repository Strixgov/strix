/**
 * Strix Swarm Adapter v0.1 — the tool hook (the binding primitive).
 *
 * Every agent framework expresses a "tool" as a function the agent can call.
 * `governedTool` wraps any such function so the call is routed through the Strix
 * boundary first: the registered server-side handler runs ONLY if governance
 * passes; a blocked call throws `GovernedBlockError` so the agent's own reasoning
 * (and the framework) sees the refusal as a normal tool error.
 *
 * This is the entire integration surface for tools — wrap your framework's tool
 * executors with this, declare hand-offs with `adapter.delegate(...)`, and a real
 * multi-agent run becomes signed + governed + verifiable. The actual tool *work*
 * lives server-side as the registered capability handler (e.g.
 * `swarm.demo.writeDealSummary`), so the wrapped tool is a governed proxy.
 *
 * Framework wiring (all the same two hooks):
 *   Claude Agent SDK — register `governedTool(adapter, agentId, cap)` as a tool's
 *     handler; on sub-agent hand-off call `adapter.delegate({from,to,capabilities,budget})`.
 *   CrewAI / LangGraph — wrap the tool node executor; map task hand-off → delegate.
 */

import type { SwarmAdapter, ActSpec } from './swarm-adapter.js';
import type { ActResult } from './transport.js';

export class GovernedBlockError extends Error {
  readonly blockCode?: string;
  readonly blockReason?: string;
  readonly capability: string;
  readonly agentId: string;
  constructor(agentId: string, capability: string, result: ActResult) {
    super(`Strix blocked ${agentId} → ${capability}: ${result.blockCode ?? 'BLOCKED'}${result.blockReason ? ` (${result.blockReason})` : ''}`);
    this.name = 'GovernedBlockError';
    this.blockCode = result.blockCode;
    this.blockReason = result.blockReason;
    this.capability = capability;
    this.agentId = agentId;
  }
}

export interface GovernedToolResult {
  status: 'EXECUTED';
  evidenceId?: string;
  swarmActionId?: string;
}

/**
 * Wrap a capability as a governed tool callable by `agentId`. Returns an async
 * function `(input) => GovernedToolResult` suitable for registering as a tool
 * executor in any framework. Throws `GovernedBlockError` when the boundary blocks.
 */
export function governedTool(
  adapter: SwarmAdapter,
  agentId: string,
  capability: string,
  opts: Pick<ActSpec, 'riskLevel'> = {},
) {
  return async function governedToolCall(input: unknown): Promise<GovernedToolResult> {
    const result = await adapter.act({ agent: agentId, capability, input, riskLevel: opts.riskLevel });
    if (result.status !== 'EXECUTED') {
      throw new GovernedBlockError(agentId, capability, result);
    }
    return { status: 'EXECUTED', evidenceId: result.evidenceId, swarmActionId: result.swarmActionId };
  };
}
