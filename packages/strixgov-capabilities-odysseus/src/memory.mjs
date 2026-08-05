/**
 * Odysseus host surface — persistent memory.
 *
 * Risk model:
 *   - Reads are LOW READ.
 *   - Writes are MEDIUM WRITE, with a rationale worth spelling out:
 *     persistent memory is a known prompt-injection PERSISTENCE vector.
 *     A poisoned memory entry steers every future session that loads
 *     it. The mutation itself is reversible (hence MEDIUM, not HIGH),
 *     but it should never be auto-allowed without evidence — the
 *     suggested policy routes all non-LOW writes through approval.
 *   - Deletes are MEDIUM WRITE (destroys context; recoverable only if
 *     the operator snapshots the store).
 *
 * Interception: `host-hook` — Odysseus's memory store is a native path.
 */
export const memoryCapabilities = Object.freeze([
  {
    id: "odysseus.memory.read",
    name: "memory.read",
    risk: "LOW",
    mode: "READ",
    interception: "host-hook",
    description: "Read entries from the workspace's persistent memory.",
  },
  {
    id: "odysseus.memory.write",
    name: "memory.write",
    risk: "MEDIUM",
    mode: "WRITE",
    interception: "host-hook",
    description:
      "Write or update a persistent memory entry. Injection-persistence vector: a poisoned entry steers future sessions.",
  },
  {
    id: "odysseus.memory.delete",
    name: "memory.delete",
    risk: "MEDIUM",
    mode: "WRITE",
    interception: "host-hook",
    description: "Delete a persistent memory entry.",
  },
]);
