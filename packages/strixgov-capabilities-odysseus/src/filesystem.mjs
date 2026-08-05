/**
 * Odysseus host surface — workspace file operations.
 *
 * Risk model (mirrors @strixgov/capabilities-mcp-common/filesystem):
 *   - Reads and listings are LOW READ — sensitive but state-preserving.
 *   - Writes are HIGH: the workspace filesystem is the agent's
 *     persistence layer, and a clobbered file has no undo path unless
 *     the operator runs their own versioning.
 *   - Deletes are HIGH: reversibility depends entirely on host-side
 *     trash semantics, which the pack cannot assume.
 *
 * Interception: `host-hook` — Odysseus's native file tools do not pass
 * through an MCP boundary. If the operator instead wires a filesystem
 * MCP server, the mcp-common filesystem pack + @strixgov/mcp-proxy
 * cover that path today.
 */
export const filesystemCapabilities = Object.freeze([
  {
    id: "odysseus.file.read",
    name: "file.read",
    risk: "LOW",
    mode: "READ",
    interception: "host-hook",
    description: "Read a file in the workspace.",
  },
  {
    id: "odysseus.file.list",
    name: "file.list",
    risk: "LOW",
    mode: "READ",
    interception: "host-hook",
    description: "List files or directories in the workspace.",
  },
  {
    id: "odysseus.file.write",
    name: "file.write",
    risk: "HIGH",
    mode: "WRITE",
    interception: "host-hook",
    description:
      "Create or overwrite a file in the workspace. Overwrites have no undo path at the pack layer.",
  },
  {
    id: "odysseus.file.delete",
    name: "file.delete",
    risk: "HIGH",
    mode: "WRITE",
    interception: "host-hook",
    description:
      "Delete a file in the workspace. Reversibility is host-dependent; classified as if irreversible.",
  },
]);
