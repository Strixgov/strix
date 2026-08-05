/**
 * @strixgov/claude-code — governed execution for Claude Code in one command.
 *
 * Library surface (the CLI in bin/strix-claude.mjs is the primary entry):
 *   - decideToolUse / buildEngine / TOOL_NAME_TO_CAPABILITY / policyVersion
 *   - runHook (the PreToolUse runtime core)
 *
 * No fork, no workflow change — `npx @strixgov/claude-code init` adds a
 * PreToolUse hook to .claude/settings.json that governs Claude Code's built-in
 * tools through the Strix PolicyEngine and emits verifier-compatible signed
 * decision receipts.
 */

export {
  decideToolUse,
  buildEngine,
  policyVersion,
  coverageReport,
  toPermissionDecision,
  TOOL_NAME_TO_CAPABILITY,
} from './decide.mjs';
export { runHook } from './hook.mjs';
