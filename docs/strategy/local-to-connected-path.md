# Local → Connected: The Route to the Kernel

**Status:** v1.0 (public)
**Date:** 2026-05-28
**Audience:** Developers adopting Strix, technical decision-makers evaluating the architecture

**Companion docs (in this repository):**
- [`LICENSING_BOUNDARY.md`](../../LICENSING_BOUNDARY.md) — the ratified MIT / Elastic-2.0 license split
- [`packages/strixgov-verifier/README.md`](../../packages/strixgov-verifier/README.md) — the verification primitive
- [`packages/tool-gateway/README.md`](../../packages/tool-gateway/README.md) — the local-first execution primitive

> **What this document is.** A plain-English explanation of how Strix's
> Local Mode and Connected Mode relate, what each can and cannot do, and
> what the upgrade path looks like — written so an adopter can read it
> in ten minutes and know exactly where the line is.
>
> **What it isn't.** A sales pitch. The mechanism described here is
> deliberately structural — what changes between the two modes is two
> environment variables, not a code rewrite.

---

## 0. The frame

Strix's credibility claim is *"the verifier needs zero trust in us."*
That is **structural**: the verifier resolves a public JWKS, validates
Ed25519 signatures, and walks a hash chain. Any of that being gated by
us would falsify the sentence. The verifier's independence is the
foundation of the entire product.

The consequence: Local Mode has to be real. Not a demo, not a
sandboxed-until-you-pay tier, not a trial timer. The same code that
runs in Connected Mode signs Local Mode's receipts. The same verifier
checks both. The trust property is identical across the boundary.

This document explains what Local Mode does, where it structurally
runs out of road, and how the two-env-var path to Connected Mode
works.

---

## 1. What Local Mode does

With no Strix account, no API key, and no network connection to us,
the complete enforcement loop runs locally:

- Wrap state-changing actions with `governMCPServer()` (mcp-adapter) or
  the SDK's `governedAction()` surface.
- Evaluate against a `LocalPolicyEngine` (deterministic,
  content-addressable policy version).
- Issue a single-use, scope-bound, time-bound execution token (HMAC).
- Redeem the token atomically (`ACTIVE → REDEEMED`) at the call site.
- Emit an Ed25519-signed evidence record to a local sink
  (JSONL or SQLite).
- Verify any record offline:
  `npx @strixgov/verifier chain ./receipts.jsonl` — zero network
  calls, zero Strix dependencies on the verifier's trust path.

This is the full five-invariant enforcement loop: nothing executes
without evaluation, execution does not inherit authority, admissibility
at execution time, runtime enforcement, bounded and revocable
execution.

The packages that deliver Local Mode today, all on npm, all open or
source-available:

| Package | License | Role |
|---|---|---|
| `@strixgov/verifier` | MIT | Independent offline verification |
| `@strixgov/tool-gateway` | MIT | Local-first governed execution |
| `@strixgov/capabilities-mcp-common` | MIT | Pre-classified risk tiers (Slack / GitHub / Linear / Notion / Filesystem / Postgres) |
| `@strixgov/capabilities-claude-code` | MIT | Pre-classified tiers for Claude Code's built-ins |
| `@strixgov/mcp-token-validator` | MIT | Token validation primitive |
| `@strixgov/mcp-adapter` | Elastic-2.0 | 5-line `governMCPServer()` wrap |
| `@strixgov/mcp-proxy` | Elastic-2.0 | Governed MCP transport |

See [`LICENSING_BOUNDARY.md`](../../LICENSING_BOUNDARY.md) for why each
tier sits where it does.

---

## 2. What Local Mode structurally cannot do

These are not artificial limits. They are coordination problems that
no single-instance local deployment can solve, regardless of
implementation quality. Each row is the point where a serious adopter
discovers Connected Mode is needed.

| Wall Local Mode hits | What Connected Mode provides |
|---|---|
| Scaling past a single instance — anti-replay token store across N workers | Shared token store (today: hosted kernel; planned: Redis adapter) |
| Multi-approver quorum, async approval, notifications, time-bound holds | Approval inbox + signed quorum chain (`npx @strixgov/verifier quorum <decisionId>`) |
| One timeline / dashboard across multiple services and teams | Central evidence aggregation + live proof page |
| Production-grade key custody, rotation, hosted JWKS others can verify against | AWS KMS provider (`STRIX_KMS_PROVIDER=aws`); hosted JWKS at the canonical host |
| Mapping evidence records to EU AI Act / SOC 2 / FedRAMP controls | Attestation generation (planned) + compliance dashboards |
| Handing an external party a verifiable proof bundle | Offline proof-bundle export route — the bundle's recipient verifies it with `@strixgov/verifier`, no Strix tooling on the trust path |
| Real-time DENY telemetry, alerting, governance SLOs | Hosted observability + integrity-check cron |
| Policy itself becoming a governed artifact — change-approval, multi-env rollout, signed policy versions | Policy registry with versioned, signed, multi-env rollout |
| Federated trust — one auditor verifying receipts across multiple of your customers | Single canonical JWKS endpoint + the same `@strixgov/verifier` they already run |

The pattern: anything requiring **coordination across processes,
people, or organizations** is Connected Mode's job. Anything contained
inside one process running one set of policies on one local sink is
Local Mode's.

---

## 3. The license split (already in place)

The license split documented in
[`LICENSING_BOUNDARY.md`](../../LICENSING_BOUNDARY.md) carries part of
this answer on its own:

- The trust primitives (`verifier`, `sdk`, `tool-gateway`, capabilities
  packs, `mcp-token-validator`) are **MIT** — permanently. Their
  adoption is the network effect.
- The MCP runtime adapters (`mcp-adapter`, `mcp-proxy`) are
  **Elastic-2.0** — source-available, free for any internal production
  use at any scale, with one restriction: they may not be offered as a
  competing hosted or managed governance service.

That single restriction handles the *"what if someone stands up Strix
as a service"* concern without gating Local Mode.

A CI gate (`lint-license-parity`) freezes the split — every published
package's `LICENSE` file, `package.json` `license` field, and SPDX id
must stay in parity, and a new published package that is unclassified
fails closed.

---

## 4. The route to Connected Mode

The connect step is intentionally trivial — two environment variables,
no code changes, additive behavior.

### 4.1 Activation contract

```
STRIX_API_KEY    — your strixgov.com API key (≥16 chars)
STRIX_TENANT_ID  — your tenant id
STRIX_API_URL    — optional override of the canonical host
```

Both variables must be present to switch. Absent either one, the
adapter stays in Local Mode — this is a documented behavior contract,
not a fallback.

### 4.2 The six-step path

1. **Already running Local Mode** — `@strixgov/mcp-adapter` + your tools,
   receipts to a local JSONL sink, verified offline with
   `@strixgov/verifier`.
2. **Scaffold the env block.**
   `npx @strixgov/mcp-adapter init --with-connected-mode` generates the
   `STRIX_API_KEY` / `STRIX_TENANT_ID` block, initially unset. (Or add
   it by hand.)
3. **Account + key.** Create an account, issue an API key, set the two
   env vars.
4. **Behavior change is purely additive.** The SDK switches
   `LocalPolicyEngine` → `RemotePolicyEngine` (or hybrid: local
   enforcement, remote policy registry). The mcp-adapter starts
   background-syncing every signed receipt to the hosted evidence
   ingest endpoint. The local sink keeps writing. Local verification
   keeps working. Receipts signed before connecting stay verifiable
   indefinitely — same signatures, same JWKS resolution.
5. **The hosted console activates.** Live proof page, evidence search,
   approval inbox, compliance dashboards, quorum approvals, audit
   export.
6. **Optional next step.** Flip `STRIX_KMS_PROVIDER=aws` to move
   signing into AWS KMS. The provider abstraction enforces byte-parity
   with the env-var provider, so existing receipts stay verifiable
   bit-for-bit and new receipts use the same JWKS resolution path.

Rollback is symmetric: unset the two env vars, the SDK and adapter
revert to Local Mode. No code paths regress.

### 4.3 Why this shape

- **No vendor lock at the trust layer.** Receipts signed in Connected
  Mode are still verifiable by anyone via the public JWKS, using the
  same `@strixgov/verifier` binary. Strix is not in the trust path of
  the verdict — that property holds in both modes.
- **No code rewrite.** The same `governMCPServer(tools, opts)` call
  site works in both modes. The change is configuration, not
  architecture.
- **Receipts span the boundary.** A receipt signed locally last month
  and a receipt signed in Connected Mode today verify against the same
  JWKS and chain together.

---

## 5. The trust-anchor network effect

Every Strix receipt — wherever it was signed — carries a JWKS
resolution path that anchors at the canonical host. Once enough
receipts in the wild resolve via that JWKS, the canonical host becomes
a recognized trust anchor of record for AI-governance evidence.
Auditors learn to look there. Procurement teams reference it.

A copycat with the same code has zero install base anchoring at their
domain. Trust anchors are won by adoption, not by code.

This is why Local Mode stays open, free, and unrestricted: its
adoption *is* the moat.

---

## 6. Anti-patterns Strix will not adopt

These are tempting fixes to "they can use the tools standalone" that
contradict the trust commitment. They are written down here because a
public commitment is the credibility instrument.

| Anti-pattern | Why Strix rejects it |
|---|---|
| Phone-home telemetry from Local Mode | Breaks the "no Strix dependency on the trust path" property. |
| License-key gate inside `@strixgov/verifier` | The verifier is the credibility instrument. A gated verifier is structurally identical to a vendor PDF. |
| "Free tier expires after 30 days" trial timer in the SDK | A trial-mode SDK is not a trust primitive. |
| Requiring an account to verify | Verification is a one-liner against a public key. Anything else is observability with extra steps. |
| Crippling Local Mode evidence ("only the last N receipts retained without an account") | Silent degradation is the worst possible outcome — adopters assume they have governance, discover months later they don't. |
| Closing the source of the SDK or verifier | The MIT classification in `LICENSING_BOUNDARY.md` is permanent. |

These commitments are why Local Mode can be trusted in the first
place.

---

## 7. Verification (what's shipped vs roadmap)

To preserve claim discipline, this document distinguishes shipped
mechanism from planned mechanism:

| Claim | Status |
|---|---|
| Local Mode runs the full enforcement loop offline | Shipped |
| Connected Mode activates on `STRIX_API_KEY` + `STRIX_TENANT_ID` | Shipped — see `@strixgov/mcp-adapter` source |
| `LocalPolicyEngine` + `RemotePolicyEngine` | Shipped (governance SDK) |
| AWS KMS signing provider | Shipped; provider byte-parity locked by parity tests |
| Offline proof-bundle export route | Reference verifier shipped; producer-side route gated on trust-anchor ceremony |
| Compliance attestation generation | Planned |
| Redis token store for multi-instance | Planned |
| License-parity CI gate | Shipped — `scripts/lint-license-parity.mjs` |

Where a row is "Planned," the answer today is *"that's the next thing
we're closing,"* not *"that ships today."* The claim discipline holds
either way.

---

*This document is maintained as Strix's public commitment to the
shape of the Local → Connected boundary. The architectural mapping —
Local Mode wall → kernel capability — is the durable part; the
specific mechanism descriptions update as the implementation
hardens.*
