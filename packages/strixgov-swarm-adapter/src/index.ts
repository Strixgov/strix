/**
 * @strixgov/swarm-adapter — the "bring your swarm, Strix governs it" bridge.
 *
 * A framework-neutral library that turns a real multi-agent run (Claude Agent SDK
 * / CrewAI / LangGraph / OpenAI Swarm) into signed delegations + governed tool
 * calls + independently-verifiable proof. Dependency-light: only @strixgov/sdk
 * (swarm signers/verifier) + fetch.
 *
 * Two integration hooks — that's the whole surface:
 *   1. hand-off  → adapter.delegate({ from, to, capabilities, budget })
 *   2. tool call → governedTool(adapter, agentId, capability)
 *
 * Contract: docs/architecture/swarm-adapter-v0.1.md (in the Strix monorepo).
 */

export { SwarmAdapter } from './swarm-adapter.js';
export type { OpenRunSpec, DelegateSpec, ActSpec } from './swarm-adapter.js';
export { governedTool, GovernedBlockError } from './govern-tool.js';
export type { GovernedToolResult } from './govern-tool.js';
export { HttpTransport } from './transport.js';
export type {
  SwarmTransport,
  ActResult,
  OpenRunBody,
  RegisterAgentBody,
  PersistDelegationBody,
  ExecuteBody,
} from './transport.js';
