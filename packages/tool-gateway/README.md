# @strixgov/tool-gateway

**Governed tool execution for AI agents — at the action boundary, not before or after.**

Most AI governance tools operate upstream of the action (prompt filters,
evals, content moderation) or downstream (audit logs, observability). The
tool-gateway operates at the action itself: every tool call an agent makes
is classified, evaluated against policy, and either allowed, denied, or
held for approval **before** it runs. Same enforcement applies regardless
of whether the actor is the agent, a human operator, or an automation
script.

Local-first. No account. No cloud. Every decision produces an Ed25519-signed,
append-only receipt that anyone can verify offline with
[`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier).

> **v0.4.1 — launch stable.** Connected-mode wire envelope is now stable
> (`timestamp` + `nonce` + timing-safe HMAC for replay defense). All v0.3
> and v0.4 review-track backlog items closed. The 4-package MCP Governance
> Bundle (this package + [`@strixgov/mcp-adapter`](https://www.npmjs.com/package/@strixgov/mcp-adapter)
> +
> [`@strixgov/capabilities-claude-code`](https://www.npmjs.com/package/@strixgov/capabilities-claude-code)
> +
> [`@strixgov/capabilities-mcp-common`](https://www.npmjs.com/package/@strixgov/capabilities-mcp-common))
> launches as a coordinated bundle.
>
> Earlier versions: v0.3 added companion packs + experimental connected
> mode. v0.2 added multi-key `KeyRing` with rotation, chain snapshots
> at every key handoff, per-capability rate limits, threshold-based
> escalation hooks, webhook-based approval, and a signature-verified
> shared capability registry. v0.1 introduced schema v2 (receipts bind
> a content-addressable `policyVersion` + `tenantId` + `environment`;
> v1 receipts continue to verify).

The gateway sits inline between an AI agent (Claude Code, Cursor, OpenClaw,
MCP clients, autonomous coding agents) and the actual execution surface —
filesystem, shell, MCP server, HTTP API.

## NSA MCP report alignment

NSA Cybersecurity Information [`U/OO/6030316-26 | PP-26-1834 | May 2026 Ver. 1.0`](https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/4192261/nsa-releases-cybersecurity-information-on-security-considerations-for-the-model/)
names a coherent set of gaps in current MCP deployments: authentication,
authorization, audit, the protocol's inversion of the
client-requests-from-server pattern, and arbitrary code execution paths
under CWE-77 / CWE-78 / CWE-94 / CWE-95. The tool-gateway is **post-compromise
execution control for the local tool surface of one agent**: every tool
call is classified, evaluated against policy, and either allowed,
denied, or held for approval **before** it runs, with an Ed25519-signed
receipt for both allowed and denied calls. The gateway is the open
primitive Strix can prove; it is not a sandbox, not EDR, and not
malware prevention. The durable map from each NSA-named concern to the
file + invariant that addresses it lives at
[`docs/launch/2026-05-23-nsa-mcp-technical-companion.md`](https://github.com/Strixgov/strix/blob/main/docs/launch/2026-05-23-nsa-mcp-technical-companion.md);
the short post is at [`docs/launch/2026-05-23-nsa-mcp-response.md`](https://github.com/Strixgov/strix/blob/main/docs/launch/2026-05-23-nsa-mcp-response.md).

```
Agent → @strixgov/tool-gateway → Tool
```

The product positioning is narrow on purpose: this is **post-compromise
execution control**. It is not malware prevention, not EDR, not "AI
safety," not observability. It is the layer that lets you safely give
agents more power.

For governance of any MCP server specifically, see
[`@strixgov/mcp-adapter`](https://www.npmjs.com/package/@strixgov/mcp-adapter)
— the 5-line drop-in that sits on top of this gateway.

---

## Install

```bash
npm install @strixgov/tool-gateway
# or
pnpm add @strixgov/tool-gateway
```

**Requirements:**
- Node.js 18+ (we depend on `node:crypto` Ed25519 support).
- A package manager — npm (ships with Node), pnpm, or yarn all work.
- No native build step, no platform-specific binaries.

**Path note:** The library does not expand `~` in any config path —
pass absolute paths. CLI invocations below use `~/.strix-gateway` for
readability; on Windows PowerShell substitute
`$env:USERPROFILE\.strix-gateway` or the literal `C:\Users\<you>\.strix-gateway`.

## 5-minute quickstart

```bash
# Generate a signing key + default deny-by-default policy under
# ~/.strix-gateway. Idempotent.
npx strix-gateway init

# See your local public JWK (this is what an external verifier uses).
npx strix-gateway keys jwks
```

```ts
import {
  createGateway,
  loadOrCreateKeyRing,
  JsonlStorage,
} from "@strixgov/tool-gateway";
import { governedFs } from "@strixgov/tool-gateway/adapters/filesystem";

// Both default to ~/.strix-gateway via os.homedir() — pass `root` / `dir`
// to override (use absolute paths; the library does not expand "~").
const gateway = createGateway({
  keyRing: await loadOrCreateKeyRing(),
  storage: new JsonlStorage(),
  policy: {
    rules: {
      "filesystem.read":   "ALLOW",
      "filesystem.write":  "APPROVAL_REQUIRED",
      "filesystem.delete": "DENY",
    },
    default: "DENY",
  },
  capabilities: {},
});

const fs = governedFs(gateway, { actorId: "agent-claude" });

// Reads run immediately.
const text = await fs.readFile("./CLAUDE.md");

// Writes prompt the user in the terminal. Deny-by-default + 60s timeout.
// (terminalApprove requires a TTY. For headless contexts — Claude Desktop,
//  CI, containers — use `fileApprover` instead, see "Headless / CI approval"
//  section below.)
await fs.writeFile("./out.txt", "agent output");

// Deletes are blocked at the policy layer.
await fs.unlink("./out.txt"); // throws: filesystem.delete denied
```

Every call appends a signed receipt to `~/.strix-gateway/receipts.jsonl`.
Verify any time with `npx strix-gateway verify` (CLI shortcut) or with
[`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier)
directly — see [Verification](#verification) below for the full story.

```bash
$ npx strix-gateway receipts list -n 3
2026-05-07T01:14:22Z  ALLOW              LOW      filesystem.read           rcpt_abf7…
2026-05-07T01:14:22Z  APPROVAL_REQUIRED  HIGH     filesystem.write          rcpt_2a09…
2026-05-07T01:14:22Z  DENY               CRITICAL filesystem.delete         rcpt_91d3…

$ npx strix-gateway verify
✓ rcpt_abf7… VERIFIED
✓ rcpt_2a09… VERIFIED
✓ rcpt_91d3… VERIFIED
3/3 receipts VERIFIED

$ npx strix-gateway chain
proof chain: OK
```

## What you can govern in v1

| Adapter | Capabilities | Default risk |
|---|---|---|
| `@strixgov/tool-gateway/adapters/filesystem` | `filesystem.read/list/write/append/delete` | LOW / LOW / HIGH / HIGH / CRITICAL |
| `@strixgov/tool-gateway/adapters/shell` | `shell.exec/spawn` (+ hard-fail patterns: `rm -rf /`, `curl ⏐ sh`, `npm publish`, fork bomb, etc) | CRITICAL / HIGH |
| `@strixgov/tool-gateway/adapters/mcp` | every tool an MCP server advertises, auto-classified by name (`read_*` LOW, `delete_*` CRITICAL, etc) | configurable |

Custom adapters are mechanical — call `gateway.execute({ capabilityId, action, args }, executor)` and the gateway does the rest. See `examples/`.

## Observability

The `Gateway` is an `EventEmitter`. Wire metrics, audit, alerting, or
incident response without modifying the gateway core:

```ts
gateway.on("decision", ({ evaluation, invocation }) => {
  metrics.increment(`strix.decision.${evaluation.decision}`, {
    capability: invocation.capabilityId,
    risk: evaluation.risk,
  });
});

gateway.on("receipt", (receipt) => {
  audit.append(receipt);                        // your own log shipper
});

gateway.on("denial", ({ receipt, evaluation, approval, hardfail }) => {
  if (hardfail) alert.page("on-call", receipt); // shell adapter hardfail
});

gateway.on("error", ({ receipt, err, invocation }) => {
  sentry.capture(err, { receipt, invocation });
});
```

Listener errors are caught and ignored — a buggy observer cannot break
the gateway's hot path. The receipt is always written before any event
fires (or before the executor runs, on `ALLOW`).

## Headless / CI approval — `fileApprover`

`terminalApprove` refuses non-TTY by design. For CI, container, and
headless agents use `fileApprover`: the gateway writes a request file,
an out-of-band channel (Slack bot, GitHub Action, on-call rotation)
writes a response file, the gateway reads it.

```ts
import { createGateway, fileApprover, loadOrCreateSigningKey, JsonlStorage }
  from "@strixgov/tool-gateway";

const gateway = createGateway({
  signingKey: await loadOrCreateSigningKey(),
  storage: new JsonlStorage(),
  policy: { rules: { "filesystem.write": "APPROVAL_REQUIRED" }, default: "DENY" },
  capabilities: {},
  approval: {
    timeoutMs: 5 * 60_000,
    prompt: fileApprover({
      requestDir: "./.strix-approvals",
      onRequestWritten: async (path, id) => {
        // optional hook: notify Slack / GitHub Check / pagerduty
      },
    }),
  },
});
```

The on-disk schema is documented in `src/approval.mjs`. Default-deny
applies: missing file = TIMEOUT = DENY, malformed JSON = PROMPT_FAILED
= DENY, anything other than `{ approved: true }` = DENY.

## Tenant + environment scoping

If you run multiple agents on the same machine — different projects,
clients, or environments — bind them at gateway construction so receipts
can never be confused:

```ts
const gateway = createGateway({
  tenantId: "fairytale-farms",
  environment: "prod",
  // ...
});
```

Both fields are part of the canonical signed payload. Tampering with
either invalidates the signature.

## Policy versioning

Every PolicyEngine produces a content-addressable hash:

```ts
gateway.policyVersion          // "sha256:9a3c7e..." (changes on setPolicy)
```

Each receipt embeds this hash, so an auditor can answer *"which policy
was in force when this receipt was issued?"* with the receipt alone —
no out-of-band record needed.

## Key rotation + chain snapshots (v0.2)

Open a multi-key `KeyRing` instead of a single signing key. New receipts
are signed by the active kid; rotation mints a doubly-signed snapshot
that an external verifier accepts as proof of continuity.

```ts
import {
  createGateway,
  loadOrCreateKeyRing,
  JsonlStorage,
} from "@strixgov/tool-gateway";

// Defaults are derived from os.homedir(); pass absolute paths to override.
const ring = await loadOrCreateKeyRing();
const storage = new JsonlStorage();
const gateway = createGateway({
  policy, capabilities, storage,
  keyRing: ring,
});

// ... receipts accumulate, signed by ring.active.kid ...

const snapshot = await gateway.rotateKey({ kid: "local-2026-06" });
// snapshot.signaturePrevious + snapshot.signatureNew = cross-signed boundary.
// New receipts after this line are signed by the new active kid.
```

CLI equivalents: `strix-gateway keys list|jwks|rotate`,
`strix-gateway snapshots list`. JWKS served by the ring covers every
historical kid, so retired-key receipts stay verifiable.

## Per-capability rate limits (v0.2)

Add `rateLimits` to your policy ruleset. Buckets can be shared or
partitioned per-actor. Wildcard prefixes match longest-first.

```ts
const policy = {
  rules: { "fs.write": "ALLOW", "fs.delete": "DENY" },
  default: "DENY",
  rateLimits: {
    "fs.write":   { windowMs: 60_000, max: 100 },
    "shell.exec": { windowMs: 60_000, max: 10, perActor: true },
    "ai.*":       { windowMs: 1_000,  max: 5 },
  },
};
```

Rate-limited calls produce a normal signed DENY receipt with
`denialReason: "RATE_LIMITED"`. Limits do **not** mutate the policy
version hash — they're operationally tunable without invalidating
receipt-comparison lineage.

## Threshold-based escalation (v0.2)

Fire an `escalation` event (and call `onEscalate`) when a sliding
window of receipts crosses a threshold. Useful for paging on burst
denials, tripping a circuit breaker, or quarantining an actor.

```ts
const gateway = createGateway({
  // ...
  escalation: {
    threshold: 5,
    windowMs: 60_000,
    decisions: ["DENY"],
    onEscalate: (e) => pageOnCall(e),
  },
});

gateway.on("escalation", (e) => log.warn("burst", e.count, e.receipts));
```

## Webhook-based approval (v0.2)

Same shape as `fileApprover`, but over HTTP with HMAC-SHA256 signing.
Zero new dependencies, no inbound server bound by this package — you
provide a `pollResponse(requestId)` against whatever store your
webhook receiver writes to.

```ts
import { webhookApprover, verifyWebhookSignature } from "@strixgov/tool-gateway";

const approver = webhookApprover({
  notifyUrl: "https://hooks.example.com/strix-approvals",
  secret: process.env.STRIX_WEBHOOK_SECRET,
  pollResponse: async (requestId) => approvalsStore.get(requestId),
  timeoutMs: 5 * 60_000,
});

// In your inbound webhook handler:
verifyWebhookSignature({ body, signatureHeader, secret });
```

## Shared capability registry (v0.2)

Persist a signed manifest at `~/.strix-gateway/capabilities.json` so
multiple agent processes on the same host see the same classifications.

```ts
import {
  saveCapabilityRegistry,
  loadCapabilityRegistry,
  watchCapabilityRegistry,
} from "@strixgov/tool-gateway";

await saveCapabilityRegistry({
  signingKey: ring.active,
  capabilities: [/* ... */],
});

const manifest = await loadCapabilityRegistry({
  resolvePublicKey: (kid) => ring.publicKeyForKid(kid),
});
```

Tampering breaks the signature; the loader fails closed.
`watchCapabilityRegistry` reloads on file change.

## Companion packs (v0.3)

Skip hand-classifying capabilities for common surfaces:

```bash
npm install @strixgov/capabilities-claude-code @strixgov/capabilities-mcp-common
```

```js
import { createGateway } from "@strixgov/tool-gateway";
import { claudeCodeCapabilities } from "@strixgov/capabilities-claude-code";
import { allMcpCapabilities }     from "@strixgov/capabilities-mcp-common";

const capabilities = Object.fromEntries(
  [...claudeCodeCapabilities, ...allMcpCapabilities].map((c) => [c.id, c]),
);
```

Both packs ship `suggestedPolicy()` for sane starter rulesets — strict
defaults (writes/EXECUTE → APPROVAL_REQUIRED, default DENY). Override
classifications per-environment as needed.

## Connected mode (v0.3, experimental)

Opt-in upstream sync for fleets of agents that want to roll their proof
chains up to a hosted system. **Local-first stays the default truth** —
upstream failures never block local execution.

```ts
const gateway = createGateway({
  // ... policy, capabilities, signingKey/keyRing, storage ...
  connectedMode: {
    kernelUrl: process.env.STRIX_KERNEL_URL,    // e.g. https://kernel.example.com
    apiKey:    process.env.STRIX_API_KEY,
    tenantId:  "fairytale-farms",
    syncReceipts:  true,                         // default
    syncSnapshots: true,                         // default
    onSyncError: (e) => log.warn("strix sync", e.reason, e.err.message),
  },
});

gateway.on("sync",       (e) => metrics.inc("strix.sync.ok"));
gateway.on("sync-error", (e) => metrics.inc("strix.sync.err", { reason: e.reason }));

// Periodically drain the queue (e.g. every minute):
setInterval(() => gateway.drainSync(), 60_000);
```

Wire format is **`v0.3-experimental`** — it may rev before v0.4 stable.
The Ed25519 signature on each inner receipt is what survives across
wire format changes.

## Verification

Receipts can be verified anywhere, by anyone, with the same primitives an
auditor would use:

```bash
# Offline — provide the JWKS exported from your local gateway.
npx strix-gateway keys jwks > ./public-jwks.json
npx @strixgov/verifier receipt path/to/receipt.json --jwks ./public-jwks.json

# Whole chain
npx @strixgov/verifier chain ~/.strix-gateway/receipts.jsonl --jwks ./public-jwks.json
```

The verifier is a separate package with **zero Strix dependencies** —
just Ed25519 + SHA-256 from `node:crypto`.

## The five invariants

These hold by construction in v1; loosening any of them is a breaking
change.

1. **Nothing executes without evaluation.** `Gateway.execute` evaluates
   policy → (optionally prompts approval) → mints a signed receipt →
   *then* invokes the executor. There is no fast path.
2. **Execution does not inherit authority.** Every invocation is a
   fresh evaluation. A previous ALLOW does not authorize a future call.
3. **Admissibility at execution time.** Policy is evaluated against the
   exact `(capabilityId, action, args, actor)` tuple that the executor
   will see — not the agent's intent, not a stale cache.
4. **Runtime enforcement.** A receipt is not a log entry. The receipt
   is the gate: no receipt, no execution. (See `gateway.mjs` line where
   `appendReceipt` precedes `executor(invocation.args)`.)
5. **Bounded and revocable.** Receipts are append-only; a tampered
   receipt fails signature verification. Approval prompts time out and
   default to deny. Storage is a single JSONL file you can `tail -f`.

## What this is NOT

- not malware prevention
- not antivirus / EDR / endpoint security
- not "AI safety" or "AI guardrails"
- not analytics or observability
- not a hosted service or SaaS dashboard

The threat model is post-compromise: assume the agent process is
already running attacker-controlled instructions. The gateway prevents
those instructions from reaching the executor without a signed
admission decision.

See [`docs/threat-model.md`](./docs/threat-model.md) for the full list
of in- and out-of-scope threats.

## Architecture

See [`docs/architecture.md`](./docs/architecture.md) for the execution
flow, proof chain construction, canonical-payload schema, and the wire
contract with `@strixgov/verifier`.

## Standards alignment

Strix is listed in the [Cloud Security Alliance AARM Builders
Registry](https://cloudsecurityalliance.org/research/working-groups/ai-systems-management)
with status **Aligned**. AARM (Autonomous Action Runtime Management) is the
CSA-led specification for runtime governance of autonomous AI actions
(donated to CSA by Vanta, paper [arXiv:2602.09433](https://arxiv.org/abs/2602.09433)).

The tool-gateway is the **local-first execution-control half** of Strix's
AARM coverage: AARM's R1–R3 (runtime authorization, deterministic policy
evaluation, fail-closed enforcement) implemented as a local primitive any
agent can drop in. The signed receipts it produces are tamper-evident under
[`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier),
which is the **public reference implementation of AARM Core R6**.

Cryptographic agent identity binding (the largest AARM Extended capability)
is planned for a subsequent release; see the [strixgov.com AARM
mapping](https://www.strixgov.com/partners/aarm) for the per-requirement
breakdown.

## Related packages — which one do I want?

The tool-gateway is the lowest-level primitive. Three higher-level
wrappers exist for specific contexts:

| Use case | Package | Relationship to tool-gateway |
|---|---|---|
| General agent-tool governance (filesystem / shell / your own adapters) | `@strixgov/tool-gateway` (this package) | The base library |
| Governing any MCP server, programmatically | [`@strixgov/mcp-adapter`](https://www.npmjs.com/package/@strixgov/mcp-adapter) | 5-line drop-in built ON TOP of tool-gateway |
| Governing any MCP server, standalone process | [`@strixgov/mcp-proxy`](https://www.npmjs.com/package/@strixgov/mcp-proxy) | Standalone binary built ON TOP of mcp-adapter |
| Application-layer governance (tRPC / Express / DB mutations) | [`@strixgov/sdk`](https://www.npmjs.com/package/@strixgov/sdk) | Application-integration surface; independent abstraction |
| Independent verification of any of the above | [`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier) | Zero-dependency verifier; no Strix runtime |

Receipt format is byte-compatible across all four governance packages —
the verifier doesn't care which one wrote the receipt.

## CLI commands quick reference

The `strix-gateway` binary covers six command groups (run any with
`--help` for full flag list):

| Command | What it does |
|---|---|
| `npx strix-gateway init` | Generate signing key + default deny-all policy under `~/.strix-gateway` (idempotent) |
| `npx strix-gateway keys list \| jwks \| rotate` | Inspect / export / rotate signing keys |
| `npx strix-gateway snapshots list` | List proof-chain snapshots emitted at each key rotation |
| `npx strix-gateway receipts list -n <N>` | Tail the last N signed receipts |
| `npx strix-gateway verify [<path>]` | Verify every receipt in the chain (default: `~/.strix-gateway/receipts.jsonl`) |
| `npx strix-gateway chain` | Walk the proof chain from genesis to tip; reports `proof chain: OK` or first break |

## License

MIT.

**Why MIT and not BSL / ELv2?** The tool-gateway is execution-control
primitives — the kind of code that benefits everyone when the trust
surface is widest. The packages built ON TOP (`mcp-adapter`, `mcp-proxy`
under ELv2; `@strixgov/sdk` under BSL) carry the commercial-restriction
license tier because they're the application-integration surface where
hosted-governance competitors could otherwise build a competing managed
service. The trust primitives — tool-gateway + verifier +
mcp-token-validator — stay MIT permanently. Verification has no
commercial-restriction story and never will.
