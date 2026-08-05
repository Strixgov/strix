/**
 * Odysseus host surface — native email integration.
 *
 * Risk model (mirrors @strixgov/capabilities-mcp-common/email):
 *   - Reads are LOW READ.
 *   - Drafts are LOW WRITE — they notify nobody.
 *   - Send is HIGH WRITE: once an email reaches the recipient's SMTP
 *     server it cannot be unsent. The signed receipt records intent +
 *     outcome; it does not retract the email.
 *
 * Recipient-domain restrictions are intentionally absent — that is
 * policy-engine territory, not pack territory (same discipline as the
 * mcp-common email pack).
 *
 * Interception: `host-hook` for Odysseus's built-in email path. If
 * email is wired via an MCP server instead, the mcp-common email pack
 * + @strixgov/mcp-proxy cover that path today.
 */
export const emailCapabilities = Object.freeze([
  {
    id: "odysseus.email.read",
    name: "email.read",
    risk: "LOW",
    mode: "READ",
    interception: "host-hook",
    description: "Read or search mailbox content from the workspace.",
  },
  {
    id: "odysseus.email.draft",
    name: "email.draft",
    risk: "LOW",
    mode: "WRITE",
    interception: "host-hook",
    description: "Save a draft. Not visible to recipients.",
  },
  {
    id: "odysseus.email.send",
    name: "email.send",
    risk: "HIGH",
    mode: "WRITE",
    interception: "host-hook",
    description:
      "Send an email to external recipients. Irreversible once delivered.",
  },
]);
