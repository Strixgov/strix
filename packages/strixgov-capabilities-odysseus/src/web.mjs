/**
 * Odysseus host surface — web access.
 *
 * Risk model:
 *   - Search is LOW READ (provider-mediated, no arbitrary URL).
 *   - Fetch is MEDIUM READ: a read that can exfiltrate — an agent can
 *     encode workspace data into the URL/query of an outbound request.
 *     Same rationale as Postgres SELECT in the mcp-common suggested
 *     policy ("reads can exfiltrate; not auto-safe").
 *
 * Interception: `host-hook` for Odysseus's built-in web tools.
 */
export const webCapabilities = Object.freeze([
  {
    id: "odysseus.web.search",
    name: "web.search",
    risk: "LOW",
    mode: "READ",
    interception: "host-hook",
    description: "Run a web search via the workspace's search provider.",
  },
  {
    id: "odysseus.web.fetch",
    name: "web.fetch",
    risk: "MEDIUM",
    mode: "READ",
    interception: "host-hook",
    description:
      "Fetch an arbitrary URL. A read that can exfiltrate: outbound request bytes are attacker-shapable.",
  },
]);
