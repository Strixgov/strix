/**
 * Wrap an Email MCP server with Strix governance.
 *
 *   node examples/email.mjs                  # offline stub
 *
 *   STRIX_EMAIL_MCP_COMMAND="npx" \
 *   STRIX_EMAIL_MCP_ARGS='["-y","@some/email-mcp-server"]' \
 *     node examples/email.mjs                # live (BYO email MCP server)
 *
 * The "agent sending email" wrap — every CISO has personally worried
 * about this one. The pack classifies the Email MCP surface so that:
 *
 *   - LOW READ → ALLOW: mailbox reads, search, list labels. The
 *     OAuth scope is the access boundary; Strix is the action
 *     boundary on top.
 *   - MEDIUM WRITE → APPROVAL_REQUIRED: reversible mutations
 *     (mark_read, archive, draft_email).
 *   - HIGH WRITE → APPROVAL_REQUIRED (auto-approved for the demo):
 *     send_email, reply, reply_all, forward, delete_email — all
 *     irreversible once delivered or once provider trash-retention
 *     expires.
 *   - Out-of-pack heuristic → CRITICAL → DENY: e.g. `purge_mailbox`
 *     is not classified; heuristic catches and the fail-closed
 *     default blocks it.
 *
 * The Email MCP ecosystem is still consolidating — multiple Gmail
 * servers, Outlook/Microsoft Graph servers, SMTP wrappers, etc. The
 * pack covers the common tool-name conventions
 * (`send_email` / `send_message` / `gmail_send_message`, etc.); the
 * live-mode connector is BYO via env vars.
 *
 * Operator-discipline note (also in the pack header): this demo and
 * pack do NOT validate the `to` / `cc` / `bcc` fields of an email.
 * An agent sending to one teammate produces the same signed
 * receipt as an agent sending to "everyone@company.com". If
 * recipient-domain restrictions matter (most production deployments)
 * they belong at the MCP server's argument validation OR as a
 * higher-tier policy rule.
 */

import { governMCPServer } from "@strixgov/mcp-adapter";
import { emailCapabilities } from "@strixgov/capabilities-mcp-common/email";

// ─── 1. Acquire a tool source ─────────────────────────────────────────────────

const toolSource = await loadToolSource();
console.log(`\n→ Using ${toolSource.mode} Email tools (serverId=email)\n`);

// ─── 2. Wrap with Strix — five lines ──────────────────────────────────────────

const governed = governMCPServer(toolSource.iface, {
  serverId: "email",
  capabilities: emailCapabilities,
  policy: {
    riskOverrides: {
      LOW: "ALLOW",                 // mailbox reads
      MEDIUM: "APPROVAL_REQUIRED",  // reversible mutations
      HIGH: "APPROVAL_REQUIRED",    // outbound + delete
      CRITICAL: "DENY",             // heuristic catches purge/wipe
    },
    default: "DENY",
  },
  approval: {
    enabled: true,
    prompt: async (cap, invocation) => {
      console.log(`  ⏸  approval gate → auto-approving ${cap.id} for demo`);
      // Real approvers should surface to/from/subject to the human.
      const args = invocation?.args ?? {};
      if (args.to) console.log(`     to: ${Array.isArray(args.to) ? args.to.join(", ") : args.to}`);
      if (args.subject) console.log(`     subject: ${truncate(args.subject, 60)}`);
      return { approved: true, approver: "demo-script" };
    },
  },
});

// ─── 3. Observe every signed receipt ──────────────────────────────────────────

const receipts = [];
governed.gateway.on("receipt", (r) => receipts.push(r));

// ─── 4. Drive a few representative calls ─────────────────────────────────────

await tryCall("list_emails",   { label: "INBOX", maxResults: 10 });
await tryCall("search_emails", { query: "from:billing" });
await tryCall("mark_read",     { id: "msg_1" });
await tryCall("draft_email",   { to: "alice@example.com", subject: "Plan", body: "..." });
await tryCall("send_email",    { to: "alice@example.com", subject: "Q3 plan attached", body: "See attached." });
await tryCall("reply_all",     { id: "msg_42", body: "Thanks all — proceeding." });
await tryCall("purge_mailbox", { account: "user@example.com" }); // out-of-pack → heuristic CRITICAL → DENY

// ─── 5. Show what we proved ───────────────────────────────────────────────────

console.log(`\n─── ${receipts.length} signed receipts ──────────────────────────────`);
for (const r of receipts) {
  const sigPreview = r.signature ? r.signature.slice(0, 16) + "…" : "<missing>";
  console.log(
    `  ${r.decision.padEnd(8)} ${r.capabilityId.padEnd(36)} sig=${sigPreview}`,
  );
}

const chain = await governed.gateway.verifyChain();
console.log(`\nproof chain: valid=${chain.valid}, receipts=${chain.count ?? receipts.length}`);
console.log("\nEvery agent-sent email is now bound to the approver + signed receipt.");
console.log("Verify offline with:");
console.log("  npx @strixgov/verifier chain ~/.strix-mcp-adapter/receipts.jsonl");

if (toolSource.dispose) await toolSource.dispose();

// ─── helpers ─────────────────────────────────────────────────────────────────

async function tryCall(name, args) {
  try {
    const result = await governed.callTool(name, args, { actorId: "agent-email-1" });
    const preview = JSON.stringify(result).slice(0, 80);
    console.log(`  ✓ ${name.padEnd(16)} → ALLOW   ${preview}`);
  } catch (err) {
    const code = err.code ?? "ERROR";
    console.log(`  ✗ ${name.padEnd(16)} → ${code}`);
  }
}

function truncate(s, n) {
  return typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : String(s);
}

async function loadToolSource() {
  const wantsLive = Boolean(process.env.STRIX_EMAIL_MCP_COMMAND);
  if (wantsLive) {
    try {
      return await connectLiveEmailMcp();
    } catch (err) {
      console.warn(
        `\n⚠  Live mode requested but failed: ${err.message}\n` +
          "   Falling back to stub. Set STRIX_EMAIL_MCP_COMMAND and\n" +
          "   STRIX_EMAIL_MCP_ARGS (JSON array) to point at your Email MCP server.\n",
      );
    }
  }
  return { mode: "stub", iface: buildStubHandlers() };
}

async function connectLiveEmailMcp() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const command = process.env.STRIX_EMAIL_MCP_COMMAND;
  const args = process.env.STRIX_EMAIL_MCP_ARGS
    ? JSON.parse(process.env.STRIX_EMAIL_MCP_ARGS)
    : [];

  const transport = new StdioClientTransport({ command, args, env: process.env });
  const client = new Client({ name: "strix-demo", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    mode: `live (${command} ${args.join(" ")} via stdio)`,
    iface: {
      serverId: "email",
      listTools: async () => {
        const out = await client.listTools();
        return out.tools.map((t) => ({ name: t.name, description: t.description }));
      },
      handler: async (name, a) => {
        return await client.callTool({ name, arguments: a ?? {} });
      },
    },
    dispose: async () => {
      try { await client.close(); } catch { /* best-effort */ }
    },
  };
}

function buildStubHandlers() {
  return {
    list_emails:    async ({ label }) => ({ label, messages: [{ id: "msg_1", from: "billing@example.com", subject: "Invoice" }] }),
    list_messages:  async ({ label }) => ({ label, messages: [] }),
    read_email:     async ({ id }) => ({ id, from: "billing@example.com", subject: "Invoice", body: "..." }),
    search_emails:  async ({ query }) => ({ query, hits: [{ id: "msg_1" }] }),
    get_thread:     async ({ id }) => ({ id, messages: [] }),
    list_labels:    async () => ({ labels: ["INBOX", "Sent", "Drafts"] }),
    mark_read:      async ({ id }) => ({ id, read: true }),
    mark_unread:    async ({ id }) => ({ id, read: false }),
    add_label:      async ({ id, label }) => ({ id, label, ok: true }),
    archive_email:  async ({ id }) => ({ id, archived: true }),
    draft_email:    async ({ to, subject }) => ({ draftId: "draft_1", to, subject }),
    send_email:     async ({ to, subject }) => ({ messageId: "sent_msg_1", to, subject, delivered: true }),
    send_message:   async ({ to, subject }) => ({ messageId: "sent_msg_1", to, subject, delivered: true }),
    reply:          async ({ id }) => ({ replyTo: id, messageId: "reply_1" }),
    reply_all:      async ({ id }) => ({ replyTo: id, messageId: "reply_all_1", recipients: 12 }),
    forward:        async ({ id, to }) => ({ forwardOf: id, to, messageId: "fwd_1" }),
    delete_email:   async ({ id }) => ({ id, deleted: true }),
    // NOTE: deliberately no `purge_mailbox` stub — the demo proves the
    // heuristic + default-DENY blocks unknown destructive tools.
  };
}
