/**
 * Wrap the Postgres MCP server with Strix governance.
 *
 *   node examples/postgres.mjs                      # offline stub
 *   STRIX_POSTGRES_URL=postgres://… \
 *     node examples/postgres.mjs                    # live — spawns
 *                                                   # @modelcontextprotocol/server-postgres
 *
 * The Enterprise-tier demo. Postgres is the highest-stakes wrap in
 * the bundle:
 *
 *   - Reads (`query`, `read_query`) can exfiltrate sensitive data en
 *     masse — `SELECT * FROM users` is the most common privacy-
 *     incident pattern. The pack classifies these MEDIUM READ (not
 *     LOW); the suggested policy gates them behind approval rather
 *     than auto-allowing.
 *   - Writes (`write_query`, `insert`, `update`, `delete`) are
 *     irreversible from the agent's side. The pack classifies HIGH
 *     WRITE; this demo holds them for approval.
 *   - DDL (`create_table`, `alter_table`) is broad-blast-radius
 *     schema mutation. HIGH WRITE.
 *   - Out-of-pack `drop_table` falls to heuristic CRITICAL → DENY.
 *     Operators who explicitly want drops add a per-capability rule;
 *     the default is fail-closed.
 *
 * Live mode requires the optional peers + a database the agent can
 * actually reach:
 *
 *   npm install --no-save @modelcontextprotocol/sdk @modelcontextprotocol/server-postgres
 *   export STRIX_POSTGRES_URL=postgres://user:pass@localhost:5432/dbname
 *
 * If either peer is missing or the URL isn't set, the example falls
 * back to a stub. There's no half-broken state.
 *
 * Operator-discipline note (also in the pack header): SQL injection
 * via tool arguments is out of Strix's scope at this layer. The
 * agent's argument values can be any string. Strix governs WHICH
 * tool is called and with what argument HASH; it does not parse SQL
 * or validate query shapes. If your Postgres MCP server interpolates
 * agent input into a SQL string, that's a SQL injection attack
 * surface that must be addressed inside the MCP server itself
 * (parameterized queries) — Strix's signed receipt records the
 * attempt but does not prevent the injection.
 */

import { governMCPServer } from "@strixgov/mcp-adapter";
import { postgresCapabilities } from "@strixgov/capabilities-mcp-common/postgres";

// ─── 1. Acquire a tool source ─────────────────────────────────────────────────

const toolSource = await loadToolSource();
console.log(`\n→ Using ${toolSource.mode} Postgres tools (serverId=postgres)\n`);

// ─── 2. Wrap with Strix — five lines ──────────────────────────────────────────

const governed = governMCPServer(toolSource.iface, {
  serverId: "postgres",
  capabilities: postgresCapabilities,
  policy: {
    riskOverrides: {
      LOW: "ALLOW",                 // schema introspection only
      MEDIUM: "APPROVAL_REQUIRED",  // SELECTs — the exfiltration discipline
      HIGH: "APPROVAL_REQUIRED",    // writes + DDL
      CRITICAL: "DENY",             // out-of-pack heuristic blocks drop/truncate
    },
    default: "DENY",
  },
  approval: {
    enabled: true,
    prompt: async (cap, invocation) => {
      // In production this is wired to a Slack / web UI / webhook
      // approver. The auto-approve here is for the demo only.
      console.log(`  ⏸  approval gate → auto-approving ${cap.id} for demo`);
      if (invocation?.args?.sql) {
        console.log(`     query preview: ${truncate(invocation.args.sql, 80)}`);
      }
      return { approved: true, approver: "demo-script" };
    },
  },
});

// ─── 3. Observe every signed receipt ──────────────────────────────────────────

const receipts = [];
governed.gateway.on("receipt", (r) => receipts.push(r));

// ─── 4. Drive a few representative calls ─────────────────────────────────────

await tryCall("list_tables",   {});
await tryCall("describe_table",{ table: "users" });
await tryCall("query",         { sql: "SELECT id, email_hash FROM users LIMIT 10" });
await tryCall("write_query",   { sql: "UPDATE users SET last_seen = NOW() WHERE id = $1", params: [42] });
await tryCall("create_table",  { sql: "CREATE TABLE audit_log (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ, payload JSONB)" });
await tryCall("drop_table",    { table: "audit_log" }); // out-of-pack → heuristic CRITICAL → DENY

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
console.log("\nEvery SELECT, INSERT/UPDATE/DELETE, and DDL operation is now");
console.log("bound to the approver + signed receipt. Verify offline with:");
console.log("  npx @strixgov/verifier chain ~/.strix-mcp-adapter/receipts.jsonl");

if (toolSource.dispose) await toolSource.dispose();

// ─── helpers ─────────────────────────────────────────────────────────────────

async function tryCall(name, args) {
  try {
    const result = await governed.callTool(name, args, { actorId: "agent-postgres-1" });
    const preview = JSON.stringify(result).slice(0, 80);
    console.log(`  ✓ ${name.padEnd(18)} → ALLOW   ${preview}`);
  } catch (err) {
    const code = err.code ?? "ERROR";
    console.log(`  ✗ ${name.padEnd(18)} → ${code}`);
  }
}

function truncate(s, n) {
  return typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : String(s);
}

async function loadToolSource() {
  const wantsLive = Boolean(process.env.STRIX_POSTGRES_URL);
  if (wantsLive) {
    try {
      return await connectLivePostgresMcp(process.env.STRIX_POSTGRES_URL);
    } catch (err) {
      console.warn(
        `\n⚠  Live mode requested but failed: ${err.message}\n` +
          "   Falling back to stub. Install the optional peers:\n" +
          "     npm install --no-save @modelcontextprotocol/sdk @modelcontextprotocol/server-postgres\n",
      );
    }
  }
  return { mode: "stub", iface: buildStubHandlers() };
}

async function connectLivePostgresMcp(url) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", url],
  });
  const client = new Client({ name: "strix-demo", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    mode: "live (server-postgres via stdio)",
    iface: {
      serverId: "postgres",
      listTools: async () => {
        const out = await client.listTools();
        return out.tools.map((t) => ({ name: t.name, description: t.description }));
      },
      handler: async (name, args) => {
        return await client.callTool({ name, arguments: args ?? {} });
      },
    },
    dispose: async () => {
      try { await client.close(); } catch { /* best-effort */ }
    },
  };
}

function buildStubHandlers() {
  // Mirrors the on-the-wire tool surface of the Postgres MCP companion pack.
  // No real DB connection; just canned shapes so the receipt flow is visible.
  return {
    list_tables:    async () => ({ tables: ["users", "sessions", "audit_log"] }),
    list_schemas:   async () => ({ schemas: ["public", "audit"] }),
    describe_table: async ({ table }) => ({
      table,
      columns: [
        { name: "id", type: "bigint", nullable: false },
        { name: "email_hash", type: "text", nullable: false },
        { name: "last_seen", type: "timestamptz", nullable: true },
      ],
    }),
    list_indexes:   async ({ table }) => ({ table, indexes: [`${table}_pkey`] }),
    query:          async ({ sql }) => ({ sql, rows: [{ id: 1, email_hash: "stub" }], rowCount: 1 }),
    read_query:     async ({ sql }) => ({ sql, rows: [], rowCount: 0 }),
    explain_query:  async ({ sql }) => ({ sql, plan: "Seq Scan on users (cost=0.00..1.10 rows=10 width=64)" }),
    write_query:    async ({ sql, params }) => ({ sql, params, rowCount: 1 }),
    insert:         async ({ table, values }) => ({ table, inserted: 1, values }),
    update:         async ({ table }) => ({ table, updated: 1 }),
    delete:         async ({ table }) => ({ table, deleted: 1 }),
    create_table:   async ({ sql }) => ({ sql, ok: true }),
    alter_table:    async ({ sql }) => ({ sql, ok: true }),
    create_index:   async ({ table, columns }) => ({ table, columns, ok: true }),
    // NOTE: deliberately no `drop_table` stub — the demo proves the
    // heuristic + default-DENY blocks unknown destructive tools.
  };
}
