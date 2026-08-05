/**
 * Odysseus host surface — shell execution.
 *
 * Risk model:
 *   - Arbitrary shell execution is the single highest-blast-radius
 *     primitive a workspace exposes: it can delete state, exfiltrate
 *     secrets, install persistence, or reach the network. There is no
 *     "safe subset" worth classifying below CRITICAL at the pack layer;
 *     if an operator sandboxes the shell, they relax the policy rule
 *     locally — the pack default stays fail-closed.
 *
 * Interception: `host-hook` — Odysseus's built-in shell does NOT pass
 * through an MCP boundary, so @strixgov/mcp-proxy cannot intercept it
 * today. Until an upstream host hook routes this path through the
 * gateway BEFORE execution, this surface is OBSERVE-ONLY (see README
 * "Enforcement honesty").
 */
export const shellCapabilities = Object.freeze([
  {
    id: "odysseus.shell.execute",
    name: "shell.execute",
    risk: "CRITICAL",
    mode: "EXECUTE",
    interception: "host-hook",
    description:
      "Run a shell command on the workspace host. Irreversible side effects, secret access, and network reach are all in scope.",
  },
]);
