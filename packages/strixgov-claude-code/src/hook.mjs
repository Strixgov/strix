/**
 * @strixgov/claude-code — the PreToolUse hook runtime.
 *
 * Claude Code invokes the configured PreToolUse hook command before each
 * built-in tool. The command receives a JSON payload on stdin
 * (`{ tool_name, tool_input, ... }`) and prints a JSON decision on stdout. This
 * module produces that decision AND a signed, verifier-compatible receipt of
 * the governed decision — reusing the tool-gateway receipt stack (locked
 * canonical schema, Ed25519), so `npx @strixgov/verifier` (or `verifyReceipt`)
 * checks it with zero shared code.
 *
 * Ordering / failure discipline:
 *   - The DECISION is always returned (allow/ask/deny). It is computed by the
 *     fail-closed PolicyEngine and does NOT depend on signing being available —
 *     a missing key never silently turns a DENY into an allow.
 *   - The RECEIPT is best-effort evidence: if signing/storage fails we still
 *     emit the decision (and surface the receipt error for the operator),
 *     because the enforcement is the decision, not the log of it.
 */

import { issueReceipt } from '@strixgov/tool-gateway';
import { claudeCodeCapabilityMap } from '@strixgov/capabilities-claude-code';
import { buildEngine, decideToolUse, policyVersion } from './decide.mjs';

const CAP_MAP = claudeCodeCapabilityMap();

/**
 * Run the hook against a parsed PreToolUse payload. Pure except for the
 * injected `storage` (append) — everything else is deterministic given inputs,
 * which is what makes it unit-testable without Claude Code or a server.
 *
 * @param {object} args
 * @param {{ tool_name?: string, tool_input?: unknown }} args.payload — parsed PreToolUse stdin
 * @param {import('@strixgov/tool-gateway').PolicyEngine} [args.engine]
 * @param {{ kid: string, privateKey: import('crypto').KeyObject }} [args.signingKey] — omit to skip the receipt
 * @param {{ appendReceipt(r:object):Promise<void>, lastReceipt():Promise<object|null> }} [args.storage]
 * @param {string} [args.timestamp] — ISO; defaults to now
 * @returns {Promise<{ hookOutput: object, decision: object, receipt: object|null, receiptError: string|null }>}
 */
export async function runHook({ payload, engine, signingKey, storage, timestamp } = {}) {
  const eng = engine ?? buildEngine();
  const decision = decideToolUse(
    { toolName: payload?.tool_name, toolInput: payload?.tool_input },
    eng,
  );

  const hookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.permissionDecision,
      permissionDecisionReason: reasonText(decision),
    },
  };

  let receipt = null;
  let receiptError = null;
  const capability = CAP_MAP[decision.capabilityId];
  if (signingKey && capability) {
    try {
      const previousChainHash = storage ? (await storage.lastReceipt())?.proofChainHash : undefined;
      receipt = issueReceipt({
        invocation: decision.invocation,
        capability,
        decision: decision.strixDecision,
        previousChainHash,
        signingKey,
        policyVersion: policyVersion(eng),
        toolName: 'claude-code',
        timestamp,
      });
      if (storage) await storage.appendReceipt(receipt);
    } catch (err) {
      receiptError = err && err.message ? err.message : String(err);
    }
  } else if (!capability) {
    // Unknown/unclassified tool: there is no capability to bind a receipt to.
    // The decision is already DENY (fail-closed); we simply mint no evidence.
    receiptError = `no capability for tool "${payload?.tool_name ?? '<none>'}" (decision: ${decision.strixDecision})`;
  }

  return { hookOutput, decision, receipt, receiptError };
}

function reasonText(decision) {
  const verify = decision.strixDecision === 'ALLOW' ? '' : ' Strix governed this Claude Code tool call.';
  switch (decision.permissionDecision) {
    case 'allow':
      return `Strix: ${decision.capabilityId} ALLOW (${decision.reason}).`;
    case 'ask':
      return `Strix: ${decision.capabilityId} requires approval (${decision.risk} risk, ${decision.reason}).${verify}`;
    case 'deny':
    default:
      return `Strix: ${decision.capabilityId} DENIED (${decision.reason}). The tool did not run.${verify}`;
  }
}
