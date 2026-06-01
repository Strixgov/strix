# Security posture — `@strixgov/mcp-adapter`

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

This document covers `@strixgov/mcp-adapter` — the library that
wraps an MCP server's `callTool` path with governance. It applies
to v0.1.0 and any patch release of that line.

The adapter is a **library you embed in your own process**. Most
of the security posture below is therefore a property of the host
process that calls `governMCPServer(...)`, not a property of the
adapter as a standalone artifact.

For the standalone-process variant (a CLI that wraps any upstream
MCP server), see
[`@strixgov/mcp-proxy`](https://www.npmjs.com/package/@strixgov/mcp-proxy)
and its own `SECURITY.md` — the credential-boundary analysis is
architecturally identical; the proxy's `SECURITY.md` documents the
process-level concerns the adapter inherits from its host.

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

**On disk: never.** The adapter writes only what its host process
asks it to write — by default, in-memory receipts. If the host
process configures `opts.storagePath`, receipts go to JSONL.
Nothing else from the adapter touches disk.

If you see upstream credentials on disk, something in your host
process or wrapper code is putting them there — not the adapter.

**In memory: depends on which architectural position you deploy.**
The adapter itself doesn't pin you to one of the three positions;
the choice is a host-process integration decision.

### Position A — host process holds the credential

The host fetches an upstream credential from a secrets manager
(or reads it from its own environment) and either:

- Initializes the upstream tool SDK with it (e.g.
  `new NotionClient({ token })`) and passes the SDK's tool
  handlers into `governMCPServer({ tools })`, or
- Stores it in a closure that wraps the tool handlers passed to
  `governMCPServer`.

| | |
|---|---|
| **Credential lives in** | Host-process heap + downstream sink (SDK client object, fetch headers, etc.) |
| **Lifetime** | Host-process lifetime |
| **Who can read it** | Anyone with `ptrace` / `/proc/<pid>/mem` access to the host UID |
| **Used when** | Host process is the single integration boundary for the upstream tool |
| **Audit posture** | Host process is in scope for credential-handling audit. The adapter itself does not hold the credential — it just dispatches to the handler the host gave it. |

### Position B — credential supplied per-call

Host process accepts a credential from the caller (e.g. via an
HTTP request header), threads it through `ctx` or via a closure
captured per-call, and lets the tool handler use it. Adapter sees
neither the credential nor any field derived from it; only the
tool args (which `invocationHash` is derived from) are visible.

| | |
|---|---|
| **Credential lives in** | Per-call heap, GC'd after the response |
| **Lifetime** | Single call |
| **Who can read it** | Same as Position A, but only during the call |
| **Used when** | Host is a multi-tenant service whose callers provide their own upstream credentials |
| **Audit posture** | Adapter is not a credential-bearing system. Receipts cannot cryptographically attest actor identity beyond what the host supplied via `ctx`. |

### Position C — credential never crosses the host

The tool handler itself resolves its credential out-of-band:
Workload Identity, IAM role, OS keychain accessed by the SDK
client at construction time, or the underlying SDK does its own
secret resolution.

| | |
|---|---|
| **Credential lives in** | Only inside the tool's resolver / cloud metadata service |
| **Lifetime** | SDK / handler lifetime |
| **Who can read it** | Same UID as the host, but the credential is never an explicit value in the host's heap |
| **Used when** | Cloud-native deployments; any upstream that supports native secret resolution |
| **Audit posture** | Cleanest. The credential never crosses the adapter boundary. |

### The decision rule

If your auditor needs to confirm the adapter (or the host process
embedding it) is **not** a credential-bearing system, the answer
depends on whether you deployed as Position A, B, or C. The
adapter does not choose for you.

| If your host process supports it | Use |
|---|---|
| Any major cloud / on-prem with Vault Agent or equivalent | **Position C** — cleanest audit story |
| Host is a multi-tenant service and callers bring their own credentials | **Position B** |
| Host is the single integration boundary for the upstream | **Position A** — host is in scope for credential-handling audit |

Same primitive, three deployment shapes, materially different audit
and threat-model profiles.

---

## 3. What the adapter stores regardless of position

The four artifacts the adapter (and its underlying
`@strixgov/tool-gateway`) hold in any deployment shape:

| Artifact | Contents | Sensitivity | Lifetime / Location |
|---|---|---|---|
| Receipts | Signed canonical payloads: `capabilityId`, `action`, `decision`, `risk`, `mode`, `policyVersion`, `tenantId`, `environment`, **`invocationHash` (SHA-256 of args+actor)**, `evidenceHash`, `proofChainHash`, `timestamp`, `signature`, `signingKeyId`. Plus `actorId`, `actorRole`, and (if approved) `approvedBy` as un-signed display fields. | **Does NOT contain raw `args`** — only a hash. See §3.1 for what this means in practice. Never contains auth credentials. | In-memory by default. On disk at `opts.storagePath` if set. |
| Gateway signing key | Ed25519 private key used to sign receipts | Generated per-install if not supplied; **distinct from upstream credentials** | Memory by default. Override via `opts.signingKey` to load from your secrets manager. Persistent storage is operator-managed. |
| Policy config | Capability rules, risk overrides, fail-closed defaults | **Not secret.** Check it into source control. | Passed at construction time via `opts.policy`. Held in the gateway's closure for the lifetime of the host process. |
| Approval gate state | Pending-approval queue (only if approvals enabled) | Holds pending-action metadata until decided | In-memory by default; lost on host-process exit unless you wire persistence |

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
are NOT in the signed bytes or the persisted record, you can share
receipts externally **without args-redaction concerns**. The
signature verifies against `invocationHash`, which is derived
deterministically from the args + actor fields the agent supplied.
An auditor can confirm the signed receipt corresponds to a given
args bundle by hashing their copy of the args and comparing to
`invocationHash`. If they don't have the args, they can still
confirm the receipt is authentic, just not what it was authorizing.

This is by design — the receipt is the audit artifact; the args
themselves are operationally-sensitive call data that the adapter
**never persists**.

### 3.2 In-memory args sensitivity

While a `callTool` is in flight, the host process (and therefore
the adapter inside it) DOES see the raw args in memory:

- Args come in from the MCP client / caller
- Args flow through `governMCPServer` for policy evaluation +
  hashing into `invocationHash`
- Args are forwarded to the host-supplied tool handler (which
  uses them to make the actual upstream call)

During this window, an attacker with `ptrace` access to the host
UID can read the args. After the call returns, the args are
eligible for GC and the only persistent trace is `invocationHash`.

For deployments that need additional in-memory protection (e.g.
agent args contain regulated data even during a single call),
combine with a hardened deployment environment: dedicated UID,
seccomp/AppArmor profile that blocks `ptrace`, no co-tenant
processes under the same UID. Strix-side mitigations are not the
right layer.

### 3.3 Signing key lifecycle

The Ed25519 signing key the gateway uses to sign receipts is:

- **Auto-generated** if not supplied (per-construction; lost on
  host-process restart unless the host persists the key via its
  own mechanism or via `@strixgov/tool-gateway`'s on-disk key
  store). Fine for development and Mode 1 demonstrations.
- **Caller-supplied** when `opts.signingKey` is set, OR when an
  operator persists a key under `~/.strix/keys/` via
  `tool-gateway`'s key-management surface. Use this in production.
- **Rotated** by replacing the key + publishing the old public key
  to the JWKS for the retention window (default 2 years for EU AI
  Act Article 12 compliance). Historical receipts remain
  verifiable.

The signing key is **not the same as the upstream credential**.
Rotating one does not rotate the other; they have different
lifecycles and different blast radii.

---

## 4. Runtime model — what happens on failure

The adapter runs inside whatever host process invokes
`governMCPServer(...)`. The host's process model governs.

| Failure mode | What happens | Recovery |
|---|---|---|
| Host crashes mid-tool-call | Tool handler may or may not have completed. If `governed.gateway.execute` had not yet returned, no receipt is written. The MCP client sees a transport error. | Restart host. The action did not execute in any auditable sense. |
| Tool handler throws | Adapter catches and emits the error to the MCP client. Receipt is written with `decision: "DENY"` (or whatever the policy decided) — the throw is treated as an upstream-side failure, not a governance event. | Standard MCP error handling on the client side. |
| Host crashes mid-approval | Pending approval is lost (in-memory queue). The held action does not execute. | Restart host. The previous approval is gone. |
| Disk fills up (with `opts.storagePath` set) | New receipt writes fail. The adapter raises an error but does not fall back to silent ALLOW — fail-closed discipline. | Rotate / archive the receipt log before restarting. |
| Signing key not loadable | `governMCPServer(...)` throws at construction. **The host does not start.** | Fix the key configuration. There is no "governance degraded but tool still runs" state. |

### 4.1 Receipt-log rotation is host-owned

When `opts.storagePath` is set, the adapter (via tool-gateway)
appends signed receipts to a JSONL file. **No built-in rotation.**
A high-volume deployment will fill disk if the host process does
not manage rotation:

- Standard `logrotate(8)` with copytruncate is the simplest path.
- Connected Mode customers can configure the strixgov.com
  platform to be the durable retention store; the local file
  becomes a transient buffer that can be rotated aggressively.
- Anyone running the adapter at non-trivial volume MUST decide on
  a rotation policy before launching.

---

## 5. Multi-tenant boundary

A single instance of `governMCPServer(...)` is **single-tenant by
design** in v0.1.0.

- One gateway has one upstream `tools` map, one signing key, one
  receipt stream, one approval queue.
- If you call `governMCPServer` once and share the returned object
  across multiple agents, they share all of the above.

If your host process needs per-tenant isolation:

- **Recommended:** call `governMCPServer(...)` once per tenant.
  Each instance gets its own signing key, receipt store, and
  approval queue. Pass distinct `opts.tenantId` to each.
- Resource cost: small (closure + signing key, ~few MB heap).
- The `policyVersion`, `tenantId`, and `environment` fields are
  in the signed canonical payload, so a verifier can detect a
  cross-tenant replay attempt.

**Do not share a single gateway instance across tenants in
production** without an explicit threat model that accepts the
shared-signing-key implications.

---

## 6. What the adapter does NOT govern

For audit clarity — the adapter's surface is bounded:

| Surface | Governed? | Why not |
|---|---|---|
| `governed.callTool(name, args, ctx)` invocations | **YES** | The whole point. |
| Direct calls to the underlying tool handlers, bypassing `governed.callTool` | **NO** | If the host process accidentally exposes the raw `tools` map alongside the governed wrapper, agents can route around the gate. Host-process discipline is required. |
| The agent's own internal state, prompts, or reasoning | **NO** | The adapter is at the action boundary, not upstream of the model. |
| The upstream tool's internal behavior | **NO** | The adapter trusts the host-supplied handler to honor the `callTool` request. SQL injection, command injection inside the upstream's argument handling — out of scope for the adapter. Mitigation is the upstream's own argument validation. |
| Network egress from the host process | **NO** | Network policy is the deployment's responsibility. Mode 3 Posture B (HTTP egress gating) is the architectural answer; not in v0.1.0. |
| What the host process does with the `receipt` events emitted by `governed.gateway` | **NO** | If the host forwards receipts to a SIEM, the host is responsible for what ends up there. |

---

## 7. Reporting security issues

Open a **GitHub Security Advisory** on the public mirror at
`github.com/Strixgov/strix` for any of:

- Cryptographic findings (signature verification bypass, key
  recovery, canonicalization drift)
- Credential leakage paths in the adapter code
- Authentication / authorization gaps
- Receipt forgery vectors

For non-security operational issues, use the normal GitHub Issues
surface or the support channels documented in
[`COMMERCIAL.md`](./COMMERCIAL.md).

---

## 8. Version history of this document

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-05-23 | Initial publication alongside `@strixgov/mcp-adapter` v0.1.0 |
