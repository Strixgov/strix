/**
 * Email MCP server — capability classifications.
 *
 * Generic enough to cover the common ecosystem patterns: SMTP-based
 * sendmail wrappers, Gmail MCP servers, Outlook/Microsoft Graph MCP
 * servers, transactional providers (Postmark, SendGrid, Resend).
 * Tool names vary; the most common conventions:
 *
 *   - `send_email`, `send_message`, `gmail_send_message`
 *   - `read_email`, `gmail_read`, `list_messages`, `list_emails`
 *   - `search_emails`, `gmail_search`
 *   - `delete_email`, `archive_email`, `mark_read`
 *
 * Risk model — email is a high-stakes wrap because every send is a
 * potential phishing or sensitive-disclosure vector that LEAVES THE
 * STRIX DEPLOYMENT and reaches third parties. The classification
 * leans conservative:
 *
 *   - All read-shaped ops (`read_*`, `list_*`, `search_*`,
 *     `get_thread`) are LOW READ. Reading the customer's own mailbox
 *     is the lowest-risk surface — but only after the agent has
 *     authenticated as the user; the access boundary is the OAuth
 *     scope, not the MCP tool name.
 *   - `mark_read`, `add_label`, `archive_email`, `move_to_folder`
 *     are MEDIUM WRITE. Low blast radius (reversible) but still
 *     mutates state visible to the user.
 *   - `send_email`, `send_message`, `reply`, `forward` are HIGH
 *     WRITE. The send is irreversible once delivered; the recipient
 *     has the message. APPROVAL_REQUIRED by default.
 *   - `delete_email` / `delete_message` (where the underlying
 *     provider supports hard delete) is HIGH WRITE.
 *
 * What is NOT in this pack (deliberately):
 *
 *   - `send_to_external_domain` / `send_to_all_employees` —
 *     application-level discriminators that depend on recipient
 *     address inspection. Strix can't classify these a priori without
 *     parsing the email args. Operators wrapping such surfaces should
 *     add per-capability rules in their policy.
 *   - `purge_mailbox` / `wipe_account` / any admin-level destructive
 *     tools. The heuristic in @strixgov/tool-gateway classifies
 *     `purge_*` / `wipe_*` as CRITICAL WRITE and the fail-closed
 *     default DENYs them.
 *
 * Operator note: this pack does NOT validate the `to` / `cc` / `bcc`
 * fields of an email argument. An agent that sends to
 * "everyone@company.com" produces the same signed receipt as an
 * agent that sends to a single recipient. If recipient-domain
 * restrictions matter (most production deployments), they belong
 * at the application layer (the MCP server's argument validation)
 * OR as a higher-tier policy rule that inspects args — which is on
 * the v2.0 governance-engine roadmap, not in mcp-common today.
 */
export const emailCapabilities = Object.freeze([
  // ── Reads (LOW — own mailbox, OAuth-gated) ──────────────────────────
  {
    id: "mcp.email.read_email",
    name: "read_email",
    risk: "LOW",
    mode: "READ",
    description: "Read a single email by id.",
  },
  {
    id: "mcp.email.list_emails",
    name: "list_emails",
    risk: "LOW",
    mode: "READ",
    description: "List emails in a folder or label.",
  },
  {
    id: "mcp.email.list_messages",
    name: "list_messages",
    risk: "LOW",
    mode: "READ",
    description: "List messages (Gmail-style alias for list_emails).",
  },
  {
    id: "mcp.email.search_emails",
    name: "search_emails",
    risk: "LOW",
    mode: "READ",
    description: "Search the mailbox by query string.",
  },
  {
    id: "mcp.email.get_thread",
    name: "get_thread",
    risk: "LOW",
    mode: "READ",
    description: "Get a full email thread by thread id.",
  },
  {
    id: "mcp.email.list_labels",
    name: "list_labels",
    risk: "LOW",
    mode: "READ",
    description: "List labels / folders in the mailbox.",
  },

  // ── Reversible mutations (MEDIUM — state visible to user, undoable) ─
  {
    id: "mcp.email.mark_read",
    name: "mark_read",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Mark an email as read.",
  },
  {
    id: "mcp.email.mark_unread",
    name: "mark_unread",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Mark an email as unread.",
  },
  {
    id: "mcp.email.add_label",
    name: "add_label",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Add a label to an email (Gmail) or move to folder.",
  },
  {
    id: "mcp.email.archive_email",
    name: "archive_email",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Archive an email (reversible via folder restore).",
  },
  {
    id: "mcp.email.draft_email",
    name: "draft_email",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Save a draft email. Does not send.",
  },

  // ── Outbound (HIGH — irreversible once delivered) ──────────────────
  {
    id: "mcp.email.send_email",
    name: "send_email",
    risk: "HIGH",
    mode: "WRITE",
    description: "Send a new email. Irreversible once delivered to the recipient.",
  },
  {
    id: "mcp.email.send_message",
    name: "send_message",
    risk: "HIGH",
    mode: "WRITE",
    description: "Send a new email (alias).",
  },
  {
    id: "mcp.email.reply",
    name: "reply",
    risk: "HIGH",
    mode: "WRITE",
    description: "Reply to an email. Same blast radius as send_email.",
  },
  {
    id: "mcp.email.reply_all",
    name: "reply_all",
    risk: "HIGH",
    mode: "WRITE",
    description: "Reply-all to an email. Widest blast radius of any reply variant.",
  },
  {
    id: "mcp.email.forward",
    name: "forward",
    risk: "HIGH",
    mode: "WRITE",
    description: "Forward an email to additional recipients.",
  },

  // ── Destructive (HIGH — provider-dependent reversibility) ──────────
  {
    id: "mcp.email.delete_email",
    name: "delete_email",
    risk: "HIGH",
    mode: "WRITE",
    description: "Delete an email. Reversibility depends on provider trash-retention policy.",
  },
]);
