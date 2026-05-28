/**
 * Scaffold generator for `npx @strixgov/mcp-adapter init`.
 *
 * Pure function — takes options, returns the text of a runnable
 * `<server-name>-governed.mjs` file. No filesystem side effects here;
 * the CLI in `bin/strix-mcp-adapter.mjs` handles I/O so this module
 * stays trivially unit-testable.
 *
 * Output contract:
 *   1. Runs cleanly with `node <file>` in offline stub mode (zero edits).
 *   2. Prints signed receipts for 3 sample calls — the "magic moment".
 *   3. Marks the 5 things only the developer can fill in with
 *      `// TODO(strix):` blocks they can grep for.
 */

const KNOWN_COMPANION_PACKS = Object.freeze([
  "notion",
  "github",
  "slack",
  "linear",
  "filesystem",
  "postgres",
  "email",
]);

/** @returns {ReadonlyArray<string>} */
export function listKnownCompanionPacks() {
  return KNOWN_COMPANION_PACKS;
}

/**
 * @param {string} serverName
 * @returns {string | null}  matching companion-pack id, or null if unknown
 */
export function detectCompanionPack(serverName) {
  const normalised = String(serverName ?? "").trim().toLowerCase();
  if (!normalised) return null;
  return KNOWN_COMPANION_PACKS.includes(normalised) ? normalised : null;
}

/**
 * Generate the scaffold file contents.
 *
 * @param {{
 *   serverName: string,
 *   companionPack?: string | null,
 *   withConnectedMode?: boolean,
 * }} opts
 * @returns {string}
 */
export function renderScaffold(opts) {
  const serverName = String(opts.serverName ?? "").trim();
  if (!serverName) {
    throw new TypeError("renderScaffold: serverName is required");
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(serverName)) {
    throw new TypeError(
      `renderScaffold: serverName must match [A-Za-z][A-Za-z0-9_-]* — got '${serverName}'`,
    );
  }

  // Explicit `null` from the caller is a "do not use any pack" signal;
  // only fall back to detection when the caller didn't pass the option at
  // all. `??` would coerce null into "fall back" which is the wrong default.
  const pack = opts.companionPack !== undefined
    ? opts.companionPack
    : detectCompanionPack(serverName);
  const connectedMode = opts.withConnectedMode === true;

  return pack
    ? renderWithCompanionPack(serverName, pack, connectedMode)
    : renderWithoutCompanionPack(serverName, connectedMode);
}

// ─── Templates ────────────────────────────────────────────────────────────────

/**
 * @param {string} serverId
 * @param {string} pack
 * @param {boolean} connectedMode
 */
function renderWithCompanionPack(serverId, pack, connectedMode) {
  const importVar = `${pack}Capabilities`;
  const connectedBlock = renderConnectedModeBlock(connectedMode);
  const stubBlock = renderStubBlock(pack);

  return `/**
 * Governed ${serverId} MCP server — scaffolded by \`npx @strixgov/mcp-adapter init\`.
 *
 * Run as-is to see the governance loop in stub mode:
 *
 *   node ${serverId}-governed.mjs
 *
 * Then edit the 5 \`TODO(strix):\` blocks below to wire it to your real
 * MCP server. Each block is independently runnable — you can keep the
 * file running in stub mode while you fill them in.
 */

import { governMCPServer } from "@strixgov/mcp-adapter";
import { ${importVar} } from "@strixgov/capabilities-mcp-common/${pack}";

// ─── TODO(strix) 1/5 — connect to your real ${serverId} MCP server ───────────
//
// Replace the stub handlers below with calls to your live MCP server. The
// shape is { toolName: async (args) => result }. If your server already
// exposes { handler, listTools }, pass that object instead — the adapter
// accepts both shapes.

const toolHandlers = ${stubBlock};

// ─── TODO(strix) 2/5 — set your policy ───────────────────────────────────────
//
// Three knobs:
//   rules           — per-capability override (wins over riskOverrides)
//   riskOverrides   — coarse policy by companion-pack risk level
//   default         — what to do for tools the classifier hasn't seen
//
// Default below: every read auto-allowed, every write held for approval,
// CRITICAL denied, unknown tools denied. Tighten or loosen as needed.

const policy = {
  rules: {
    // "mcp.${serverId}.specific_dangerous_tool": "DENY",
  },
  riskOverrides: {
    LOW: "ALLOW",
    MEDIUM: "APPROVAL_REQUIRED",
    HIGH: "APPROVAL_REQUIRED",
    CRITICAL: "DENY",
  },
  default: "DENY",
};

// ─── TODO(strix) 3/5 — wire an approver ──────────────────────────────────────
//
// Defaulted to auto-approve so the scaffold runs unattended. In real
// deployments, replace \`prompt\` with a Slack webhook, Linear comment,
// PagerDuty page, or web UI. Return { approved, approver } from prompt.

const approval = {
  enabled: true,
  prompt: async (cap) => {
    console.log(\`  ⏸  approval needed for \${cap.id} — auto-approving in scaffold mode\`);
    return { approved: true, approver: "scaffold-auto-approver" };
  },
};

${connectedBlock}
// ─── Wire it up (no edits needed below this line) ────────────────────────────

const governed = governMCPServer(toolHandlers, {
  serverId: "${serverId}",
  capabilities: ${importVar},
  policy,
  approval,${connectedMode ? "\n  connectedMode," : ""}
});

const receipts = [];
governed.gateway.on("receipt", (r) => receipts.push(r));

// ─── TODO(strix) 5/5 — replace the sample calls with your real handler ───────
//
// In a real server, you'd call \`governed.callTool(name, args, { actorId })\`
// from your MCP request handler. The block below proves the governance loop
// works end-to-end on the scaffold's stub handlers.

const samples = [
  { name: "${pickSampleTool(pack, "READ")}",  args: ${pickSampleArgs(pack, "READ")},  expect: "ALLOW" },
  { name: "${pickSampleTool(pack, "WRITE")}", args: ${pickSampleArgs(pack, "WRITE")}, expect: "ALLOW (after approval)" },
  { name: "${pickSampleTool(pack, "UNKNOWN")}", args: {}, expect: "DENY (heuristic CRITICAL)" },
];

for (const sample of samples) {
  try {
    const result = await governed.callTool(sample.name, sample.args, {
      actorId: "scaffold-actor",
    });
    const preview = JSON.stringify(result).slice(0, 60);
    console.log(\`  ✓ \${sample.name.padEnd(30)} → ALLOW  \${preview}\`);
  } catch (err) {
    console.log(\`  ✗ \${sample.name.padEnd(30)} → \${err.code ?? "ERROR"}\`);
  }
}

console.log(\`\\n─── \${receipts.length} signed receipts ───────────────────────────\`);
for (const r of receipts) {
  const sigPreview = r.signature ? r.signature.slice(0, 16) + "…" : "<missing>";
  console.log(\`  \${r.decision.padEnd(8)} \${r.capabilityId.padEnd(28)} sig=\${sigPreview}\`);
}

console.log("\\nVerify the same receipts offline with:");
console.log("  npx @strixgov/verifier chain <path-to-receipts.jsonl>");
console.log("\\nNext: grep this file for 'TODO(strix)' and fill in the 5 blocks.");
`;
}

/**
 * @param {string} serverId
 * @param {boolean} connectedMode
 */
function renderWithoutCompanionPack(serverId, connectedMode) {
  const connectedBlock = renderConnectedModeBlock(connectedMode);
  // Hyphens are legal in serverId (matches Notion's "my-internal-server")
  // but not in JS identifiers, so derive a safe const name.
  const capsVar = `${toIdentifier(serverId)}Capabilities`;

  return `/**
 * Governed ${serverId} MCP server — scaffolded by \`npx @strixgov/mcp-adapter init\`.
 *
 * No companion pack ships for '${serverId}' yet, so this scaffold inlines
 * a starter capabilities array. Run as-is to see the governance loop:
 *
 *   node ${serverId}-governed.mjs
 *
 * Then edit the 5 \`TODO(strix):\` blocks below.
 *
 * Capability risk levels:
 *   LOW READ        — pure reads with no PII / cost surface
 *   MEDIUM READ     — bulk reads (e.g. \`SELECT *\`) that could exfiltrate
 *   MEDIUM WRITE    — reversible writes
 *   HIGH WRITE      — destructive writes with no easy undo
 *   CRITICAL EXEC   — arbitrary code / shell / privileged ops
 */

import { governMCPServer } from "@strixgov/mcp-adapter";

// ─── TODO(strix) 1/5 — inline your capability classifications ────────────────
//
// One entry per tool your MCP server exposes. The adapter falls back to a
// heuristic for any tool not listed here (default: CRITICAL EXECUTE → DENY).
// Conservative: classify every tool you ship before you go to production.

const ${capsVar} = Object.freeze([
  {
    id: "mcp.${serverId}.example_read",
    name: "example_read",
    risk: "LOW",
    mode: "READ",
    description: "TODO(strix): describe what this tool actually reads.",
  },
  {
    id: "mcp.${serverId}.example_write",
    name: "example_write",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "TODO(strix): describe what this tool writes.",
  },
]);

// ─── TODO(strix) 2/5 — connect to your real ${serverId} MCP server ───────────
//
// Replace the stubs with calls to your live MCP server. The shape is
// { toolName: async (args) => result }. If your server exposes
// { handler, listTools }, pass that object instead.

const toolHandlers = {
  example_read: async (args) => {
    // TODO(strix): call your real read here.
    return { ok: true, args, stub: true };
  },
  example_write: async (args) => {
    // TODO(strix): call your real write here.
    return { ok: true, args, stub: true };
  },
};

// ─── TODO(strix) 3/5 — set your policy ───────────────────────────────────────

const policy = {
  rules: {
    // "mcp.${serverId}.specific_dangerous_tool": "DENY",
  },
  riskOverrides: {
    LOW: "ALLOW",
    MEDIUM: "APPROVAL_REQUIRED",
    HIGH: "APPROVAL_REQUIRED",
    CRITICAL: "DENY",
  },
  default: "DENY",
};

// ─── TODO(strix) 4/5 — wire an approver ──────────────────────────────────────

const approval = {
  enabled: true,
  prompt: async (cap) => {
    console.log(\`  ⏸  approval needed for \${cap.id} — auto-approving in scaffold mode\`);
    return { approved: true, approver: "scaffold-auto-approver" };
  },
};

${connectedBlock}
// ─── Wire it up (no edits needed below this line) ────────────────────────────

const governed = governMCPServer(toolHandlers, {
  serverId: "${serverId}",
  capabilities: ${capsVar},
  policy,
  approval,${connectedMode ? "\n  connectedMode," : ""}
});

const receipts = [];
governed.gateway.on("receipt", (r) => receipts.push(r));

// ─── TODO(strix) 5/5 — replace the sample calls with your real handler ───────

const samples = [
  { name: "example_read",  args: { id: "demo" }, expect: "ALLOW" },
  { name: "example_write", args: { id: "demo", value: 1 }, expect: "ALLOW (after approval)" },
  { name: "unknown_tool",  args: {}, expect: "DENY (heuristic CRITICAL)" },
];

for (const sample of samples) {
  try {
    const result = await governed.callTool(sample.name, sample.args, {
      actorId: "scaffold-actor",
    });
    const preview = JSON.stringify(result).slice(0, 60);
    console.log(\`  ✓ \${sample.name.padEnd(20)} → ALLOW  \${preview}\`);
  } catch (err) {
    console.log(\`  ✗ \${sample.name.padEnd(20)} → \${err.code ?? "ERROR"}\`);
  }
}

console.log(\`\\n─── \${receipts.length} signed receipts ───────────────────────────\`);
for (const r of receipts) {
  const sigPreview = r.signature ? r.signature.slice(0, 16) + "…" : "<missing>";
  console.log(\`  \${r.decision.padEnd(8)} \${r.capabilityId.padEnd(28)} sig=\${sigPreview}\`);
}

console.log("\\nVerify the same receipts offline with:");
console.log("  npx @strixgov/verifier chain <path-to-receipts.jsonl>");
console.log("\\nNext: grep this file for 'TODO(strix)' and fill in the 5 blocks.");
`;
}

/**
 * Convert a server name (which may contain hyphens) into a safe JS identifier.
 * @param {string} name
 */
function toIdentifier(name) {
  return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

/** @param {boolean} connectedMode */
function renderConnectedModeBlock(connectedMode) {
  if (!connectedMode) {
    return `// ─── (Connected mode is off — pass --with-connected-mode to scaffold it) ─────
`;
  }
  return `// ─── TODO(strix) 4b/5 — connected mode (optional) ────────────────────────────
//
// When STRIX_API_KEY + STRIX_TENANT_ID are set, receipts ALSO sync to
// strixgov.com in the background. Local execution is never blocked on
// the network — fail-closed only applies to the local signing key.

const connectedMode = process.env.STRIX_API_KEY && process.env.STRIX_TENANT_ID
  ? {
      kernelUrl: process.env.STRIX_KERNEL_URL ?? "https://www.strixgov.com",
      apiKey: process.env.STRIX_API_KEY,
      tenantId: process.env.STRIX_TENANT_ID,
    }
  : undefined;

`;
}

/**
 * Pick a representative tool from a known companion pack for the sample
 * call block. Kept inline so the scaffold has no runtime dependency on
 * the pack — it's a string lookup at template time.
 *
 * @param {string} pack
 * @param {"READ"|"WRITE"|"UNKNOWN"} mode
 */
function pickSampleTool(pack, mode) {
  const tools = SAMPLE_TOOLS[pack] ?? {};
  if (mode === "UNKNOWN") return `unknown_${pack}_tool`;
  return tools[mode] ?? (mode === "READ" ? "example_read" : "example_write");
}

/**
 * @param {string} pack
 * @param {"READ"|"WRITE"} mode
 */
function pickSampleArgs(pack, mode) {
  const args = SAMPLE_ARGS[pack] ?? {};
  return args[mode] ?? "{}";
}

// Hand-picked sample tools that exist in every companion pack today.
// Match the on-the-wire name (with the server prefix where the pack uses one).
const SAMPLE_TOOLS = Object.freeze({
  notion:     { READ: "notion-fetch",        WRITE: "notion-create-comment" },
  github:     { READ: "get_file_contents",   WRITE: "create_issue" },
  slack:      { READ: "slack_list_channels", WRITE: "slack_post_message" },
  linear:     { READ: "list_issues",         WRITE: "create_comment" },
  filesystem: { READ: "read_file",           WRITE: "write_file" },
  postgres:   { READ: "query",               WRITE: "execute" },
  email:      { READ: "list_messages",       WRITE: "send_email" },
});

const SAMPLE_ARGS = Object.freeze({
  notion:     { READ: `{ id: "doc_demo" }`,             WRITE: `{ pageId: "doc_demo", body: "hello" }` },
  github:     { READ: `{ owner: "o", repo: "r", path: "README.md" }`, WRITE: `{ owner: "o", repo: "r", title: "demo", body: "from scaffold" }` },
  slack:      { READ: `{}`,                             WRITE: `{ channel: "#demo", text: "hello from strix" }` },
  linear:     { READ: `{}`,                             WRITE: `{ issueId: "DEMO-1", body: "scaffold ran" }` },
  filesystem: { READ: `{ path: "/tmp/demo.txt" }`,      WRITE: `{ path: "/tmp/demo.txt", content: "from scaffold" }` },
  postgres:   { READ: `{ sql: "SELECT 1" }`,            WRITE: `{ sql: "UPDATE demo SET v=1 WHERE id=1" }` },
  email:      { READ: `{}`,                             WRITE: `{ to: "demo@example.com", subject: "hi", body: "scaffold" }` },
});

/**
 * Companion-pack-aware stub handler block. Used only when a companion
 * pack matched — the developer is expected to swap these for real calls.
 * @param {string} pack
 */
function renderStubBlock(pack) {
  const reads = SAMPLE_TOOLS[pack]?.READ ?? "example_read";
  const writes = SAMPLE_TOOLS[pack]?.WRITE ?? "example_write";
  return `{
  "${reads}":  async (args) => ({ ok: true, op: "${reads}",  args, stub: true }),
  "${writes}": async (args) => ({ ok: true, op: "${writes}", args, stub: true }),
}`;
}
