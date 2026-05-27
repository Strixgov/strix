/**
 * Filesystem MCP server — capability classifications.
 *
 * Targets the official reference implementation at
 * https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem
 * (npm: `@modelcontextprotocol/server-filesystem`). The reference server
 * exposes underscore-prefixed tool names (e.g. `read_file`) — no
 * server-prefix in the name, matching the GitHub convention rather than
 * Notion's.
 *
 * Risk model — every filesystem operation has a real blast radius
 * because "the filesystem" is the agent's persistence layer:
 *
 *   - All read-shaped ops (`read_*`, `list_*`, `search_*`, `directory_tree`,
 *     `get_file_info`, `list_allowed_directories`) are LOW READ. The MCP
 *     server is already path-gated by the operator's allowed-directories
 *     config — reads outside that scope cannot happen at the MCP layer.
 *   - `write_file` and `edit_file` are MEDIUM WRITE. `write_file`
 *     silently overwrites existing files — operators who want strict
 *     overwrite protection should DENY this capability and require the
 *     agent to use `edit_file` (which fails if the target doesn't exist
 *     or doesn't match the expected before-block).
 *   - `create_directory` is MEDIUM WRITE. Low surface but a directory
 *     creation in the wrong scope can clutter or shadow expected paths.
 *   - `move_file` is HIGH WRITE. Move is rename-or-clobber depending
 *     on target existence; an unintended overwrite of a sibling file is
 *     hard to undo after the fact. APPROVAL_REQUIRED by default is the
 *     right discipline for agent workflows.
 *
 * What is NOT in this pack (deliberately):
 *
 *   - `delete_*` / `remove_*` / `unlink` — the reference server does not
 *     ship a delete tool. If your fork adds one, the heuristic fallback
 *     in `@strixgov/tool-gateway` classifies it CRITICAL WRITE and the
 *     fail-closed `default: "DENY"` policy blocks it. If you want to
 *     explicitly allow scoped deletes, add a per-capability rule in your
 *     policy — don't extend this pack.
 *   - `symlink` / `chmod` / `chown` — same: not in the reference server,
 *     but if a fork adds them they should classify CRITICAL EXECUTE.
 *     `symlink-then-write` is a documented kernel-escape pattern; the
 *     heuristic correctly treats unknown ops at CRITICAL EXECUTE so a
 *     default-DENY policy prevents accidental enablement.
 *
 * If your filesystem MCP server adds tools beyond the reference set,
 * verify the heuristic fallback's classification before deploying with
 * `default: "ALLOW"`. The discipline that backs the Mode 1 claim
 * ("Strix fails closed on anything unclassified") only holds if your
 * policy is fail-closed.
 */
export const filesystemCapabilities = Object.freeze([
  // ── Reads ────────────────────────────────────────────────────────────
  {
    id: "mcp.filesystem.read_file",
    name: "read_file",
    risk: "LOW",
    mode: "READ",
    description: "Read the full contents of a file.",
  },
  {
    id: "mcp.filesystem.read_multiple_files",
    name: "read_multiple_files",
    risk: "LOW",
    mode: "READ",
    description: "Read multiple files in one call.",
  },
  {
    id: "mcp.filesystem.list_directory",
    name: "list_directory",
    risk: "LOW",
    mode: "READ",
    description: "List the contents of a directory.",
  },
  {
    id: "mcp.filesystem.directory_tree",
    name: "directory_tree",
    risk: "LOW",
    mode: "READ",
    description: "Recursive directory tree as a structured response.",
  },
  {
    id: "mcp.filesystem.search_files",
    name: "search_files",
    risk: "LOW",
    mode: "READ",
    description: "Glob/regex search for files under a path.",
  },
  {
    id: "mcp.filesystem.get_file_info",
    name: "get_file_info",
    risk: "LOW",
    mode: "READ",
    description: "Metadata (size, mtime, permissions) for a single file.",
  },
  {
    id: "mcp.filesystem.list_allowed_directories",
    name: "list_allowed_directories",
    risk: "LOW",
    mode: "READ",
    description: "List the root paths the MCP server is allowed to operate within.",
  },

  // ── Writes ───────────────────────────────────────────────────────────
  {
    id: "mcp.filesystem.write_file",
    name: "write_file",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Write content to a file. Silently overwrites if the file exists.",
  },
  {
    id: "mcp.filesystem.edit_file",
    name: "edit_file",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Edit a file with line-based diffs. Fails if the before-block doesn't match.",
  },
  {
    id: "mcp.filesystem.create_directory",
    name: "create_directory",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create a new directory (and any missing parents).",
  },

  // ── Higher-risk writes ───────────────────────────────────────────────
  {
    id: "mcp.filesystem.move_file",
    name: "move_file",
    risk: "HIGH",
    mode: "WRITE",
    description: "Move or rename a file. May silently clobber an existing file at the destination.",
  },
]);
