# Security posture — `@strixgov/mcp-proxy`

This document is the security-team-facing surface for the package.
It answers the questions a security review will ask in the first
30 minutes — what does the package hold, where, for how long, and
which threats does it cover or not cover.

For the broader Strix threat model (the platform, the verifier,
the kernel-binding guarantees), see the threat-model documentation
distributed with the Strix platform. Authorized reviewers and
prospective customers can request the current version via
security@strixgov.com.

---

## 1. Scope

This document covers `@strixgov/mcp-proxy` — the standalone process
that wraps an upstream MCP server. It applies to v0.1.0 and any
patch release of that line.

Out of scope:

- The trust path of receipt verification — handled by
  [`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier)
  (MIT, zero-dependency, separate trust root).
- The execution-authorization token format — handled by
  [`@strixgov/mcp-token-validator`](https://www.npmjs.com/package/@strixgov/mcp-token-validator),
  which lands as the Mode 3 enforcement primitive when wiring ships
  in v0.2.0.
- The Strix Console + the hosted Connected Mode platform — separate
  audit posture.

---

## 2. Credential boundary — where do upstream credentials live?

**On disk: never, by design.** The proxy writes signed receipts
(`receipts.jsonl`) and nothing else. No `.env` file, no credential
cache, no token store. If you see secrets on disk, something in
your wrapper script or logging is putting them there — not the
proxy.

**In memory: depends on which architectural position you deploy.**
The proxy itself doesn't pin you to one of the three positions
below; the choice is an integration decision your operator makes.

### Position A — proxy holds the credential

The proxy fetches an upstream credential from a secrets manager
(or reads it from its own environment) and passes it downstream:
as a child-process env var (stdio MCP), as an `Authorization`
header on outbound HTTP, or as an SDK initialization parameter.

| | |
|---|---|
| **Credential lives in** | Proxy heap + downstream sink (child env, fetch headers, SDK client object) |
| **Lifetime** | Proxy process lifetime |
| **Who can read it** | Anyone with `ptrace` / `/proc/<pid>/mem` access to the proxy UID |
| **Used when** | Upstream is a binary you spawn (stdio MCP servers), OR an HTTP endpoint where the proxy is the OAuth client |
| **Audit posture** | Proxy is in scope for credential-handling audit. Treat it as a credential-bearing system. |

### Position B — proxy passes the credential through

Client (e.g. Claude Code / Claude Desktop) supplies the credential
per-request (header, bearer token). Proxy forwards it to upstream
unchanged. Proxy sees the bytes in flight but does not retain them
past the request.

| | |
|---|---|
| **Credential lives in** | Per-request heap, GC'd after the response |
| **Lifetime** | Single request |
| **Who can read it** | Same as Position A, but only during the request window |
| **Used when** | Upstream is hosted HTTP and supports OAuth; client is the OAuth client; transparent passthrough |
| **Audit posture** | Proxy is not a credential-bearing system in steady state. Receipts cannot cryptographically attest actor identity beyond what the client supplies. |

### Position C — proxy never sees the credential

Upstream identity is resolved out-of-band: Workload Identity on
cloud platforms, IAM role on the instance, OS keychain accessed
directly by the upstream process, or the upstream binary resolves
its own secrets from a secrets manager.

| | |
|---|---|
| **Credential lives in** | Only the upstream's process / cloud metadata service |
| **Lifetime** | Upstream lifetime |
| **Who can read it** | Same UID as the upstream process |
| **Used when** | Cloud-native deployments; any upstream that supports native secret resolution |
| **Audit posture** | Cleanest. Proxy is not credential-bearing at all. The credential never crosses the proxy boundary. |

### The decision rule

If your auditor needs to confirm the proxy is **not** a
credential-bearing system, the answer depends entirely on whether
you deployed it as Position A, B, or C. The proxy itself does not
choose for you.

| If your deployment supports it | Use |
|---|---|
| Any major cloud / on-prem with Vault Agent or equivalent | **Position C** — cleanest audit story |
| Upstream is hosted HTTP + supports OAuth + client can be the OAuth client + you don't need cryptographically-verified actor identity in receipts | **Position B** — proxy stays credential-free |
| Upstream is a binary you spawn (stdio MCP) OR you need the proxy to be the identity broker | **Position A** — proxy is in scope for credential-handling audit, but the receipt's claimed actor identity can be cryptographically attested once AA-1 wiring ships |

Same primitive, three deployment shapes, materially different audit
and threat-model profiles.

---

## 3. What the proxy stores regardless of position

The four artifacts the proxy holds in any deployment shape:

| Artifact | Contents | Sensitivity | Lifetime / Location |
|---|---|---|---|
| `receipts.jsonl` (or in-memory) | Signed canonical payloads: `capabilityId`, `action`, `decision`, `risk`, `mode`, `policyVersion`, `tenantId`, `environment`, **`invocationHash` (SHA-256 of args+actor)**, `evidenceHash`, `proofChainHash`, `timestamp`, `signature`, `signingKeyId`. Receipt also carries `actorId`, `actorRole`, and (if approved) `approvedBy` as un-signed display fields. | **Does NOT contain raw `args`** — only a hash. See §3.1 for what this means in practice. Never contains auth credentials. | On disk at `opts.storagePath` if set; in-memory otherwise (lost on process exit) |
| Gateway signing key | Ed25519 private key used to sign receipts | Generated per-install if not supplied; **distinct from upstream credentials** | Memory by default. Override via `opts.signingKey` to load from your secrets manager. Persistent storage is operator-managed. |
| Policy config | Capability rules, risk overrides, fail-closed defaults | **Not secret.** Check it into source control. | Read at startup from the config file or CLI flags |
| Approval gate state | Pending-approval queue (only if approvals enabled) | Holds pending-action metadata until decided | In-memory by default; lost on process exit unless you wire persistence |

### 3.1 What the receipt does and does not contain

This is the most common question. The honest answer:

| The receipt stores | The receipt does NOT store |
|---|---|
| The **capability id** invoked (e.g. `mcp.notion.create_comment`) | The raw tool arguments — only their SHA-256 hash (`invocationHash`) |
| The **decision** (`ALLOW` / `DENY`) | The agent's prompt or reasoning |
| The **actor id + role** (e.g. `agent-claude-1` / `agent`) | The tool's response content |
| The **approver identity** if approval gate fired | The upstream API response body |
| Timestamps + signing-key id + proof-chain linkage | Auth credentials of any kind |

**Practical implication for receipt sharing:** because raw args
are NOT in the signed bytes or the on-disk record, you can share
the receipt JSONL externally **without args-redaction concerns**.
The signature verifies against `invocationHash`, which is derived
deterministically from the args + actor fields the agent supplied.
An auditor can confirm the signed receipt corresponds to a given
args bundle by hashing their copy of the args and comparing to
`invocationHash`. If they don't have the args, they can still
confirm the receipt is authentic, just not what it was authorizing.

This is by design — the receipt is the audit artifact; the args
themselves are operationally-sensitive call data that the proxy
**never persists**.

### 3.2 In-memory args sensitivity

While a `callTool` is in flight, the proxy DOES see the raw args
in memory:

- Args come in from the MCP client via stdio
- Args flow through `governMCPServer` for policy evaluation +
  hashing into `invocationHash`
- Args are forwarded to the upstream MCP server via the proxy's
  internal client

During this window, an attacker with `ptrace` access to the proxy
UID can read the args. After the call returns, the args are eligible
for GC and the only persistent trace is `invocationHash`.

For deployments that need additional in-memory protection (e.g.
agent args contain regulated data even during a single call),
combine with a hardened deployment environment: dedicated UID,
seccomp/AppArmor profile that blocks `ptrace`, no co-tenant
processes under the same UID. Strix-side mitigations are not the
right layer.

### 3.3 Signing key lifecycle

The Ed25519 signing key the gateway uses to sign receipts is:

- **Auto-generated** if not supplied (per-process; lost on restart
  unless `opts.storagePath` is set and the key is persisted by
  the underlying `@strixgov/tool-gateway` storage). This is fine
  for development and Mode 1 demonstrations.
- **Caller-supplied** when `opts.signingKey` is set, OR when an
  operator runs the tool-gateway's key-management commands to
  persist a key under `~/.strix/keys/`. Use this in production.
- **Rotated** by replacing the key + publishing the old public key
  to the JWKS for the retention window (default 2 years for EU AI
  Act Article 12 compliance). Historical receipts remain
  verifiable.

The signing key is **not the same as the upstream credential**.
Rotating one does not rotate the other; they have different
lifecycles and different blast radii.

---

## 4. Process model — what happens on failure

The proxy is a single Node.js process. Crash semantics:

| Failure mode | What happens | Recovery |
|---|---|---|
| Proxy crashes mid-tool-call | Upstream call may or may not have started (depends on timing). No receipt is written. The MCP client sees a transport error. | Restart proxy. The action did not execute in any auditable sense. Re-running the same agent input replays the call from scratch. |
| Upstream crashes during a call | Proxy receives the error from the upstream client. Receipt is written with `decision: "DENY"` (or `"ALLOW"` if policy already approved + upstream failed AFTER consume). Error propagated to client. | Standard MCP error handling on the client side. |
| Proxy crashes mid-approval | Pending approval is lost (in-memory queue). The held action does not execute. | Restart proxy. The action would need to be re-attempted; the previous approval is gone. |
| Disk fills up (with `storagePath` set) | New receipt writes fail. The proxy raises an error but does not fall back to silent ALLOW — fail-closed discipline. | Rotate / archive `receipts.jsonl` before restarting. |
| Signing key not loadable | Constructor throws at startup. **The proxy does not start.** | Fix the key configuration. There is no "governance degraded but tool still runs" state. |

### 4.1 Receipt-log rotation is operator-owned

`receipts.jsonl` has **no built-in rotation** in v0.1.0. A
high-volume deployment will fill disk. Mitigation is
operator-side:

- Standard `logrotate(8)` with copytruncate is the simplest path.
  Configure it to rotate when the file exceeds your retention
  comfort threshold.
- Connected Mode customers can configure the strixgov.com
  platform to be the durable retention store; the local
  `receipts.jsonl` then becomes a transient buffer that can be
  rotated aggressively.
- Anyone running the proxy at non-trivial volume MUST decide on a
  rotation policy before launching.

This is intentionally not in the proxy itself — log rotation
strategy is a deployment decision (Node-level `logrotate-stream`?
journald? Connected Mode forwarding?) and baking one in would lock
operators out of their preferred tooling.

---

## 5. Multi-tenant boundary

The proxy is **single-tenant by design** in v0.1.0.

- One proxy process serves one set of upstream credentials, one
  signing key, one receipt log.
- If you run multiple agents through one proxy, they share:
  - The same upstream credentials (Position A)
  - The same signing key
  - The same `receipts.jsonl`
  - The same approval queue

This is not a bug — it matches how MCP clients (Claude Desktop,
mcp-cli, IDE integrations) configure MCP servers: one upstream
per client config entry, with the proxy spawning one process per
entry.

**If you need per-tenant isolation:** run one proxy process per
tenant. Each gets its own credentials, signing key, receipt log,
and approval queue. Resource cost: small (Node process + ~30MB
RSS). This is the recommended pattern.

Future v0.2.0+ may introduce a multi-tenant variant. Until then,
**do not share a single proxy process across tenants in
production** without an explicit threat model that accepts the
shared-credential + shared-signing-key implications.

---

## 6. What the proxy does NOT govern

For audit clarity — the proxy's surface is bounded:

| Surface | Governed? | Why not |
|---|---|---|
| MCP `callTool` requests routed through the proxy | **YES** | The whole point. |
| MCP `listTools` / `initialize` / other protocol messages | **NO** | These are protocol overhead, not state-changing. No receipts emitted. |
| Direct API calls the agent makes outside the proxy | **NO** | Out-of-wrapper traffic is invisible to the proxy. Mode 3 (capability enforcement) is the answer here; not shipped in v0.1.0. |
| The agent's own internal state, prompts, or reasoning | **NO** | The proxy is at the action boundary, not upstream of the model. |
| The upstream MCP server's internal behavior | **NO** | The proxy trusts the upstream to honor the `callTool` request it forwards. SQL injection, command injection inside the upstream's argument handling — out of scope for the proxy. Mitigation is the upstream's own argument validation. |
| Network egress from the agent's runtime | **NO** | Network policy is the deployment's responsibility. Mode 3 Posture B (HTTP egress gating) is the architectural answer; Strix Proxy v0.1.0 is the stdio-only variant. |
| The proxy's own logging / observability backend | **NO** | If you forward proxy logs to a SIEM, you're responsible for what ends up there. The proxy writes audit-relevant content to stderr (lifecycle events) and stdout-MCP-protocol (the protocol channel); receipts go to `receipts.jsonl` or in-memory. |

---

## 7. Reporting security issues

Open a **GitHub Security Advisory** on the public mirror at
`github.com/Strixgov/strix` for any of:

- Cryptographic findings (signature verification bypass, key
  recovery, canonicalization drift)
- Credential leakage paths in the proxy code
- Authentication / authorization gaps
- Receipt forgery vectors

For non-security operational issues, use the normal GitHub Issues
surface or the support channels documented in
[`COMMERCIAL.md`](./COMMERCIAL.md).

---

## 8. Version history of this document

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-05-23 | Initial publication alongside `@strixgov/mcp-proxy` v0.1.0 |
