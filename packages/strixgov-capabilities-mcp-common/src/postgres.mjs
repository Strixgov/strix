/**
 * Postgres MCP server — capability classifications.
 *
 * Targets the reference implementation at
 * https://github.com/modelcontextprotocol/servers/tree/main/src/postgres
 * (npm: `@modelcontextprotocol/server-postgres`) plus the broader
 * community pattern (servers that expose `query`, `read_query`,
 * `write_query`, `list_tables`, etc.).
 *
 * Risk model — every Postgres operation is high-stakes by default,
 * because:
 *
 *   - Reads can exfiltrate sensitive data en masse. `SELECT * FROM
 *     users` against a production replica is a privacy incident
 *     waiting to happen.
 *   - Writes are usually irreversible (no soft-delete by default, no
 *     row-level undo, no transactional rollback on the agent side
 *     after a commit).
 *   - DDL is destructive. `DROP TABLE` cannot be undone.
 *
 * Strix's classification is intentionally conservative versus
 * Filesystem / Notion: every Postgres tool is at least MEDIUM, and
 * write/DDL operations escalate hard.
 *
 *   - `query` / `read_query` — MEDIUM READ. Reads in production are
 *     a real risk even though they don't mutate data. Operators who
 *     want LOW reads for development databases override per-capability.
 *   - `write_query` — HIGH WRITE. UPDATE/INSERT/DELETE statements.
 *   - `create_table` — HIGH WRITE.
 *   - `alter_table` — HIGH WRITE.
 *   - `list_tables` / `describe_table` — LOW READ. Schema metadata
 *     is the one Postgres surface that's reasonably safe to expose.
 *
 * What is NOT in this pack (deliberately):
 *
 *   - `drop_table` / `drop_database` / `truncate_table` — the reference
 *     server gates these behind operator config. If your deployment
 *     exposes them, the heuristic in @strixgov/tool-gateway classifies
 *     them CRITICAL WRITE and a fail-closed policy blocks them. If you
 *     want to allow scoped drops, add a per-capability rule in your
 *     policy — don't extend this pack to weaken the default.
 *   - `execute_arbitrary_sql` — same: any tool that accepts a raw SQL
 *     string is unclassifiable a priori (the SQL itself determines
 *     the risk). Operators wrapping such a surface must either gate it
 *     at the application level or explicitly classify it CRITICAL.
 *
 * Operator note: SQL injection via tool arguments is OUT of Strix's
 * scope at this layer — the agent's argument values can be any
 * string. Strix governs WHICH tool is called and with what argument
 * HASH; it does not parse SQL or validate query shapes. If your
 * Postgres MCP server interpolates agent input into a SQL string,
 * that's a SQL injection attack surface that needs to be addressed
 * inside the MCP server itself (parameterized queries) — Strix's
 * receipt records the attempt but does not prevent the injection.
 */
export const postgresCapabilities = Object.freeze([
  // ── Schema introspection (the only LOW READ surface) ───────────────
  {
    id: "mcp.postgres.list_tables",
    name: "list_tables",
    risk: "LOW",
    mode: "READ",
    description: "List tables in the connected database.",
  },
  {
    id: "mcp.postgres.list_schemas",
    name: "list_schemas",
    risk: "LOW",
    mode: "READ",
    description: "List schemas in the connected database.",
  },
  {
    id: "mcp.postgres.describe_table",
    name: "describe_table",
    risk: "LOW",
    mode: "READ",
    description: "Describe a table's columns, types, and constraints.",
  },
  {
    id: "mcp.postgres.list_indexes",
    name: "list_indexes",
    risk: "LOW",
    mode: "READ",
    description: "List indexes on a table.",
  },

  // ── Reads (MEDIUM — exfiltration risk) ──────────────────────────────
  {
    id: "mcp.postgres.query",
    name: "query",
    risk: "MEDIUM",
    mode: "READ",
    description: "Run a read-only SELECT query. Default tool name on the reference server.",
  },
  {
    id: "mcp.postgres.read_query",
    name: "read_query",
    risk: "MEDIUM",
    mode: "READ",
    description: "Run a read-only query against the database.",
  },
  {
    id: "mcp.postgres.explain_query",
    name: "explain_query",
    risk: "MEDIUM",
    mode: "READ",
    description: "Return a query plan. May expose schema details and table sizes.",
  },

  // ── Writes (HIGH — usually irreversible from the agent's side) ─────
  {
    id: "mcp.postgres.write_query",
    name: "write_query",
    risk: "HIGH",
    mode: "WRITE",
    description: "Run an INSERT / UPDATE / DELETE statement.",
  },
  {
    id: "mcp.postgres.insert",
    name: "insert",
    risk: "HIGH",
    mode: "WRITE",
    description: "Insert one or more rows.",
  },
  {
    id: "mcp.postgres.update",
    name: "update",
    risk: "HIGH",
    mode: "WRITE",
    description: "Update rows matching a predicate.",
  },
  {
    id: "mcp.postgres.delete",
    name: "delete",
    risk: "HIGH",
    mode: "WRITE",
    description: "Delete rows matching a predicate.",
  },

  // ── DDL (HIGH — schema-shaped, broad blast radius) ─────────────────
  {
    id: "mcp.postgres.create_table",
    name: "create_table",
    risk: "HIGH",
    mode: "WRITE",
    description: "Create a new table.",
  },
  {
    id: "mcp.postgres.alter_table",
    name: "alter_table",
    risk: "HIGH",
    mode: "WRITE",
    description: "Alter an existing table's schema. Column rename / add / drop / type change.",
  },
  {
    id: "mcp.postgres.create_index",
    name: "create_index",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create an index. Lower blast radius than table DDL but can lock writes during build.",
  },
]);
