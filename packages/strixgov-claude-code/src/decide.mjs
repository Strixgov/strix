/**
 * @strixgov/claude-code — the governance decision for a Claude Code tool call.
 *
 * Claude Code exposes a PreToolUse hook: before any built-in tool (Bash, Edit,
 * Write, …) runs, a hook command receives the tool name + input on stdin and may
 * allow / ask / deny the call. This module turns that into a Strix decision:
 * classify the tool via the @strixgov/capabilities-claude-code pack, evaluate it
 * against a policy with the SAME PolicyEngine the tool-gateway uses (fail-closed,
 * content-addressable version), and map the verdict onto Claude Code's
 * permission vocabulary.
 *
 * Honesty (claim discipline):
 *   - This governs Claude Code's BUILT-IN tools — the surface PreToolUse can
 *     intercept. External MCP servers Claude Code connects to are governed
 *     separately by @strixgov/mcp-proxy (a different, also-real interception
 *     point). `init` wires both.
 *   - A DENY/ASK decision is enforced by Claude Code refusing/holding the tool
 *     BEFORE it runs — the side effect does not happen. The receipt records the
 *     DECISION; it does not assert the tool's post-hoc result.
 *   - Unknown tools fail closed (DENY) — the PolicyEngine returns DENY for any
 *     capability not in the pack, and `default: "DENY"` covers unruled known
 *     capabilities.
 */

import { PolicyEngine } from '@strixgov/tool-gateway';
import {
  claudeCodeCapabilities,
  claudeCodeCapabilityMap,
  suggestedPolicy,
} from '@strixgov/capabilities-claude-code';

/** Claude Code tool name (e.g. "Bash") → pack capability id (e.g. "claude.bash"). */
export const TOOL_NAME_TO_CAPABILITY = Object.freeze(
  Object.fromEntries(claudeCodeCapabilities.map((c) => [c.name, c.id])),
);

/** Strix decision → Claude Code PreToolUse permissionDecision. */
export function toPermissionDecision(strixDecision) {
  switch (strixDecision) {
    case 'ALLOW':
      return 'allow';
    case 'APPROVAL_REQUIRED':
      return 'ask'; // Claude Code prompts the human — the approval gate.
    case 'DENY':
    default:
      return 'deny'; // fail-closed: anything unexpected denies.
  }
}

/**
 * Build the PolicyEngine for Claude Code's built-in tools.
 * @param {{ rules?: Record<string,'ALLOW'|'DENY'|'APPROVAL_REQUIRED'>, default?: 'ALLOW'|'DENY'|'APPROVAL_REQUIRED' }} [policyOverride]
 *   Merged over the pack's `suggestedPolicy()`. Operators tighten here
 *   (e.g. `{ rules: { 'claude.bash': 'DENY' } }`).
 */
export function buildEngine(policyOverride = {}) {
  const base = suggestedPolicy();
  const ruleset = {
    rules: { ...base.rules, ...(policyOverride.rules ?? {}) },
    default: policyOverride.default ?? base.default,
  };
  return new PolicyEngine(ruleset, claudeCodeCapabilityMap());
}

/**
 * Decide a single Claude Code tool use.
 *
 * @param {{ toolName: string, toolInput?: unknown }} call
 * @param {PolicyEngine} [engine] — reuse one across calls; built on demand if omitted.
 * @returns {{
 *   capabilityId: string,
 *   strixDecision: 'ALLOW'|'DENY'|'APPROVAL_REQUIRED',
 *   permissionDecision: 'allow'|'ask'|'deny',
 *   risk: string,
 *   reason: string,
 *   matchedRule?: string,
 *   invocation: { capabilityId: string, action: string, args: unknown },
 * }}
 */
export function decideToolUse(call, engine = buildEngine()) {
  const toolName = call?.toolName;
  // Unknown / unclassified tool → a capability id that the engine will DENY
  // (UNKNOWN_CAPABILITY). We never invent an ALLOW for a tool we can't classify.
  const capabilityId = TOOL_NAME_TO_CAPABILITY[toolName] ?? `claude.unknown:${toolName ?? '<none>'}`;
  const invocation = {
    capabilityId,
    action: typeof toolName === 'string' ? toolName : 'unknown',
    args: call?.toolInput ?? null,
  };
  const verdict = engine.evaluate(invocation);
  return {
    capabilityId,
    strixDecision: verdict.decision,
    permissionDecision: toPermissionDecision(verdict.decision),
    risk: verdict.risk,
    reason: verdict.reason,
    matchedRule: verdict.matchedRule,
    invocation,
  };
}

/** The effective policy version (content-addressable sha256) for the current ruleset. */
export function policyVersion(engine = buildEngine()) {
  return engine.version;
}

/**
 * Governance-coverage report over Claude Code's built-in tool surface — the data
 * behind `strix-claude doctor`. The "dangerous" surface (`consequential`) is
 * WRITE/EXECUTE mode AND risk ≥ MEDIUM — the board-relevant tools: shell, file
 * edits, subagent spawns, web fetch, skills. LOW-risk control-flow tools
 * (TodoWrite, ExitPlanMode, AskUserQuestion) are state-changing by mode but
 * benign, so they are reported but NOT counted against coverage — otherwise the
 * metric would push operators to gate harmless tools to chase 100%.
 *
 * A tool is "gated" when the policy makes it DENY or APPROVAL_REQUIRED (cannot
 * run un-reviewed). Coverage is the fraction of CONSEQUENTIAL tools that are
 * gated. It is honest about the *policy*; whether the hook is actually installed
 * is a separate axis the CLI reports (an un-installed hook = 0% enforced).
 *
 * @param {PolicyEngine} [engine]
 * @returns {{
 *   tools: Array<{ name:string, id:string, mode:string, risk:string, decision:string, consequential:boolean, gated:boolean }>,
 *   consequential: { total:number, gated:number },
 *   coveragePct: number,
 *   policyVersion: string,
 * }}
 */
export function coverageReport(engine = buildEngine()) {
  const tools = claudeCodeCapabilities.map((cap) => {
    const decision = engine.evaluate({ capabilityId: cap.id }).decision;
    const stateChanging = cap.mode === 'WRITE' || cap.mode === 'EXECUTE';
    const consequential = stateChanging && cap.risk !== 'LOW';
    const gated = decision === 'DENY' || decision === 'APPROVAL_REQUIRED';
    return { name: cap.name, id: cap.id, mode: cap.mode, risk: cap.risk, decision, consequential, gated };
  });
  const cons = tools.filter((t) => t.consequential);
  const gated = cons.filter((t) => t.gated).length;
  const coveragePct = cons.length === 0 ? 100 : Math.round((gated / cons.length) * 100);
  return {
    tools,
    consequential: { total: cons.length, gated },
    coveragePct,
    policyVersion: engine.version,
  };
}
