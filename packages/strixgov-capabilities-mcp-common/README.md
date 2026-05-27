# @strixgov/capabilities-mcp-common

Pre-classified capability registry for popular MCP servers — Slack,
GitHub, Linear, Notion, Filesystem, Postgres, Email. Drop-in starter
for [`@strixgov/tool-gateway`](https://www.npmjs.com/package/@strixgov/tool-gateway)
and [`@strixgov/mcp-adapter`](https://www.npmjs.com/package/@strixgov/mcp-adapter).

```bash
npm install @strixgov/capabilities-mcp-common @strixgov/tool-gateway
```

## What's in it

Capability IDs follow the convention `mcp.<server>.<tool>`. **129
classifications across seven servers**:

- **Slack** — `mcp.slack.*` (13 tools): reads LOW, outbound messages
  and canvases MEDIUM, drafts LOW.
- **GitHub** — `mcp.github.*` (~30 tools): reads/listings LOW, comments
  and branch ops MEDIUM, push/PR creation HIGH, **merge_pull_request
  CRITICAL** (irreversible).
- **Linear** — `mcp.linear.*` (10 tools): reads LOW, mutations MEDIUM,
  delete HIGH.
- **Notion** — `mcp.notion.*` (38 tools): reads LOW, page/database
  mutations MEDIUM, `API-delete-a-block` HIGH. Pack covers **both**
  Notion's older `notion-*` tool-naming convention (`notion-fetch`,
  `notion-create-pages`, ...) **and** the modern `@notionhq/notion-mcp-server`
  `API-*` convention (`API-retrieve-a-page`, `API-post-search`, ...)
  so the same pack matches whichever upstream you're wrapping.
- **Filesystem** — `mcp.filesystem.*` (11 tools): schema introspection
  LOW, write/edit MEDIUM, move_file HIGH. delete/symlink/chmod
  deliberately absent — heuristic CRITICAL handles them.
- **Postgres** — `mcp.postgres.*` (14 tools): schema introspection LOW,
  **SELECT MEDIUM (exfiltration discipline — not auto-allowed)**,
  write_query / DDL HIGH. drop/truncate/arbitrary-SQL deliberately
  absent.
- **Email/SMTP/Gmail** — `mcp.email.*` (17 tools): mailbox reads LOW,
  reversible mutations MEDIUM, **send_email / reply / forward HIGH
  (irreversible once delivered)**, delete_email HIGH.

## NSA MCP report alignment

NSA Cybersecurity Information [`U/OO/6030316-26 | PP-26-1834 | May 2026 Ver. 1.0`](https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/4192261/nsa-releases-cybersecurity-information-on-security-considerations-for-the-model/)
warns that MCP's flexible-by-design protocol leaves per-call admission
decisions to implementers — and that many MCP server implementations
do not ship with a deny-by-default posture. This package is the
**default-deny starter** for the seven popular MCP servers it covers:
129 tools pre-classified by risk tier (LOW / MEDIUM / HIGH / CRITICAL)
with READ / WRITE / EXECUTE annotations, and a `suggestedPolicy()`
that fails closed on unknown tools. Operators can override per-tool;
the discipline is that overrides are explicit and auditable, not
inherited from "no policy was defined." The durable map from each
NSA-named concern to the file + invariant that addresses it lives at
[`docs/launch/2026-05-23-nsa-mcp-technical-companion.md`](https://github.com/Strixgov/strix/blob/main/docs/launch/2026-05-23-nsa-mcp-technical-companion.md).

## Suggested-policy semantics

`suggestedPolicy()` applies risk-aware defaults:

- **CRITICAL** → DENY (operator must explicitly elevate)
- **LOW READ** → ALLOW (schema introspection, file listing, mailbox
  reads — structurally safe)
- **MEDIUM / HIGH READ** → APPROVAL_REQUIRED (Postgres SELECT and
  similar — auto-allow would expose exfiltration vectors)
- **WRITE / EXECUTE at any non-CRITICAL risk** → APPROVAL_REQUIRED
- **Default** → DENY (fail-closed for any unclassified tool)

This intentionally **does NOT** auto-allow every READ — that discipline
shift happened when the Postgres pack landed, because `SELECT * FROM
users` is the most common privacy-incident vector and pinning it at
LOW READ would silently weaken the default deployment posture.

## Usage

Pull the whole common set:

```js
import { createGateway } from "@strixgov/tool-gateway";
import {
  mcpCapabilityMap,
  suggestedPolicy,
} from "@strixgov/capabilities-mcp-common";

const gateway = createGateway({
  capabilities: mcpCapabilityMap(),
  policy: suggestedPolicy(),
  // ...
});
```

Or just one server:

```js
import { slackCapabilities }      from "@strixgov/capabilities-mcp-common/slack";
import { githubCapabilities }     from "@strixgov/capabilities-mcp-common/github";
import { linearCapabilities }     from "@strixgov/capabilities-mcp-common/linear";
import { notionCapabilities }     from "@strixgov/capabilities-mcp-common/notion";
import { filesystemCapabilities } from "@strixgov/capabilities-mcp-common/filesystem";
import { postgresCapabilities }   from "@strixgov/capabilities-mcp-common/postgres";
import { emailCapabilities }      from "@strixgov/capabilities-mcp-common/email";
```

Compose with the Claude Code companion pack:

```js
import { claudeCodeCapabilities } from "@strixgov/capabilities-claude-code";
import { allMcpCapabilities } from "@strixgov/capabilities-mcp-common";

const capabilities = Object.fromEntries(
  [...claudeCodeCapabilities, ...allMcpCapabilities].map((c) => [c.id, c]),
);
```

## Override before shipping

These are starter classifications. Override per-environment:

```js
import { mcpCapabilityMap } from "@strixgov/capabilities-mcp-common";

const caps = mcpCapabilityMap();
// Production: never touch the default branch automatically.
caps["mcp.github.push_files"].risk = "CRITICAL";
caps["mcp.github.create_pull_request"].risk = "CRITICAL";
```

## License

MIT
