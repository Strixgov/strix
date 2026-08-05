# Claude Code Governance Pack — by Strix

[![governed by Strix](./assets/governed-by-strix.svg)](https://github.com/Strixgov/strix/tree/main/packages/strixgov-claude-code)

**Your AI coding agent can no longer `rm -rf`, push to production, delete files,
run migrations, or deploy — without governance.**

```sh
npx @strixgov/claude-code init     # then restart Claude Code
```

Five minutes. No fork. No workflow change. The only file touched is
`.claude/settings.json`.

```
Claude Code  ──(Bash / Edit / Write / …)──►  Strix PreToolUse hook
                                                │ classify → policy → decide
                                                ▼
                                  allow · ask (approval) · deny
                                  + Ed25519-signed decision receipt
                                  verifiable by `npx @strixgov/verifier`
```

Strix is not a replacement agent. It is the execution-control kernel that sits
between the agent's intent and the side effect: dangerous tools become
non-bypassable, and every governed decision becomes signed, independently
checkable evidence.

## See your coverage

```sh
npx @strixgov/claude-code doctor
```

```
Analyzing Claude Code governance…

  PreToolUse hook: installed ✓

  ✓ Read             READ     allowed + evidence
  🔒 Bash            EXECUTE  governed (approval)
  🔒 Write           WRITE    governed (approval)
  🔒 Edit            WRITE    governed (approval)
  🔒 Task            EXECUTE  governed (approval)
  ...

  Coverage (dangerous tools governed): ██████████ 100%
    7/7 of Bash/Edit/Write/NotebookEdit/Task/WebFetch/Skill gated
```

## What this Pack governs (and the precise boundary)

**v1 governs the tool-execution surface Claude Code exposes through its
PreToolUse hook** — the built-in tools: `Bash`, `Edit`, `Write`,
`NotebookEdit`, `Task`, `WebFetch`, `Skill`, `Read`, `Glob`, `Grep`, … A
DENY/ASK is enforced by Claude Code holding/refusing the call **before it
runs** — the side effect does not happen.

> **Claim discipline.** Strix governs *the tool-execution surfaces Claude Code
> exposes* — not "Claude Code" in the abstract. The receipt records the governed
> **decision** (capability, risk, policy version, signed); it does not assert
> the tool's post-hoc *result*. Unknown/unclassified tools **fail closed**
> (deny). As Claude Code adds interception APIs, the Pack expands to match.

**Coming next:** governing the *external MCP servers* Claude Code connects to
(filesystem, GitHub, Notion, …) via [`@strixgov/mcp-proxy`](https://www.npmjs.com/package/@strixgov/mcp-proxy)
— a separate, also-real interception point. v1 is deliberately PreToolUse-only
to keep the install one step.

## The default policy (override anytime)

From `@strixgov/capabilities-claude-code` (`suggestedPolicy()`):

- **ALLOW** (with signed evidence): `Read`, `Glob`, `Grep`, `WebSearch`, `ToolSearch`, `Monitor`, `TodoWrite`, `ExitPlanMode`, `AskUserQuestion`
- **APPROVAL_REQUIRED** → Claude Code prompts you: `Write`, `Edit`, `NotebookEdit`, `Bash`, `Task`, `WebFetch`, `Skill`
- **default**: `DENY` (fail-closed)

Tighten any rule (e.g. ban shell entirely → `claude.bash: DENY`). Inspect the
effective policy: `npx @strixgov/claude-code policy`.

## Three demos

1. **Governed execution** — a `Read` runs and a signed receipt is written to
   `.strix/claude-code/receipts.jsonl`.
2. **Held branch** — a `Bash` call returns `ask` (or `deny` if you tightened
   it); the command does not run until you approve.
3. **Independent verification** — `npx @strixgov/verifier <receiptId>`
   re-derives the decision from the signed receipt with zero shared code.

## Benchmark — run the attacks yourself

```sh
npx @strixgov/claude-code benchmark            # human report
npx @strixgov/claude-code benchmark --json     # machine-readable
npx @strixgov/claude-code benchmark --out ./benchmark-results
```

Runs an adversarial corpus of ~100 tool-call attempts an agent might make
(force-delete, `git push --force`, secret exfiltration, `curl | sh`,
`terraform destroy`, `DROP TABLE`, reverse shells, prompt-injection that writes
a CI backdoor, …) through the **real** policy path under three profiles, and
re-verifies every signed receipt offline. Representative result:

| Profile | State-changing attempts | Auto-executed | Held for approval | Denied |
|---|---|---|---|---|
| `ungoverned` | 99 | 99 | 0 | 0 |
| `default-pack` | 99 | **0** | 99 | 0 |
| `strict-lockdown` | 99 | **0** | 0 | **99** |

> **Honest by construction.** This is *modeled, not executed* — it measures the
> governance **decision** before any side effect; it does not run the commands
> and makes no claim a payload "detonated." The baseline is the absence of a
> gate (Claude Code's built-in tools run on the agent's say-so). Read-only
> attempts (e.g. a recon read of a credentials file) are allowed-with-evidence
> by design and reported **separately**, never folded into "blocked." Every
> decision receipt re-verifies offline, so the numbers are checkable, not
> asserted — `benchmark` exits non-zero if any load-bearing claim fails or any
> receipt fails to verify (CI-usable).

## How it works

`init` adds this to `.claude/settings.json` (idempotent; existing settings
preserved):

```jsonc
{ "hooks": { "PreToolUse": [
  { "matcher": "*", "hooks": [{ "type": "command", "command": "npx -y @strixgov/claude-code hook" }] }
] } }
```

The `hook` command reads Claude Code's PreToolUse payload on stdin, classifies
the tool via the capability pack, evaluates it with the **same fail-closed,
content-addressable `PolicyEngine` the Strix tool-gateway uses**, prints the
permission decision, and signs a decision receipt with the **locked
tool-gateway receipt schema** — so the same `@strixgov/verifier` an auditor uses
verifies it. The decision is fail-closed and independent of signing (a missing
key never turns a DENY into an allow).

## Library API

```js
import { decideToolUse, buildEngine, coverageReport, runHook } from '@strixgov/claude-code';

const engine = buildEngine({ rules: { 'claude.bash': 'DENY' } }); // optional override
decideToolUse({ toolName: 'Bash', toolInput: { command: 'rm -rf /' } }, engine);
// → { permissionDecision: 'deny', strixDecision: 'DENY', capabilityId: 'claude.bash', ... }
```

## Add the badge

Running governed? Show it. Add to your repo's README:

```md
[![governed by Strix](https://raw.githubusercontent.com/Strixgov/strix/main/packages/strixgov-claude-code/assets/governed-by-strix.svg)](https://github.com/Strixgov/strix/tree/main/packages/strixgov-claude-code)
```

## License

MIT — Strix's verification + integration primitives are open by design. The
protected runtime/control core is separate. See `LICENSING_BOUNDARY.md`.
