# @strixgov/verifier

**Prove an AI agent's decision was authorized — without trusting the
vendor that produced it.**

Runtime governance for AI agents is moving from a design-time / audit-time
concern to an **execution-time** concern. As autonomous AI systems land in
financial services, healthcare, public-sector operations, and infrastructure,
the question regulators are starting to ask isn't *"was this system designed
responsibly?"* but *"can you prove this specific decision was authorized at
the moment it was made?"*

That requires three things:

1. **Runtime authorization** — every governed action is evaluated before it executes
2. **Deterministic policy evaluation** — same inputs → same decision, every time
3. **Verifiable evidence** — any third party can confirm what was decided and that nobody altered it after the fact

What's rare about Strix is *where* the control sits and *who* it applies to:
the enforcement happens at the action boundary, and the same discipline
applies whether the actor is an agent, a human, or an automation. Most AI
governance today operates upstream of the action (prompts, evals) or
downstream (logs, post-hoc audit). Strix operates at the action itself.

This package is the public-facing layer of #3 — the open proof primitive
for that control. It is **a primitive, not the full Strix product** —
the runtime kernel that produces these records is a commercial product.
**Strix itself is never on the trust path** of this verifier. No
account, SDK, or API key required.

```bash
npx @strixgov/verifier@latest 5686
```

Record `5686` is a real governance evidence record signed by the Strix
kernel on 2026-05-15. Its signing key (`strix-prod-2026-05`) is published
in the production JWKS and retained for the EU AI Act minimum 2-year
window — this command remains a reproducible demo for at least that long.

By default the CLI queries:
- **Proof API:** `https://www.strixgov.com/api/proof/<id>`
- **JWKS:** `https://www.strixgov.com/.well-known/strix-jwks.json`

Override with `--proof-base` / `--jwks-base` for a custom deployment.

If you'd rather drag-and-drop than CLI, the browser-side equivalent is
at [verify.strixgov.com](https://verify.strixgov.com) — a pure-static
WebCrypto verifier for Visual Artifacts v1 signed SVG cards (verdict
cards, receipts, approval seals). Same Ed25519 + JWKS primitives, same
verdict, no Strix server on the trust path. See the `visual` subcommand
below for the matching CLI form.

`@strixgov/verifier` is a **public reference implementation of AARM Core
R6** (tamper-evident receipts) — the Cloud Security Alliance's open
specification for runtime governance of autonomous AI actions. Full
AARM mapping in the Standards alignment section below.

---

## What this package does — and what it does NOT do

This package is a **verifier**, not an enforcer.

| What this package does | What it does NOT do |
|---|---|
| Re-derives the canonical bytes of a signed evidence record and checks the Ed25519 signature against a public JWKS. | Decide whether an AI action is allowed to execute. |
| Reports whether a record was produced by the holder of Strix's signing key. | Block, throttle, or revoke any agent's action at runtime. |
| Walks the proof chain and checks per-record link integrity. | Issue execution tokens, evaluate policy, or hold approval state. |
| Derives EU AI Act compliance flags from cryptographic outcomes (never asserted). | Replace the runtime governance kernel that produced the record. |
| Verifies offline against a local JWKS file (tool-gateway receipts) or online against `www.strixgov.com` (evidence records, approval artifacts). | Connect to Strix, hold credentials, or require an account. |
| Proves what was supplied to it: the evidence, JWKS, and canonical payload. | Prove claims beyond the supplied artifacts. A signature confirms cryptographic provenance; it does not confirm that the underlying action was correct, ethical, or compliant with any policy the verifier wasn't given. |

The distinction matters: **the verifier proves the control occurred.
The runtime kernel makes the control happen.** A record that verifies
tells you that *if* a control was applied at execution time, it was
applied by the holder of the signing key whose public half is in the
JWKS. It doesn't tell you that a control *had to* be applied — that's
a property of the system that produced the record, not a property of
the signature.

If you're evaluating Strix as a runtime governance layer for autonomous
AI, the verifier is the open part of the trust chain — see
[strixgov.com](https://www.strixgov.com) for the rest. If you're an
auditor or regulator checking records that were already produced, the
verifier is all you need.

---

## Status & Roadmap

This package implements **Signed Evidence v1** verification. The
cryptographic primitives (Ed25519, SHA-256, JWKS / RFC 7517) are stable
and standards-based. The broader evidentiary architecture around them
continues to evolve.

**What's stable and shippable today:**

- Ed25519 signature verification against a public JWKS.
- SHA-256 canonical-payload hash reconstruction (13-field locked schema).
- Per-record proof chain link verification.
- Approval artifact + quorum verification (Phase 3).
- Tool-gateway receipt + chain verification (offline).
- Redacted-kid suffix matching for Gap-5 (`strix-***-YYYY-MM`).
- Composite verification states (VERIFIED / LEGACY_UNSIGNED /
  SIGNATURE_INVALID / SIGNING_KEY_UNKNOWN / HASH_MISMATCH /
  COMPLIANCE_VIOLATION).

**What's still evolving:**

- **Historical key rotation semantics.** The current 2-year retention
  window for retired kids satisfies EU AI Act minimums, but the
  long-tail semantics (what happens to a kid 5+ years after retirement,
  formal revocation list distribution) are still being designed.
- **Visibility semantics.** Public records start at evidenceId 42 by
  current policy. Records 1-41 exist in upstream systems but are not
  published to the public verification surface. The decision rationale
  for that boundary is documented in our internal CONSTRAINTS doc but
  is not part of this package's public surface yet.
- **Evidentiary readiness states.** The Gap 7 / UNAVAILABLE_RUNTIME
  state for records signed post-SE-v1 but with the signer unreachable
  at write time is partially surfaced. Reporting that distinct from
  LEGACY_UNSIGNED is still in flight.
- **Walk-to-genesis chain verification.** Per-record `proofChainHash`
  links are cryptographically bound in every signed payload today.
  A full chain walk from a given record to the genesis record is
  on the roadmap but not yet surfaced in the public REST or CLI APIs.
- **Cryptographic agent identity binding.** Verifiable agent identity
  (the largest AARM Extended capability) is planned for a subsequent
  release alongside the MCP gateway tooling. The current package
  covers AARM Core R1–R6 in full; identity binding is the next
  roadmap milestone and is not in scope for this release.

**What we explicitly do not claim:**

- This is not "the complete Strix product." It is the public
  cryptographic surface of one.
- "VERIFIED" is a statement about cryptographic provenance, not about
  the substantive correctness of the underlying decision.
- The verifier is at version 1.x and the canonical payload is at
  schema v1. A future v2 of either surface will ship side-by-side
  with v1 (no breaking flip) and the public communication will spell
  out the migration window.

---

## Quick start

```bash
# One-off verification against production, no install needed
npx @strixgov/verifier@latest 5686

# Or install once for repeated use
npm install -g @strixgov/verifier
strix-verify 5686
```

**Requirements:** Node.js 18.17+ or 20 LTS+ (earlier 18.x had `globalThis.fetch`
behind an experimental flag). **Zero runtime dependencies** — uses only Node's
built-in `crypto` and global `fetch`.

Expected output:

```
@strixgov/verifier — Evidence Record #5686
────────────────────────────────────────────────────
Capability:  cron.evidenceOutboxRetry
Action:      allow
Actor:       system:cron
Created:     2026-05-15T05:27:14.691Z
Key ID:      strix-prod-2026-05

Verification Results
────────────────────────────────────────────────────
  ✓ Hash valid:        true
  ✓ Signature present: true
  ✓ Signature valid:   true

  Status: VERIFIED

This record was cryptographically signed by the Strix governance kernel.
The evidence hash and signature are independently verifiable.
```

`Status: VERIFIED` is a **derived summary** of the three checks above —
true if-and-only-if all three are true. The detailed checks are always
reported so each can be audited independently.

---

## Offline verification — example fixtures

The `examples/` directory ships with self-contained fixtures that
demonstrate every verification state without needing network access.
Each fixture is signed with a **throwaway test key** (`examples/test-jwks.json`),
not the production key — they demonstrate byte-for-byte verification
semantics, not production identity.

| Fixture | Expected outcome | Demonstrates |
|---|---|---|
| `examples/verified.json` | `Status: VERIFIED` | Clean record + valid signature against test JWKS |
| `examples/tamper-hash.json` | Signature invalid | `evidenceHash` byte mutated; canonical bytes diverge from signed |
| `examples/wrong-key.json` | `SIGNING_KEY_UNKNOWN` | Record claims a kid not in the test JWKS |
| `examples/mutation-signature.json` | `SIGNATURE_INVALID` | First signature byte flipped; cryptographic check fails directly |

A small inline script in `examples/README.md` shows how to verify each
fixture in a few lines of Node. Re-generation is documented; anyone can
regenerate equivalent fixtures with a fresh throwaway key by running
the documented procedure.

---

## How verification works

For evidence records, every `strix-verify <evidenceId>` run does six
things — in this order, with no hidden state in between:

1. **Fetches the evidence record from the proof API.**
   `GET https://www.strixgov.com/api/proof/<id>` returns the record's
   stored canonical fields, the signature bytes, and the kid that
   identifies which public key was used. Override the host with
   `--proof-base`.
2. **Fetches the signing public key from the JWKS endpoint.**
   `GET https://www.strixgov.com/.well-known/strix-jwks.json`, then
   selects the JWK whose kid matches the record. Override with
   `--jwks-base`.
3. **Reconstructs the canonical 13-field signed payload.** Field order,
   types, and serialization are locked. Any drift in reconstruction
   produces different bytes and fails the next step. See
   [CANONICAL_PAYLOAD.md](CANONICAL_PAYLOAD.md) for the locked schema.
4. **Verifies the Ed25519 signature.** `crypto.verify(null, canonicalBytes, publicKey, signature)`.
   Pass → the bytes were signed by the holder of the private key whose
   public half is in the JWKS.
5. **Verifies the SHA-256 evidence hash.** Confirms the stored canonical
   fields match the hash that was originally chained into the proof
   chain. Pass → the record content hasn't been edited since signing.
6. **Reports pass/fail with the cryptographic details.** Default output
   is human-readable; `--json` returns a machine-readable object
   suitable for piping into auditing tooling.

The math is the same as any Ed25519 + JWKS verification. The contract
is: byte-for-byte canonical reconstruction must produce the bytes that
were originally signed. See [GOLDEN_VECTORS.md](GOLDEN_VECTORS.md) for
the byte-locked test vectors you can use to verify your own
reimplementation.

The CLI also runs a similar (but distinct) 5-step procedure for
`approval <artifactId>` and `quorum <decisionId>` — see `strix-verify --help`.

---

## What can be verified

| Surface | Subcommand | Mode |
|---|---|---|
| Governance evidence records | `strix-verify <evidenceId>` | Online (proof API) |
| Approval artifacts (e.g. HIGH-risk approvals) | `strix-verify approval <artifactId>` | Online (proof API) |
| Approval quorum (chain continuity + quorum satisfied) | `strix-verify quorum <decisionId>` | Online (proof API) |
| Evidence + linked attestations (E1.5) | `strix-verify <evidenceId> --include-attestations` | Online (proof API) |
| Tool-gateway receipts | `strix-verify receipt <file.json> --jwks <jwks.json>` | Offline (local file) |
| Receipt chains | `strix-verify chain <file.jsonl> --jwks <jwks.json>` | Offline (local file) |
| Visual Artifacts v1 (signed SVG cards) | `strix-verify visual <file.svg> [--jwks <jwks.json>]` | Offline / online (mixed) |
| Connected-mode wire envelopes | Programmatic: `verifyConnectedWireEnvelope(...)` | Inbound HTTP (server-side) |

**Mode legend:**
- **Online** — queries `www.strixgov.com` proof API + JWKS over HTTPS. Requires network.
- **Offline** — verifies a local JSON / JSONL file against a local JWKS file. Nothing leaves your machine.
- **Inbound HTTP** — validates incoming POST request bodies on your own server, using a kernel-issued public key. Used by integrators receiving push notifications from a `@strixgov/tool-gateway` instance in connected mode.

---

## CLI usage

> **Prerequisite for the examples below:** they assume you've installed
> the package globally (`npm install -g @strixgov/verifier`). If you
> haven't installed it, prefix every command with `npx --yes @strixgov/verifier@latest`
> in place of `strix-verify`. For one-off verification, the npx form is
> the recommended path.

```bash
# Online: verify a single hosted evidence record
strix-verify 5686

# Online: include the linked attestation graph
strix-verify 5686 --include-attestations

# Online: verify an approval artifact
# Artifact IDs are Prisma cuid strings (e.g. clx8k7n2a0000abcd1234efgh).
# You obtain real IDs from the approval workflow API or audit trail.
strix-verify approval <approval-artifact-id>

# Online: verify a full quorum chain for a decision
# decisionId is also a cuid string identifying the underlying decision.
strix-verify quorum <decision-id>

# Offline: verify a shipped tool-gateway receipt fixture
strix-verify receipt ./examples/receipt-verified.json --jwks ./examples/test-jwks.json
# (For offline evidence-record verification, the `receipt` subcommand
# uses a different schema. Use the programmatic API instead — see
# examples/README.md for the 6-line snippet.)

# Offline: walk an append-only receipt chain
strix-verify chain ~/.strix-gateway/receipts.jsonl --jwks ./public-jwks.json

# Verify a Visual Artifacts v1 SVG (browser parity with verify.strixgov.com).
# Reads the embedded canonical payload, recomputes sha256, verifies the
# embedded Ed25519 signature against a pinned JWKS (and the live JWKS if
# reachable), and surfaces drift between the two if any. Same verdict the
# browser produces.
strix-verify visual ./receipt.svg --jwks ./pinned-jwks.json

# JSON output (machine-readable, for piping into auditing tooling)
strix-verify 5686 --json
```

**Note on the `~/.strix-gateway/` path:** that's the default tool-gateway
storage root on macOS / Linux. On Windows PowerShell, `~` is not expanded
by the verifier; substitute the full path (typically
`C:\Users\<you>\.strix-gateway\receipts.jsonl`) or run from a shell that
expands `~` (Git Bash, WSL).

Override the upstream endpoints when verifying against a non-default
deployment:

```bash
strix-verify 5686 \
  --proof-base https://your-deployment.example.com \
  --jwks-base  https://your-deployment.example.com
```

---

## Verification states

For evidence records, the verifier reports three cryptographic checks
independently. Their conjunction is the `Status` field.

| Status | Meaning | What to do |
|---|---|---|
| **VERIFIED** | Signature + hash + presence all valid against a recognized public JWK. The record is exactly what was signed. | Trust the record's content as cryptographically attested. |
| **UNSIGNED** | The record has no signature column populated. | Treat as audit-only; not cryptographically verifiable. |
| **LEGACY_UNSIGNED** | The record predates Signed Evidence v1 (April 2026). | Same as UNSIGNED but explicitly historical. |
| **SIGNING_KEY_UNKNOWN** | The kid on the record isn't in the JWKS. | Check the JWKS retention policy; if the kid should be there during the 2-year retention window, file an issue. |
| **SIGNATURE_INVALID** | Signature present but Ed25519 verification failed. | The record was tampered with after signing, OR the verifier itself has a reconstruction bug. Upgrade to the latest verifier first; if still failing on a record strix reports as VERIFIED, file an issue with the record ID. |
| **HASH_MISMATCH** | Signature is valid but the canonical hash diverged. | Same triage as SIGNATURE_INVALID. |
| **COMPLIANCE_VIOLATION** | Composite of the above — record fails one of the structural cryptographic checks. | Same triage as SIGNATURE_INVALID. |

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | VERIFIED |
| 1 | Verification failed (any non-VERIFIED status that isn't an error) |
| 2 | Error (network, missing key, malformed input) |

---

## Trust model

The verifier is engineered to **not depend on Strix's existence** for its
trust path. The only inputs to a verification are:

1. The signed evidence record (canonical fields + Ed25519 signature).
2. The matching public key, fetched from a public JWKS endpoint.
3. Standard Node.js `crypto` primitives.

Three stability guarantees on the JWKS surface:

- **2-year minimum retention** for historic kids (EU AI Act Article 12 / 28).
- **No kid reuse** — once a kid is published, the same string never refers to a different keypair.
- **Cache headers** (`s-maxage=60`) deliberately short so revocations propagate within a minute.

If you snapshot the JWKS today and a record signed today, you can verify
that record forever — even without re-fetching anything. The verifier
supports this via the `receipt`/`chain` subcommands (with `--jwks` pointing
at a local file). Evidence-record verification currently requires the
online proof API; offline evidence-record verification with the
programmatic API and a local snapshot is supported and documented in
[`examples/README.md`](examples/README.md).

---

## Documentation

| Document | What it covers |
|---|---|
| [JWKS.md](JWKS.md) | JWKS public contract: endpoint, key format, retention, redaction, rotation. |
| [CANONICAL_PAYLOAD.md](CANONICAL_PAYLOAD.md) | Signed Evidence v1 13-field schema, field-by-field. Required reading for anyone reimplementing the canonical builder. |
| [GOLDEN_VECTORS.md](GOLDEN_VECTORS.md) | Byte-locked test vectors. Reproduce our results in your own language / runtime. |
| [SECURITY.md](SECURITY.md) | Responsible disclosure flow. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to file issues and PRs. |
| [MIRROR.md](MIRROR.md) | Where the source of truth lives and how the public release is synchronized. |
| [CHANGELOG.md](CHANGELOG.md) | Version history. |

---

## Standards alignment

Strix is listed in the [Cloud Security Alliance AARM Builders Registry][csa-aarm-wg]
with status **Aligned**. AARM (Autonomous Action Runtime Management) is
the CSA-led specification for governing AI agents at execution time. The
full specification text lives at [aarm.dev](https://aarm.dev/) (donated to
CSA by Vanta, paper [arXiv:2602.09433](https://arxiv.org/abs/2602.09433)).

`@strixgov/verifier` is a **public reference implementation of AARM
Core R6** — tamper-evident receipts independently verifiable using
Ed25519 + JWKS, with no vendor trust path. The verifier covers Core
R1–R6 in full, with the next milestones (walk-to-genesis chain
verification + cryptographic agent identity binding) on the published
roadmap.

The per-requirement mapping (Core R1–R6, Extended) lives at
[strixgov.com/partners/aarm](https://www.strixgov.com/partners/aarm).

[csa-aarm-wg]: https://cloudsecurityalliance.org/research/working-groups/ai-systems-management

---

## Versioning

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

- **Patch (`1.9.x`)**: bug fixes, error-message improvements, doc updates. No behavior change to the verification outcome of an already-passing record.
- **Minor (`1.x.0`)**: additive features (new subcommand, new state, new endpoint surface). Existing verification logic unchanged.
- **Major (`x.0.0`)**: locked schema change (e.g., Signed Evidence v2). Will ship side-by-side with v1 — never a hard cutover. Migration window documented in the gate report.

**Upgrade urgency:** any release ≥ 1.9.3 includes the response-flatten
correctness fixes from May 2026. If you see `COMPLIANCE_VIOLATION` on
records that Strix's own UI reports as `VERIFIED`, run
`npx clear-npx-cache && npx @strixgov/verifier@latest <id>` to ensure
you're on the latest.

---

## License

MIT. See [LICENSE](LICENSE).

The verifier is intentionally permissively licensed so it can be
embedded in audit tooling, regulatory pipelines, security review
infrastructure, and any other system that benefits from being able to
independently confirm Strix's cryptographic claims. **Verification
should never be gated on Strix's existence as a company.** If Strix
shuts down tomorrow, the JWKS snapshot and the canonical-payload schema
keep every retained record verifiable.
