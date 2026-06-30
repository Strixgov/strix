# @strixgov/rcm-reference

**The canonical governed-agent reference architecture for healthcare revenue-cycle management (RCM).**

The same prior-authorization agent runs the **same task twice** — once
**ungoverned** (policy + guardrails only) and once **governed by a Strix
execution gate** — across six real-world failure modes, on a **real X12 278**
protocol surface, with **synthetic patients only**. In every scenario the
ungoverned run lets a wrong, duplicated, out-of-scope, or wrong-patient action
execute; the governed run re-evaluates the action **at the moment it executes**
and stops (or holds) it, emitting a signed governance record either way.

> **The thesis, in one line:** policy and guardrails check the agent's **plan**.
> Strix checks the **action at the instant it executes**. A correct plan can
> still produce a wrong write — that last inch is where this reference lives.

```bash
git clone https://github.com/Strixgov/strix
cd strix/packages/strixgov-rcm-reference
npm install
npm run duplicate:governed     # or :ungoverned — and 5 more scenarios
npm run visualize              # side-by-side HTML you can open + screenshot
npm test                       # 13 invariant regression tests
```

> **Safety first — read [`DEMO-SAFETY-BOUNDARY.md`](./DEMO-SAFETY-BOUNDARY.md).**
> Real protocols, **synthetic patients only**, a **mock payer we own** (or a
> cleared sandbox). It never touches a live production payer / clearinghouse /
> EHR. There is no production target in the code.

---

## The six scenarios (each grounded in a production failure mode)

| Scenario | The veer | Ungoverned | Governed (Strix) |
|---|---|---|---|
| `duplicate` | Retry/replay fires the same 278 twice | Duplicate auth → dedup / recoupment | Blocked `REPLAY` (single-use) |
| `scope-creep` | Agent also posts an unapproved write-off | $1,250 write-off recorded | Blocked `UNAUTHORIZED` (no token for that action) |
| `injection` | Inbound note injects a wrong CPT | Wrong procedure authorized, looks valid | Blocked `SCOPE_MISMATCH` (outside approved scope) |
| `intercept` | High-cost study with no human sign-off | Fires immediately, no human in loop | **HELD** `INTERCEPTED` — routed for approval, not denied |
| `downcode` | Legitimate in-family downcode (contrast allergy) | Submits, but no proof it was in scope | **ADMITTED** + signed in-scope proof (Strix does *not* block legitimate work) |
| `batch-bleed` | Context bleed → wrong patient's member ID | Wrong-patient 278 reaches payer | Blocked `SCOPE_MISMATCH` (member ID ≠ approved patient) |

The `intercept` and `downcode` pair is deliberate: a credible governance layer
is not "block everything." It **holds** the genuinely high-risk action for a
human and **admits** the legitimate adjustment — with a signed record proving it
was in scope.

---

## Capability matrix — the canonical governed-agent surfaces

This reference is the **execution-control** chapter of the Strix story. It is
honest about what it demonstrates end-to-end versus the production trust
primitives it **composes with** (sibling packages in this repo) versus what is
explicitly **on the roadmap**.

| Capability | Status here | Where |
|---|---|---|
| **Execution control** (re-evaluate every action at point-of-use; single-use, time-bound, revocable, intent-bound authorization) | ✅ Demonstrated end-to-end | `src/governance/` — faithful re-impl of the upstream decision-token contract |
| **Signed evidence** (a signed record for every gate decision) | ◑ Demonstrated with an HMAC governance record | `src/governance/gate.ts`. Production-grade **Ed25519 SE v1** signed evidence lives in [`@strixgov/healthcare-demo`](../strixgov-healthcare-demo/) |
| **Independent verification** (third party re-checks the crypto, no Strix tooling) | → Composed primitive | [`@strixgov/verifier`](../strixgov-verifier/) — `npx @strixgov/verifier <evidenceId>` |
| **Proof receipts / compliance derivation** (EU AI Act + HIPAA flags derived from verification, never asserted) | → Composed primitive | [`@strixgov/healthcare-demo`](../strixgov-healthcare-demo/) shows the full sign → verify → derive round-trip |
| **Approval artifacts** (signed, quorum-checkable approvals) | ○ Roadmap | Modeled by the `intercept` hold; signed approval-artifact integration is tracked below |
| **Governed MCP execution** (wrap any MCP tool at the action boundary) | → Composed primitive | [`@strixgov/mcp-adapter`](../strixgov-mcp-adapter/) · [`@strixgov/mcp-proxy`](../strixgov-mcp-proxy/) |

Legend: ✅ demonstrated here · ◑ demonstrated with a reference-grade stand-in ·
→ composed production primitive (sibling package) · ○ roadmap.

**Why this composition is the honest story:** independent verification only has
value if the verifier is a separate, inspectable primitive — so this reference
does not re-implement the cryptographic verifier; it points at the real one.
The execution-control layer is what this package proves, against a real RCM
protocol surface, with a deterministic harness anyone can re-run.

---

## How the governance is real, not theater

`src/governance/` re-implements the Strix decision-token contract from the
upstream console (`apps/strix-console/src/lib/decisions/tokens.ts`): the same
opaque token format (`stx1.<jti>.<sig>`), the same canonical HMAC signature
payload, the same `actionParamsHash` **intent-binding**, the same **atomic
single-use** redemption, and the same deny-reason vocabulary
(`REPLAY` / `EXPIRED` / `SCOPE_MISMATCH` / `NOT_FOUND` / `BAD_SIGNATURE`) plus
`UNAUTHORIZED` and the `INTERCEPTED` hold state. It enforces the five Strix
invariants in code; set `KERNEL_URL` to defer to a hosted kernel instead.

The "veer" in each scenario is an injected real-world condition (a retry, an
injected instruction, a context bleed), not a contrived bug — and the harness
is deterministic, so every run (and every filmed take) is byte-identical. The
only variable between the paired runs is whether the action routes through the
gate.

---

## What's in here

```
src/
  config.ts             target/mode config; forbids a production target
  data/patients.ts      synthetic patients — Synthea-shaped, no PHI
  protocol/x12-278.ts   real X12 278 generator + content hashing
  adapters/             payer interface + MockPayer + (gated) SandboxPayer seam
  governance/           faithful Strix execution tokens + the gate
  agent/tools.ts        execution runtime (governed routes through the gate)
  scenarios/            the six deterministic scenarios
  console/render.ts     filmable terminal renderer
  visual/               self-contained HTML renderer (side-by-side)
  run.ts · visualize.ts CLI entry points
test/                   13 invariant regression tests (npm test)
package/                buyer-facing collateral: self-test, comparison, shot-list
brand/                  Strix design-system lockup + tokens (applied to visuals)
scripts/capture.mjs     Playwright PNG + reveal-GIF capture (npm run shots)
```

`package/` is the buyer-comprehension layer: a three-question **self-test**, the
plan-time-vs-execution-time **comparison**, and a 12-clip **filming shot list**.

---

## Roadmap (toward the full canonical reference)

Tracked, explicit, and honest about current vs. planned:

1. **Real Ed25519 evidence + independent verify in-loop** — emit each gate
   decision as an SE-v1 signed record and verify it with `@strixgov/verifier`
   inside the reference run (promotes the ◑ rows to ✅).
2. **Governed MCP execution example** — run the prior-auth agent's tools through
   `@strixgov/mcp-adapter` so the governed path is a real MCP round-trip.
3. **Signed approval artifacts** — turn the `intercept` hold into a real
   signed, quorum-checkable approval artifact.
4. **Breadth across the revenue cycle** — eligibility (270/271), claims (837),
   denials/appeals, remits (835), each with a governed/ungoverned scenario.
5. **Worklist UI** — a small RCM console front-end over the existing engine.

---

## Relationship to the rest of this repo

- [`@strixgov/verifier`](../strixgov-verifier/) — the cryptographic primitive everything is checked against.
- [`@strixgov/healthcare-demo`](../strixgov-healthcare-demo/) — the sign → verify → compliance-derivation round-trip (the proof layer this reference's enforcement layer composes with).
- [`@strixgov/mcp-adapter`](../strixgov-mcp-adapter/) · [`@strixgov/mcp-proxy`](../strixgov-mcp-proxy/) — governed MCP execution.

Source of truth is upstream in the Strix monorepo; this is the public mirror.
See [`../../MIRROR.md`](../../MIRROR.md).

## License

MIT — see [`LICENSE`](./LICENSE). The open trust primitives stay MIT so anyone
can inspect, run, and fork them.
