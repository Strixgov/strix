/**
 * Odysseus host surface — MCP passthrough + extension installation.
 *
 * `odysseus.mcp.invoke` is the one surface in this pack that is
 * enforceable TODAY: point Odysseus's MCP server configuration at
 * @strixgov/mcp-proxy and every wrapped tool call is intercepted,
 * evaluated, optionally held for approval, and receipted BEFORE the
 * side effect. Per-tool risk then resolves through the wrapped
 * server's pack (e.g. @strixgov/capabilities-mcp-common). The HIGH
 * EXECUTE classification here is the fail-closed FLOOR for wrapped
 * tools that no pack classifies — unclassified tools must not slide
 * to auto-allow.
 *
 * `odysseus.skill.install` is CRITICAL: installing a model-generated
 * skill/extension is deferred code execution — everything the skill
 * does later runs with workspace authority.
 */
export const extensionCapabilities = Object.freeze([
  {
    id: "odysseus.mcp.invoke",
    name: "mcp.invoke",
    risk: "HIGH",
    mode: "EXECUTE",
    interception: "mcp-proxy",
    description:
      "Invoke a tool on a configured MCP server. Risk resolves per wrapped tool via its server pack; HIGH is the fail-closed floor for unclassified tools.",
  },
  {
    id: "odysseus.skill.install",
    name: "skill.install",
    risk: "CRITICAL",
    mode: "WRITE",
    interception: "host-hook",
    description:
      "Install a skill/extension into the workspace. Deferred code execution with workspace authority.",
  },
]);
