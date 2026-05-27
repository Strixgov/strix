/**
 * @strixgov/capabilities-claude-code — pre-classified capability registry
 * for Claude Code's built-in tool surface.
 *
 * Why these classifications:
 *   - READ-only file inspection (Read, Glob, Grep) is LOW. No state change.
 *   - WRITE-shaped file edits (Write, Edit, NotebookEdit) are MEDIUM. They
 *     modify local state but are reversible via VCS.
 *   - Bash is HIGH EXECUTE. Shell is universally the destructive surface;
 *     even seemingly-safe commands (`rm`, `git push`, `curl | sh`) can
 *     produce irreversible effects. Operators should override to CRITICAL
 *     for production hosts.
 *   - Task (subagent) is MEDIUM EXECUTE. The subagent inherits the parent's
 *     governance scope, so authority does not escalate — but the spawn
 *     itself is a moderate-risk control-flow event.
 *   - WebFetch is MEDIUM EXECUTE. External HTTP read can leak data via
 *     URLs, redirects, or referrers; not strictly read-only.
 *   - WebSearch / ToolSearch / Monitor / TodoWrite / ExitPlanMode /
 *     AskUserQuestion are LOW. They don't touch the host or external
 *     world in a way that needs governance — but evidence is still
 *     emitted so the agent's decision trail is complete.
 *
 * These are starter classifications. Override via your policy ruleset
 * for project-specific risk.  E.g., a regulated environment may bump
 * `claude.bash` to CRITICAL and require multi-party approval.
 *
 * Usage:
 *
 *   import { claudeCodeCapabilities, claudeCodeCapabilityMap }
 *     from "@strixgov/capabilities-claude-code";
 *   import { createGateway } from "@strixgov/tool-gateway";
 *
 *   const gateway = createGateway({
 *     capabilities: claudeCodeCapabilityMap(),
 *     policy: {
 *       rules: {
 *         "claude.read": "ALLOW",
 *         "claude.bash": "APPROVAL_REQUIRED",
 *         "claude.write": "APPROVAL_REQUIRED",
 *       },
 *       default: "DENY",
 *     },
 *     // ...
 *   });
 *
 * Or persist as a signed manifest your team shares across agent processes:
 *
 *   import { saveCapabilityRegistry } from "@strixgov/tool-gateway";
 *   await saveCapabilityRegistry({
 *     signingKey: ring.active,
 *     capabilities: claudeCodeCapabilities,
 *   });
 */

export const REGISTRY_NAME = "claude-code";
export const REGISTRY_VERSION = "0.1.0";

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
 *   mode: "READ" | "WRITE" | "EXECUTE",
 *   description: string,
 * }} ClaudeCodeCapability
 */

/** @type {ReadonlyArray<ClaudeCodeCapability>} */
export const claudeCodeCapabilities = Object.freeze([
  {
    id: "claude.read",
    name: "Read",
    risk: "LOW",
    mode: "READ",
    description: "Read a file from the local filesystem.",
  },
  {
    id: "claude.glob",
    name: "Glob",
    risk: "LOW",
    mode: "READ",
    description: "List files matching a glob pattern.",
  },
  {
    id: "claude.grep",
    name: "Grep",
    risk: "LOW",
    mode: "READ",
    description: "Search file contents with ripgrep semantics.",
  },
  {
    id: "claude.write",
    name: "Write",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create or overwrite a file on disk.",
  },
  {
    id: "claude.edit",
    name: "Edit",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Apply an exact-string replacement to an existing file.",
  },
  {
    id: "claude.notebook_edit",
    name: "NotebookEdit",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Edit cells in a Jupyter notebook (.ipynb).",
  },
  {
    id: "claude.bash",
    name: "Bash",
    risk: "HIGH",
    mode: "EXECUTE",
    description:
      "Execute a shell command. Override to CRITICAL on production hosts.",
  },
  {
    id: "claude.task",
    name: "Task",
    risk: "MEDIUM",
    mode: "EXECUTE",
    description:
      "Spawn a subagent. Subagents inherit the parent's governance scope.",
  },
  {
    id: "claude.web_fetch",
    name: "WebFetch",
    risk: "MEDIUM",
    mode: "EXECUTE",
    description:
      "Fetch an external URL. Treated as EXECUTE because URL parameters can leak local data.",
  },
  {
    id: "claude.web_search",
    name: "WebSearch",
    risk: "LOW",
    mode: "READ",
    description: "Search the web. No host-state change.",
  },
  {
    id: "claude.tool_search",
    name: "ToolSearch",
    risk: "LOW",
    mode: "READ",
    description: "Look up deferred tool schemas. No host-state change.",
  },
  {
    id: "claude.monitor",
    name: "Monitor",
    risk: "LOW",
    mode: "READ",
    description: "Stream events from a background process.",
  },
  {
    id: "claude.todo_write",
    name: "TodoWrite",
    risk: "LOW",
    mode: "WRITE",
    description: "Update the agent's internal task list. Local UI state only.",
  },
  {
    id: "claude.exit_plan_mode",
    name: "ExitPlanMode",
    risk: "LOW",
    mode: "EXECUTE",
    description: "Ask the user to leave plan mode and proceed.",
  },
  {
    id: "claude.ask_user_question",
    name: "AskUserQuestion",
    risk: "LOW",
    mode: "EXECUTE",
    description: "Prompt the user with a multiple-choice question.",
  },
  {
    id: "claude.skill",
    name: "Skill",
    risk: "MEDIUM",
    mode: "EXECUTE",
    description:
      "Invoke a configured skill. Effects depend on the skill's body — defaulted MEDIUM; bump to HIGH if the skill mutates host or external state.",
  },
]);

/**
 * Build a `Record<capabilityId, capability>` suitable for passing to
 * `createGateway({ capabilities: ... })` directly.
 *
 * @returns {Record<string, ClaudeCodeCapability>}
 */
export function claudeCodeCapabilityMap() {
  /** @type {Record<string, ClaudeCodeCapability>} */
  const map = {};
  for (const cap of claudeCodeCapabilities) {
    map[cap.id] = { ...cap };
  }
  return map;
}

/**
 * Build a starter policy ruleset for Claude Code. Defaults are
 * deliberately strict — reads ALLOW, writes APPROVAL_REQUIRED, Bash
 * APPROVAL_REQUIRED, default DENY. Override before passing to the
 * gateway if your environment has different baselines.
 *
 * @returns {{ rules: Record<string, "ALLOW" | "DENY" | "APPROVAL_REQUIRED">, default: "DENY" }}
 */
export function suggestedPolicy() {
  return {
    rules: {
      "claude.read": "ALLOW",
      "claude.glob": "ALLOW",
      "claude.grep": "ALLOW",
      "claude.web_search": "ALLOW",
      "claude.tool_search": "ALLOW",
      "claude.monitor": "ALLOW",
      "claude.todo_write": "ALLOW",
      "claude.exit_plan_mode": "ALLOW",
      "claude.ask_user_question": "ALLOW",
      "claude.write": "APPROVAL_REQUIRED",
      "claude.edit": "APPROVAL_REQUIRED",
      "claude.notebook_edit": "APPROVAL_REQUIRED",
      "claude.bash": "APPROVAL_REQUIRED",
      "claude.task": "APPROVAL_REQUIRED",
      "claude.web_fetch": "APPROVAL_REQUIRED",
      "claude.skill": "APPROVAL_REQUIRED",
    },
    default: "DENY",
  };
}
