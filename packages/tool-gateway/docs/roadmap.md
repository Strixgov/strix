# Roadmap — `@strixgov/tool-gateway`

What's shipped, what's deliberately deferred, and what we own
explicitly so the gaps don't become invisible.

This document is the durable record of decisions made during the
360-review (April 2026) against the four-phase + governance/oversight
framework.

## Shipped

**v0.1.0** — initial release (governance + classification + chain).

**v0.1.1** — closes three HIGH-priority audit gaps:

- **Policy version hash** bound into every receipt's canonical payload
  (`policyVersion` field, schema v2). Auditors can answer "which
  policy was in force?" from the receipt alone.
- **Tenant + environment** fields bound into the canonical payload.
  Receipts from different projects / environments cannot be confused
  even when sharing a chain.
- **EventEmitter on Gateway** — `decision`, `receipt`, `denial`,
  `error` events. Wires metrics, audit, alerting, incident response.
- **`fileApprover`** — first-class headless / CI approval primitive.
  Default-deny on every failure mode (timeout, malformed JSON, IO error).
- **Verifier ≥ 1.5.0** dispatches on `schemaVersion` so v1 receipts
  remain verifiable forever.

**v0.3.0** — companion packs + experimental connected mode.

- **`@strixgov/capabilities-claude-code`** — sibling OSS package (16
  capabilities) covering Claude Code's built-in tool surface (Read,
  Write, Edit, Bash, Glob, Grep, Task, NotebookEdit, WebFetch,
  WebSearch, ToolSearch, Monitor, TodoWrite, ExitPlanMode,
  AskUserQuestion, Skill). Drop-in via `claudeCodeCapabilityMap()` +
  `suggestedPolicy()`. Override classifications per-environment.
- **`@strixgov/capabilities-mcp-common`** — sibling OSS package (~70
  capabilities) covering popular MCP servers: Slack, GitHub, Linear,
  Notion. `merge_pull_request` is CRITICAL by default
  (irreversibility invariant); reads LOW; writes APPROVAL_REQUIRED.
  Subpath imports per server (`/slack`, `/github`, `/linear`,
  `/notion`).
- **Connected mode (opt-in, experimental)** — `connectedMode:
  { kernelUrl, apiKey, tenantId, ... }` on `GatewayOptions`. After
  every persisted receipt or snapshot, fire-and-forget POST to
  `<kernelUrl>/api/v1/tool-gateway/receipts` (or `/snapshots`),
  HMAC-SHA256-signed with the API key. **Local execution never
  blocks on upstream availability** — the receipt is on disk and
  signed before any network call. Failures queue to an in-memory
  buffer (default cap 1000) with `sync-error` events; consumer drains
  via `gateway.drainSync()`. Wire format header
  `X-Strix-Wire-Version: v0.3-experimental` — explicitly experimental
  through v0.3, may rev before v0.4-stable.
- **Verifier 1.7.0** — `verifyConnectedWireEnvelope({body,
  signatureHeader, apiKey})` for inbound webhook receivers; flags
  unrecognised wire versions so a future hosted side can reject
  payloads it can't decode.
- New gateway events: `sync` (success), `sync-error` (failure with
  reason: `network-error` | `non-2xx` | `buffer-overflow`).

**v0.2.0** — operational essentials. All five v0.2 items shipped.

- **`KeyRing` + multi-key JWKS** (`src/keyring.mjs`) — directory of
  `<kid>/{signing-key.pem, public-jwk.json, meta.json}` with `active`
  pointer. Backward-compatible: a v0.1 single-key layout is migrated
  in place on first load (kid preserved). `KeyRing.jwks()` lists every
  kid the ring has ever held, so historical receipts stay verifiable
  after rotation.
- **`Gateway.rotateKey()` + chain snapshots** (`src/snapshots.mjs`) —
  rotation mints a `snap-1` record that commits to the last receipt
  under the previous kid and is **double-signed** (previous kid + new
  kid). Stored in a parallel `snapshots.jsonl`. A "swap the JWKS"
  attack is now visible: only the holder of the previous private key
  could have produced its half of the signature. Snapshots fire a
  `rotation` event.
- **Per-capability rate limits** (`src/rate-limit.mjs`) — sliding
  window keyed by capability id, with optional `perActor` partition
  and `prefix.*` glob matching (longest prefix wins). Configured via
  `policy.rateLimits`; rate-limited calls produce a normal signed
  DENY receipt with `denialReason: "RATE_LIMITED"`. Advisory by
  design: rate limits are operationally tunable and do **not** mutate
  the policy version hash, so SRE knob-turns don't invalidate
  receipt-comparison lineage.
- **Threshold-based escalation hook** — `escalation: { threshold,
  windowMs, decisions, onEscalate }` on `GatewayOptions`. Sliding
  count of receipts matching `decisions` (default `["DENY"]`); when
  the threshold is breached, fires the `escalation` event and
  invokes `onEscalate(event)`. Window resets after a fire so noisy
  bursts produce one alert, not a flood.
- **`webhookApprover`** (`src/approval.mjs`) — HMAC-SHA256 signed
  outbound POST to a notify URL plus a caller-supplied
  `pollResponse(requestId)` for the verdict. Zero new dependencies,
  no inbound HTTP server, fail-closed on every error path.
  `verifyWebhookSignature(...)` is exported for the receiving side.
- **Persistent capability registry** (`src/registry.mjs`) — signed
  manifest at `~/.strix-gateway/capabilities.json`, schema
  `registry-1`, signature covers the canonical-JSON of
  `{schemaVersion, capabilities (sorted), updatedAt, signingKeyId}`.
  `loadCapabilityRegistry` rejects unsigned/tampered manifests; an
  optional `watchCapabilityRegistry` reloads on change so multiple
  agent processes on the same host see the same registry.
- **Verifier 1.6.0** — `verifySnapshot`, `buildSnapshotCanonicalPayload`,
  and `verifyToolGatewayProof({receipts, snapshots})` for end-to-end
  external verification of a post-rotation chain. Output matches the
  gateway serializer byte-for-byte; multi-kid JWKS is the only input
  needed.
- **CLI surface** — `strix-gateway keys list|show|jwks|rotate`,
  `strix-gateway snapshots list` (each snapshot prefixed with its
  verification status). `verify` now resolves kid against the local
  KeyRing per-receipt, so a chain that crosses a rotation reports a
  per-receipt status without manual JWKS plumbing.

## Deferred (explicit owners, scheduled)

These were surfaced in the 360-review but intentionally not shipped in
v0.1.1. Each has a designated next-release target.

### v0.2 — operational essentials

All v0.2 items shipped — see "Shipped → v0.2.0" above.

### v0.3 — companion packs + experimental connected mode

All v0.3 items shipped — see "Shipped → v0.3.0" above. Companion packs
released as separate npm packages so adopters can install only what they
need; connected mode shipped as opt-in / experimental so the wire format
can iterate before v0.4.

### v0.4 — connected mode (stable)

Lock the connected-mode wire format and produce the hosted-side
adapter so receipts/snapshots from a fleet of agents roll up to a
central proof store. Open questions to resolve before locking:

- Batch envelope (multiple receipts per POST) vs the v0.3 single-record
  shape. Single-record was simpler; batches matter at scale.
- Backpressure beyond the in-memory buffer. Optional disk-backed queue
  via `JsonlStorage`-shaped sidecar?
- Replay protection on the wire envelope (timestamp + nonce). The
  Ed25519 signature on the inner receipt already binds content; the
  HMAC envelope binds caller identity but not request freshness.
- Capability registry sync (we ship the format in v0.2.0; do we
  flow signed manifests upstream as part of v0.4 or hold for v0.5)?

The v0.3-experimental wire is a proof-of-life. v0.4 is the contract.

### v0.5 — EU AI Act profile

Standalone companion package: `@strixgov/eu-ai-act-profile`.

- Recommended classifications + policy ruleset to satisfy
  Article 12 (record-keeping / tamper-resistant logs),
  Article 14 (human oversight), and
  Article 28 (provider obligations) — derived from the existing
  signed-receipt and approval-artifact infrastructure.
- A `complianceProfile()` helper that emits the compliance-flag
  metadata the hosted Strix Platform already understands (the
  `regulatoryContext` block on `decision_evidence`).
- Mapping from gateway events to the audit trail that EU AI Act
  conformity assessments expect; opinionated retention defaults.
- Documentation pack covering DSAR, log retention windows, and
  the relationship between local-first proof chains and the GPAI /
  high-risk-AI obligations.

The platform-side already implements much of this for hosted Strix.
The OSS profile makes those benefits accessible to local-first
deployments without forcing them onto the hosted product.

### Not on the roadmap (out of scope)

These came up in the 360-review but were determined to be outside the
gateway's mandate. Documented here so the decision is visible.

| Item | Why not |
|---|---|
| Argument validation / path allowlists | Orthogonal to governance — belongs in the executor or a separate validator, not the admission gate. |
| Multi-party quorum (2-of-N approvals) | The hosted Strix kernel does this for HIGH/CRITICAL governance decisions; the local gateway is single-developer scope. |
| RAG / model optimization | Different layer entirely. |
| Sandbox / process isolation | Recommended *complement* to the gateway (Linux namespaces, container, separate user); not the gateway's job. See `docs/threat-model.md` "Out of scope" #1. |

## Audit-gap → release map

For traceability with the April 2026 360-review:

| Gap | Severity | Status | Closed in |
|---|---|---|---|
| #1 CI / headless approval path | HIGH | ✅ closed | v0.1.1 (`fileApprover`) |
| #2 Policy version hash bound to receipt | HIGH | ✅ closed | v0.1.1 (schema v2) |
| #3 Real-time observability hook | HIGH | ✅ closed | v0.1.1 (Gateway → EventEmitter) |
| #4 Tenant / environment on canonical receipt | MEDIUM | ✅ closed | v0.1.1 (bundled with schema v2) |
| #5 Key rotation CLI + JWKS extras | MEDIUM | ✅ closed | v0.2.0 (`KeyRing` + multi-key JWKS) |
| #6 Failure escalation hook (built-in) | MEDIUM | ✅ closed | v0.2.0 (`escalation` option + event) |
| #7 Receipt chain rotation / snapshot | LOW | ✅ closed | v0.2.0 (cross-signed `snap-1` records) |
| #8 Persistent capability registry sharing | LOW | ✅ closed | v0.2.0 (`registry-1` signed manifest) |
| #9 Per-capability rate limits / budgets | LOW | ✅ closed | v0.2.0 (`policy.rateLimits` + `RateLimiter`) |

## Ownership

The framework asks: "Who owns the outputs / monitoring / failures /
rollback?" Answers as of v0.1.1:

| Layer | Owner | Mechanism |
|---|---|---|
| Outputs (signed receipts) | Gateway core (`receipts.mjs`) | Ed25519 signing, locked canonical payload |
| Monitoring | Caller, via Gateway events | `gateway.on("receipt", ...)` etc — caller plugs into their stack |
| Failures | Caller, via `error` event + return value | `error` event fires *after* receipt is written; return value carries `{ ok:false, error }` |
| Rollback | Caller, via `setPolicy` | The chain is append-only by design (immutability is the integrity property); rollback is a *policy* decision, not a chain decision. v0.2 will surface "rollback" semantics for capability *grants* if needed. |

If a future feature would weaken any of these answers, it belongs in
the "out of scope" table above, not in a release.
