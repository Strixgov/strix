# Changelog

All notable changes to `@strixgov/capabilities-mcp-common` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2]

### Fixed
- `peerDependencies["@strixgov/tool-gateway"]` was published as `^0.4.1`,
  which SEMVER-excludes `@strixgov/tool-gateway@0.5.0` (the release that
  fixed a `terminalApprove` stdout-write defect affecting headless callers,
  most notably `@strixgov/mcp-proxy`). The in-repo workspace range was
  corrected to `^0.5.0` in the 0.5.0 release commit, but that fix never
  reached npm because this package wasn't republished alongside it — the
  live `0.1.1` package.json still declared `^0.4.1`. This release carries
  no other change; it exists solely to publish the already-corrected range.
  The dependency is optional (`peerDependenciesMeta.optional: true`), so
  the impact was a peer-dependency warning under strict peer resolution,
  not a hard install failure.

## [0.1.1]

Notion pack updated to match the modern `@notionhq/notion-mcp-server`
naming convention, surfaced when a real Claude Desktop dogfood run
showed every Notion tool call falling through to the heuristic
classifier (and therefore getting denied by the MEDIUM→APPROVAL_REQUIRED
rule), because none of the upstream's tool names matched the pack.

### Added
- **22 new Notion capability classifications** for the modern
  `API-*` naming convention emitted by current `@notionhq/notion-mcp-server`:
  - **13 reads (LOW READ)**: `API-get-self`, `API-get-user`,
    `API-get-users`, `API-retrieve-a-page`,
    `API-retrieve-a-page-property`, `API-retrieve-a-block`,
    `API-get-block-children`, `API-retrieve-a-database`,
    `API-retrieve-a-data-source`, `API-query-data-source`,
    `API-list-data-source-templates`, `API-retrieve-a-comment`,
    `API-post-search`.
  - **8 writes (MEDIUM WRITE)**: `API-post-page`, `API-patch-page`,
    `API-move-page`, `API-patch-block-children`, `API-update-a-block`,
    `API-create-a-comment`, `API-create-a-data-source`,
    `API-update-a-data-source`.
  - **1 destructive (HIGH EXECUTE)**: `API-delete-a-block`. HIGH
    rather than CRITICAL because Notion soft-deletes to trash with
    restore (consistent with the rest of the pack's
    reversible-but-disruptive class).
- The older `notion-*` classifications are **retained** so existing
  users wrapping older Notion MCP servers or community wrappers
  aren't broken. The proxy's `cap.name` lookup means the two
  conventions never collide.
- Total Notion pack size: 16 → 38 tools. Total registry: 107 → 129.

### Verification
- All registry-wide invariants (sum-of-parts, uniqueness, canonical
  shape, delete-style-ops-at-least-HIGH, suggested-policy semantics)
  hold. `API-delete-a-block` correctly classified HIGH, picked up by
  the "delete-style ops are at least HIGH" pin.
- Verified empirically against a real Claude Desktop + proxy + Notion
  flow: `API-get-self` now matches the pack as LOW READ and resolves
  to ALLOW under `suggestedPolicy()`, instead of falling through to
  the MEDIUM heuristic and getting denied.

## [0.1.0]

Initial release. Pre-first-publish discipline: this version was never
on npm under any other shape; the 7-pack contents below are the state
going into the first publish.

### Added
- Pre-classified capability registry for **107 tools across seven MCP
  servers**:
  - **Slack** (`mcp.slack.*`, 13 tools)
  - **GitHub** (`mcp.github.*`, ~30 tools)
  - **Linear** (`mcp.linear.*`, 10 tools)
  - **Notion** (`mcp.notion.*`, ~16 tools)
  - **Filesystem** (`mcp.filesystem.*`, 11 tools) — schema/read LOW,
    write/edit MEDIUM, move HIGH. delete/symlink/chmod deliberately
    absent (heuristic CRITICAL handles them).
  - **Postgres** (`mcp.postgres.*`, 14 tools) — schema LOW, SELECT
    MEDIUM (exfiltration discipline — not auto-allowed), write/DDL
    HIGH. drop/truncate/arbitrary-SQL deliberately absent.
  - **Email / SMTP / Gmail** (`mcp.email.*`, 17 tools) — mailbox reads
    LOW, reversible mutations MEDIUM, send/reply/forward HIGH
    (irreversible once delivered), delete_email HIGH.
- Per-server entry points (`./slack`, `./github`, `./linear`,
  `./notion`, `./filesystem`, `./postgres`, `./email`) in addition to
  the bundled `mcpCapabilityMap()` + `allMcpCapabilities` exports.
- `suggestedPolicy()` starter rule set with **risk-aware defaults**:
  CRITICAL → DENY, LOW READ → ALLOW, MEDIUM/HIGH READ →
  APPROVAL_REQUIRED, WRITE/EXECUTE → APPROVAL_REQUIRED, default →
  DENY. Importantly, this does NOT auto-allow every READ — the
  Postgres pack's MEDIUM-classified SELECT shifted the discipline so
  exfiltration vectors require approval rather than passing through
  silently.

### Test surface
- 37 tests under `node --test`:
  - Registry-wide invariants (sum-of-parts, namespacing, canonical
    shape, suggested-policy semantics, types-parity)
  - Postgres-specific risk-model pins (schema LOW READ, SELECT MEDIUM
    READ, write/DDL HIGH WRITE, drop/truncate explicit absence)
  - Email-specific risk-model pins (mailbox LOW, send/reply HIGH
    irreversible, per-recipient + admin-destructive explicit absence)
  - Filesystem-specific risk-model pins (write_file MEDIUM rationale,
    delete/symlink absence)

### Intended-to-be-overridden
These are starter classifications. Override per-environment before
shipping:

```js
const caps = mcpCapabilityMap();
caps["mcp.github.push_files"].risk = "CRITICAL"; // never touch default branch
caps["mcp.postgres.query"].risk = "HIGH";        // prod DB is read-restricted
```
