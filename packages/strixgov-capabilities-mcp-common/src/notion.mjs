/**
 * Notion MCP server — capability classifications.
 *
 * Notion's MCP exposes a heavy read surface (fetch, search, query) and
 * a focused write set. Page/database mutations are MEDIUM WRITE — they
 * affect shared docs but Notion has version history and undo.
 *
 * No CRITICAL classification today: there's no atomic "delete workspace"
 * or "purge database" in the standard MCP. If your wrapper exposes one,
 * classify CRITICAL EXECUTE locally.
 *
 * ── Two naming conventions ──
 *
 * Notion has shipped at least two distinct tool-naming conventions in
 * its MCP server over time:
 *
 *  1. The older `notion-*` style (e.g. `notion-fetch`, `notion-search`,
 *     `notion-create-pages`) — what the 2024-era `@notionhq/notion-mcp-server`
 *     and several community wrappers emit.
 *  2. The newer `API-*` style (e.g. `API-retrieve-a-page`,
 *     `API-post-search`, `API-create-a-comment`) — what the modern
 *     `@notionhq/notion-mcp-server` (verified May 2026) emits, mirroring
 *     the underlying Notion REST API path naming.
 *
 * Both are classified here so the pack matches whichever upstream you
 * happen to be wrapping. The proxy uses `cap.name` for tool-name lookup,
 * so the two sets never collide — `notion-fetch` matches one entry,
 * `API-retrieve-a-page` matches another. Capability IDs are namespaced
 * accordingly: `mcp.notion.fetch` vs `mcp.notion.API-retrieve-a-page`.
 */
export const notionCapabilities = Object.freeze([
  // ── Reads ────────────────────────────────────────────────────────────
  {
    id: "mcp.notion.fetch",
    name: "notion-fetch",
    risk: "LOW",
    mode: "READ",
    description: "Fetch a Notion page or database.",
  },
  {
    id: "mcp.notion.search",
    name: "notion-search",
    risk: "LOW",
    mode: "READ",
    description: "Search across the Notion workspace.",
  },
  {
    id: "mcp.notion.get_comments",
    name: "notion-get-comments",
    risk: "LOW",
    mode: "READ",
    description: "Read comments on a page or block.",
  },
  {
    id: "mcp.notion.get_teams",
    name: "notion-get-teams",
    risk: "LOW",
    mode: "READ",
    description: "List teamspaces.",
  },
  {
    id: "mcp.notion.get_users",
    name: "notion-get-users",
    risk: "LOW",
    mode: "READ",
    description: "List workspace users.",
  },
  {
    id: "mcp.notion.query_database_view",
    name: "notion-query-database-view",
    risk: "LOW",
    mode: "READ",
    description: "Query a database view.",
  },
  {
    id: "mcp.notion.query_meeting_notes",
    name: "notion-query-meeting-notes",
    risk: "LOW",
    mode: "READ",
    description: "Search meeting notes.",
  },
  // ── Writes ───────────────────────────────────────────────────────────
  {
    id: "mcp.notion.create_pages",
    name: "notion-create-pages",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create one or more Notion pages.",
  },
  {
    id: "mcp.notion.create_database",
    name: "notion-create-database",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create a Notion database.",
  },
  {
    id: "mcp.notion.create_view",
    name: "notion-create-view",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create a database view.",
  },
  {
    id: "mcp.notion.create_comment",
    name: "notion-create-comment",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Add a comment to a page or block.",
  },
  {
    id: "mcp.notion.update_page",
    name: "notion-update-page",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Update a Notion page's properties or content.",
  },
  {
    id: "mcp.notion.update_data_source",
    name: "notion-update-data-source",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Update a database's data source schema.",
  },
  {
    id: "mcp.notion.update_view",
    name: "notion-update-view",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Update a database view's filters or configuration.",
  },
  {
    id: "mcp.notion.duplicate_page",
    name: "notion-duplicate-page",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Duplicate a Notion page.",
  },
  {
    id: "mcp.notion.move_pages",
    name: "notion-move-pages",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Move pages between parents.",
  },
  // ── Modern Notion MCP server — `API-*` naming convention ─────────────
  //   Verified against @notionhq/notion-mcp-server (May 2026 build) via
  //   real Claude Desktop dogfood: tool names mirror the underlying
  //   Notion REST API path naming (`/users/me` → `API-get-self`, etc.).
  // ── Reads (API-*) ────────────────────────────────────────────────────
  {
    id: "mcp.notion.API-get-self",
    name: "API-get-self",
    risk: "LOW",
    mode: "READ",
    description: "Retrieve the current bot user.",
  },
  {
    id: "mcp.notion.API-get-user",
    name: "API-get-user",
    risk: "LOW",
    mode: "READ",
    description: "Retrieve a user by ID.",
  },
  {
    id: "mcp.notion.API-get-users",
    name: "API-get-users",
    risk: "LOW",
    mode: "READ",
    description: "List all users in the workspace.",
  },
  {
    id: "mcp.notion.API-retrieve-a-page",
    name: "API-retrieve-a-page",
    risk: "LOW",
    mode: "READ",
    description: "Retrieve a page by ID.",
  },
  {
    id: "mcp.notion.API-retrieve-a-page-property",
    name: "API-retrieve-a-page-property",
    risk: "LOW",
    mode: "READ",
    description: "Retrieve a single property of a page.",
  },
  {
    id: "mcp.notion.API-retrieve-a-block",
    name: "API-retrieve-a-block",
    risk: "LOW",
    mode: "READ",
    description: "Retrieve a block by ID.",
  },
  {
    id: "mcp.notion.API-get-block-children",
    name: "API-get-block-children",
    risk: "LOW",
    mode: "READ",
    description: "Retrieve the children of a block (paginated).",
  },
  {
    id: "mcp.notion.API-retrieve-a-database",
    name: "API-retrieve-a-database",
    risk: "LOW",
    mode: "READ",
    description: "Retrieve a database by ID.",
  },
  {
    id: "mcp.notion.API-retrieve-a-data-source",
    name: "API-retrieve-a-data-source",
    risk: "LOW",
    mode: "READ",
    description: "Retrieve a data source's schema and metadata.",
  },
  {
    id: "mcp.notion.API-query-data-source",
    name: "API-query-data-source",
    risk: "LOW",
    mode: "READ",
    description: "Query a data source with filters and sorts.",
  },
  {
    id: "mcp.notion.API-list-data-source-templates",
    name: "API-list-data-source-templates",
    risk: "LOW",
    mode: "READ",
    description: "List templates available for a data source.",
  },
  {
    id: "mcp.notion.API-retrieve-a-comment",
    name: "API-retrieve-a-comment",
    risk: "LOW",
    mode: "READ",
    description: "Retrieve comments on a page or block.",
  },
  {
    id: "mcp.notion.API-post-search",
    name: "API-post-search",
    risk: "LOW",
    mode: "READ",
    description: "Search across the workspace. POST-shaped but read semantics.",
  },
  // ── Writes (API-*) ───────────────────────────────────────────────────
  {
    id: "mcp.notion.API-post-page",
    name: "API-post-page",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create a new page.",
  },
  {
    id: "mcp.notion.API-patch-page",
    name: "API-patch-page",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Update a page's properties or archive state.",
  },
  {
    id: "mcp.notion.API-move-page",
    name: "API-move-page",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Move a page to a different parent.",
  },
  {
    id: "mcp.notion.API-patch-block-children",
    name: "API-patch-block-children",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Append children to a block.",
  },
  {
    id: "mcp.notion.API-update-a-block",
    name: "API-update-a-block",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Update a block's contents.",
  },
  {
    id: "mcp.notion.API-create-a-comment",
    name: "API-create-a-comment",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Add a comment to a page or block.",
  },
  {
    id: "mcp.notion.API-create-a-data-source",
    name: "API-create-a-data-source",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create a new data source (database).",
  },
  {
    id: "mcp.notion.API-update-a-data-source",
    name: "API-update-a-data-source",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Update a data source's schema.",
  },
  // ── Destructive (API-*) ──────────────────────────────────────────────
  //   Notion soft-deletes (moves to trash with restore); HIGH rather
  //   than CRITICAL is consistent with the rest of the pack's
  //   reversible-but-disruptive class.
  {
    id: "mcp.notion.API-delete-a-block",
    name: "API-delete-a-block",
    risk: "HIGH",
    mode: "EXECUTE",
    description: "Archive a block (Notion soft-deletes to trash; restorable).",
  },
]);
