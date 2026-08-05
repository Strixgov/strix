# NVIDIA OO Agents + Strix governed MCP profile

This example connects NVIDIA OO Agents (NOOA) to an existing MCP server through
`@strixgov/mcp-proxy`.

NOOA keeps its native object model: `MCPManager.create_from_server()` discovers
the MCP tools and generates typed Python methods from their JSON Schemas. Strix
is inserted at the MCP side-effect boundary, not into the model prompt or NOOA
reasoning loop.

## Architecture

```text
NOOA Agent
  |
  | MCP stdio (.mcp.json)
  v
Strix MCP Proxy
  |-- trusted workload identity
  |-- capability classification
  |-- ALLOW / APPROVAL_REQUIRED / DENY
  |-- signed authorization receipt before invocation
  |-- signed execution outcome after an allowed invocation
  v
Upstream MCP server
```

The example policy permits repository inspection and patch proposal, requires
separate approval for production merge, and denies credential rotation.

## Prerequisites

- Node.js 18+
- the Strix monorepo dependencies installed
- a checkout of NVIDIA `labs-OO-Agents` with its MCP extra installed
- Python and `uv` as required by NOOA

From the Strix monorepo root:

```bash
pnpm install --frozen-lockfile
```

From the NVIDIA OO Agents checkout:

```bash
uv sync --extra mcp
```

## Run without OpenShell

The Python process must use the NOOA environment, while its working directory
must be the Strix monorepo root so the relative paths in `.mcp.json` and
`proxy-config.json` resolve.

Activate the NOOA environment first:

```bash
# Linux or macOS, from the NVIDIA OO Agents checkout
source .venv/bin/activate

# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

Then change to the Strix monorepo root and run:

```bash
python packages/strixgov-mcp-proxy/examples/nvidia-nooa/nooa_agent.py
```

The NOOA MCP configuration starts the Strix proxy, and the proxy starts the demo
upstream MCP server. Running `uv run` from the Strix repository without selecting
the NOOA project environment is not sufficient because Strix itself does not
declare the NOOA Python package.

## Run in NVIDIA OpenShell

Create the sandbox first, then apply the complete policy and wait for the
sandbox to confirm the hot-reload:

```bash
openshell sandbox create --name nooa-strix

openshell policy set nooa-strix \
  --policy packages/strixgov-mcp-proxy/examples/nvidia-nooa/openshell-policy.yaml \
  --wait

openshell sandbox connect nooa-strix
```

The policy file includes the static filesystem/process fields because
`openshell policy set` replaces the entire policy. Its GitHub REST rule uses
`tls: terminate`, `enforcement: enforce`, and `access: read-only`, allowing the
listed Node proxy binaries to make read requests while rejecting mutating HTTP
methods. All other outbound traffic remains denied unless another policy or
configured inference provider permits it.

Adapt binary paths, endpoints, and inference-provider configuration to the
actual image before treating the template as production configuration.

## Trusted identity

`.mcp.json` supplies a fixed workload identity to the proxy process:

```text
STRIX_TRUSTED_ACTOR_ID=spiffe://openshell.local/nooa/remediator
STRIX_REQUIRE_TRUSTED_IDENTITY=true
```

This identity overrides any `strix_actor_id` value supplied by the MCP client.
Client metadata remains a claim, not an authentication boundary. If required
identity cannot be resolved, Strix emits a signed DENY authorization receipt and
does not call the upstream handler.

For production, replace the fixed identity with an authenticated resolver tied
to the workload transport or OpenShell control plane.

## Evidence

The proxy writes two append-only files under `.strix-nooa/evidence/`:

```text
receipts.jsonl            signed pre-invocation authorization receipts
execution-outcomes.jsonl  signed post-invocation outcome records
```

A denied or unapproved action has no execution-outcome record because the
upstream handler was not invoked. An allowed action has a linked `SUCCEEDED` or
`FAILED` outcome.

The public key is stored under `.strix-nooa/keys/public-jwk.json`. Verify both
the authorization chain and all linked execution outcomes offline from the
Strix monorepo root:

```bash
node packages/strixgov-mcp-proxy/examples/nvidia-nooa/verify-proof.mjs
```

The command exits `0` only when the authorization chain and every published
execution outcome return `VERIFIED`. It prints machine-readable JSON with the
schema, hash, key-resolution, signature, consistency, and authorization-link
results for each outcome.

The independent outcome verifier is also exported for other tools:

```javascript
import { verifyExecutionOutcomeRecord } from "@strixgov/verifier/execution-outcome";
```

Verification checks the published schema, rejects unsigned extension fields,
and reports the outcome hash, key resolution, Ed25519 signature,
execution-state consistency, and authorization-receipt link separately.

## Approval behavior

`merge_production` uses the file approver. The proxy writes an approval request
under `.strix-nooa/approvals/` and waits up to five minutes. Without an approved
response, execution fails closed and the upstream merge handler is not invoked.

`rotate_credentials` is denied directly by policy.

## Truthful claim boundary

This example demonstrates that calls flowing through the configured Strix proxy
are evaluated before invocation and produce portable signed authorization and
outcome evidence.

It does not prove that every possible route to a real downstream service is
blocked. The stronger anti-bypass claim requires one of these deployment
conditions:

- OpenShell or network policy prevents the agent from reaching the downstream
  directly;
- the proxy is the sole credential holder; or
- the downstream validates a Strix `execution_authorization_v1` token before
  performing the side effect.

The demo upstream is intentionally non-consequential. Replace it with a real MCP
server only after capability classification, approval handling, credential
custody, and anti-bypass controls have been reviewed for that deployment.
