# @strixgov/capabilities-claude-code

Pre-classified capability registry for Claude Code's built-in tool surface.
Drop-in starter for [`@strixgov/tool-gateway`](../tool-gateway).

```bash
npm install @strixgov/capabilities-claude-code @strixgov/tool-gateway
```

## What's in it

16 capabilities covering Claude Code's tool surface, each with a risk
classification and read/write/execute mode:

| Capability | Risk | Mode | Notes |
|---|---|---|---|
| `claude.read` | LOW | READ | File read |
| `claude.glob` | LOW | READ | List files by pattern |
| `claude.grep` | LOW | READ | Search file contents |
| `claude.write` | MEDIUM | WRITE | Create/overwrite file |
| `claude.edit` | MEDIUM | WRITE | Replace string in file |
| `claude.notebook_edit` | MEDIUM | WRITE | Edit notebook cell |
| `claude.bash` | HIGH | EXECUTE | Shell command (consider CRITICAL on prod) |
| `claude.task` | MEDIUM | EXECUTE | Spawn subagent |
| `claude.web_fetch` | MEDIUM | EXECUTE | External HTTP read |
| `claude.web_search` | LOW | READ | Web search |
| `claude.tool_search` | LOW | READ | Deferred-tool lookup |
| `claude.monitor` | LOW | READ | Stream from background process |
| `claude.todo_write` | LOW | WRITE | Internal task list |
| `claude.exit_plan_mode` | LOW | EXECUTE | UI control |
| `claude.ask_user_question` | LOW | EXECUTE | Prompt user |
| `claude.skill` | MEDIUM | EXECUTE | Invoke configured skill |

## NSA MCP report alignment

NSA Cybersecurity Information [`U/OO/6030316-26 | PP-26-1834 | May 2026 Ver. 1.0`](https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/4192261/nsa-releases-cybersecurity-information-on-security-considerations-for-the-model/)
names `bash`/shell, code-execution, and file-write tool surfaces as the
high-risk dispatch points where command-injection (CWE-77 / CWE-78) and
code-injection (CWE-94 / CWE-95) attacks fire. This package's
classification (`claude.bash` HIGH/EXECUTE with the "consider CRITICAL
on prod" annotation; `claude.write` / `claude.edit` MEDIUM/WRITE;
`claude.task` MEDIUM/EXECUTE) makes those boundaries explicit so the
`suggestedPolicy()` fails closed at exactly the dispatch points the
NSA report flags. The durable map from each NSA-named concern to the
file + invariant that addresses it lives at
[`docs/launch/2026-05-23-nsa-mcp-technical-companion.md`](https://github.com/Strixgov/strix/blob/main/docs/launch/2026-05-23-nsa-mcp-technical-companion.md).

## Usage

```js
import { createGateway } from "@strixgov/tool-gateway";
import {
  claudeCodeCapabilityMap,
  suggestedPolicy,
} from "@strixgov/capabilities-claude-code";

const gateway = createGateway({
  capabilities: claudeCodeCapabilityMap(),
  policy: suggestedPolicy(),         // strict baseline; override per env
  // ... signingKey/keyRing, storage, etc
});
```

`suggestedPolicy()` is deliberately strict: reads `ALLOW`, writes/Bash
`APPROVAL_REQUIRED`, `default: DENY`. Override before passing to the
gateway if your environment has different baselines.

## Persisting as a signed manifest

Share the same classifications across multiple agent processes on one host:

```js
import { saveCapabilityRegistry, loadOrCreateKeyRing } from "@strixgov/tool-gateway";
import { claudeCodeCapabilities } from "@strixgov/capabilities-claude-code";

const ring = await loadOrCreateKeyRing();
await saveCapabilityRegistry({
  signingKey: ring.active,
  capabilities: claudeCodeCapabilities,
});
```

## License

MIT
