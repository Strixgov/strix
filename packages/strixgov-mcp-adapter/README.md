# @strixgov/mcp-adapter

**Governance for MCP tool calls at the action boundary.**

The adapter wraps an MCP server's `callTool` path so each action is classified,
evaluated, approved or denied, evidenced, and only then permitted to reach the
handler.

```bash
npm install @strixgov/mcp-adapter @strixgov/tool-gateway
```

## Proof model

The adapter produces two separate signed artifacts because authorization and
execution are different claims.

1. **Authorization receipt** — persisted before invocation. It binds the
   capability, action, decision, policy version, tenant, environment, invocation
   hash, and proof-chain link.
2. **Execution outcome** — persisted after an allowed invocation. It links to the
   authorization receipt and binds `SUCCEEDED`, `FAILED`, or `UNKNOWN`, plus the
   result hash or error code.

A denied or unapproved action has no execution outcome because the handler was
not invoked. This distinction prevents a pre-execution decision from being
misrepresented as proof of executor success.

## Quick start

```js
import { governMCPServer } from "@strixgov/mcp-adapter";
import { githubCapabilities } from "@strixgov/capabilities-mcp-common/github";

const governed = governMCPServer(myToolHandlers, {
  serverId: "github",
  capabilities: githubCapabilities,
  policy: {
    rules: {
      "mcp.github.get_file_contents": "ALLOW",
      "mcp.github.merge_pull_request": "APPROVAL_REQUIRED",
      "mcp.github.delete_repository": "DENY",
    },
    default: "DENY",
  },
});

const result = await governed.callTool(name, args, {
  actorId: "agent-1",
});
```

`callTool` preserves the drop-in API and returns the handler result. Proof-aware
integrations can use `executeTool`:

```js
const execution = await governed.executeTool(name, args, context);

console.log(execution.authorizationReceipt);
console.log(execution.executionOutcome); // null for DENY / unapproved
```

## Trusted workload identity

MCP `_meta` actor fields are claims, not authentication. Configure a fixed or
transport-authenticated identity for consequential deployments:

```js
const governed = governMCPServer(tools, {
  serverId: "github",
  signingKey,
  identity: {
    requireTrusted: true,
    actorId: "spiffe://openshell.local/nooa/remediator",
    actorRole: "agent",
  },
  policy: { default: "DENY" },
});
```

A resolver can bind identity to an authenticated transport:

```js
identity: {
  requireTrusted: true,
  async resolve({ headers, metadata }) {
    return await resolveWorkloadIdentity(headers, metadata);
  },
}
```

For stdio-launched agents such as NVIDIA OO Agents, the adapter also reads:

```text
STRIX_TRUSTED_ACTOR_ID
STRIX_TRUSTED_ACTOR_ROLE
STRIX_REQUIRE_TRUSTED_IDENTITY=true
STRIX_TENANT_ID
STRIX_ENVIRONMENT
```

A trusted fixed or resolved identity overrides client-provided actor metadata.
When trusted identity is required but unavailable, the call fails before the
handler is invoked.

## Durable evidence and key custody

`storagePath` is a directory. The adapter writes:

```text
<storagePath>/receipts.jsonl
<storagePath>/execution-outcomes.jsonl
```

Durable receipts require a durable key. Direct adapter use therefore rejects
`storagePath` unless `signingKey` is explicitly supplied:

```js
import { loadOrCreateSigningKey } from "@strixgov/tool-gateway";

const signingKey = await loadOrCreateSigningKey({
  keyPath: "./.strix/keys",
  kid: "github-agent-2026-07",
});

const governed = governMCPServer(tools, {
  serverId: "github",
  storagePath: "./.strix/evidence",
  signingKey,
  policy: { default: "DENY" },
});
```

`@strixgov/mcp-proxy` resolves and persists the key automatically when it owns
the storage path.

## Independent verification

Authorization receipts remain compatible with `@strixgov/verifier`.

Signed execution outcomes can be verified without a Strix account:

```js
import { verifyExecutionOutcomeRecord } from
  "@strixgov/verifier/execution-outcome";

const result = verifyExecutionOutcomeRecord(outcome, {
  jwks,
  authorizationReceipt,
});
```

The verifier reports these checks separately:

- outcome hash;
- key resolution;
- Ed25519 signature;
- execution-state consistency;
- authorization-receipt linkage.

## API

### `governMCPServer(tools, opts)`

`tools` is either a handler map or an object with `handler(name, args)` and
`listTools()`.

Important options:

| Field | Purpose |
|---|---|
| `serverId` | Capability namespace: `mcp.<serverId>.<tool>` |
| `capabilities` | Explicit companion-pack classifications |
| `policy` | Rules, risk overrides, and fail-closed default |
| `signingKey` | Ed25519 signing key; required with durable storage |
| `storagePath` | Directory for authorization and outcome JSONL files |
| `outcomeStorage` | Custom post-execution outcome storage driver |
| `identity` | Fixed or authenticated workload identity resolver |
| `tenantId` | Tenant bound into signed artifacts |
| `environment` | Environment bound into signed artifacts |
| `approval` | Approval gate configuration |
| `connectedMode` | Optional upstream evidence synchronization |
| `onOutcome` | Observer called after outcome persistence |

Return value:

```ts
{
  callTool(name, args, ctx?): Promise<unknown>
  executeTool(name, args, ctx?): Promise<GovernedExecution>
  listTools(): Promise<Array<{ name: string }>>
  listOutcomes(): Promise<ExecutionOutcome[]>
  gateway: Gateway
  signingKey: SigningKey
  outcomeStorage: OutcomeStorageDriver
}
```

## Events

```js
governed.gateway.on("receipt", (authorizationReceipt) => {
  console.log(authorizationReceipt.decision);
});

governed.gateway.on("outcome", (executionOutcome) => {
  console.log(executionOutcome.executionStatus);
});
```

Observers run after the corresponding artifact has been persisted. Observer
failures do not rewrite the proof record.

## Risk classification

Explicit companion-pack classification is recommended. Heuristics are a
fail-closed fallback:

| Pattern | Risk | Mode |
|---|---|---|
| `get_*`, `list_*`, `read_*`, `fetch_*`, `search_*` | LOW | READ |
| `create_*`, `update_*`, `edit_*`, `post_*`, `send_*` | HIGH | WRITE |
| `delete_*`, `remove_*`, `destroy_*` | CRITICAL | WRITE |
| `exec_*`, `run_*`, `execute_*` | CRITICAL | EXECUTE |
| anything else | MEDIUM | EXECUTE |

Unknown tools remain denied under the recommended `default: "DENY"` policy.

## NVIDIA OO Agents

A concrete NVIDIA OO Agents and OpenShell profile lives at:

```text
../strixgov-mcp-proxy/examples/nvidia-nooa/
```

It uses NOOA's `.mcp.json` and `MCPManager.create_from_server()` path, preserves
NOOA's generated typed methods, binds a trusted workload identity, separates
authorization from execution evidence, and includes a restrictive OpenShell
policy template.

## Examples

Existing examples cover GitHub, Slack, Notion, Linear, filesystem, PostgreSQL,
and email MCP surfaces. They are available under `examples/` and use the same
adapter path.

## Claim boundary

The adapter controls calls that flow through its wrapper. It does not by itself
prove that a caller cannot reach the downstream service through another route.
A stronger anti-bypass claim requires at least one deployment control:

- the adapter or proxy is the sole credential holder;
- OpenShell or network policy blocks direct downstream access; or
- the downstream requires a valid Strix `execution_authorization_v1` token.

The adapter is not a model-safety system, prompt-injection detector, sandbox, or
legal certification. It governs requested side effects and produces portable
cryptographic evidence for the boundary it actually controls.

## License

Elastic License 2.0. See `LICENSE` and `COMMERCIAL.md` for the operational
boundary. The independent verifier and core trust primitives remain separately
MIT-licensed.
