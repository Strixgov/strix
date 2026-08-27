<!--
  PUBLICATION RECORD — repository metadata header.
  The review body below this marker is byte-identical to the form published
  on 2026-08-26; this header is the only addition. This repository copy is
  the canonical technical copy of the review; the gist is retained as the
  original publication mirror.
-->

**Publication record**

- **Series:** Execution Governance Reviews — [index](README.md) (series rules, dimensions, corrections process)
- **Pinned target commit:** `andrewyng/openworker` @ `7fc3ee68e61b7e6610959a4068f15a2eda1e2630` (read 2026-08-26)
- **Published:** 2026-08-26
- **Scores:** capability model ★★★☆☆ · policy/trust root ★★★☆☆ · execution control ★★★★☆ · evidence ★★☆☆☆ · independent verification ★☆☆☆☆
- **Scope and limitations:** a point-in-time read of public source only; scores describe the pinned commit at the read date, not today's tree; full route adoption of the reviewed gate is explicitly NOT established by this review (see the body's execution-control section)
- **Original publication mirror (gist):** <https://gist.github.com/Tarshann/e3fa136be8e45abe152e9fbe979d1adf>
- **LinkedIn article:** <https://www.linkedin.com/pulse/execution-governance-review-05-openworker-strix-gov-zt3cc/>
- **Companion post (immutable URN):** <https://www.linkedin.com/feed/update/urn:li:ugcPost:7498455316175405056/>
- **Corrections:** open an issue in this repository citing the cited file/symbol at the read date; accepted corrections are recorded here, never silently edited. Correction log: none.

---

# Execution Governance Review #05 — OpenWorker

**Track:** Repository
**Target:** `github.com/andrewyng/openworker` (desktop AI coworker: Tauri shell +
local Python agent server; Python backend package `coworker/`)
**Read date:** 2026-08-26 (shallow clone at commit `7fc3ee68e61b7e6610959a4068f15a2eda1e2630`)
**Reviewer rubric:** the series' five fixed dimensions — capability model · policy/trust root · execution control · evidence · independent verification — scored ★–★★★★★, every score cited to a file + named symbol at a pinned commit (with load-bearing code quoted verbatim)

> Point-in-time read of an open-beta project that updates itself; symbols will
> move. This review cites file paths + symbol names, no line numbers, so
> findings can be re-checked against a later commit.

---

## Lead: soft vs. hard governance

This is the first target in the series where the headline finding is *not* a
missing or off-path gate. OpenWorker ships the most serious pre-execution
enforcement layer these reviews have examined: a central permission engine
that decides allow / deny / ask-a-human for each proposed tool call *before*
it runs, refined by argument-level analysis rather than tool name alone, with
several genuinely fail-closed edges and a human-only floor no auto-approve path can override. Where the first four reviews had to show why a gate that looks hard
is actually cooperative, off-path, or unchecked at resume, this one has to do
the opposite job: keep one strong layer from standing in for three others.

Because the strength is real, the precision matters. Three properties are
*separate* from the quality of the permission engine, and each is scored on
its own evidence rather than inherited from the engine's:

1. **Classification completeness** — the gate only fires on calls classified
   consequential, and the classifier's fallback for an unknown, undeclared
   tool is read-only (= run without the gate), not fail-closed.
2. **Route adoption** — a strong central evaluator is not the same claim as
   "every consequential action routes through it"; this review establishes
   the former from source and treats the latter as its own finding.
3. **Evidence verifiability** — the audit trail is a durable operational
   record, not a tamper-evident one, and both audit sinks swallow write
   failures, so execution proceeds when recording fails and nothing marks
   the gap.

One more first for the series: OpenWorker puts a *second model* on the
approval path — an "Auto-Approve reviewer" — and bounds it structurally
rather than by prompt. That composition (a soft component with hard limits on
what it may decide) deserves its own precise treatment under policy / trust
root, because it is neither the cooperative pattern of Review #01 nor the
unscoped standing authority of Review #03.

---

## Scores

| # | Dimension | Score | One-line basis |
|---|-----------|-------|----------------|
| 1 | Capability model | ★★★☆☆ | Effect classes are declared data (`RiskClass`, `classify`) with direction-locked overrides — but classification is not total: an undeclared tool defaults to read-only, and the right to call a tool is still holding a reference to it |
| 2 | Policy / trust root | ★★★☆☆ | Authority originates outside the model (modes, config, human clicks) and the agent cannot reach its own policy files through its own tools — but the roots are mutable local files, and a bounded model verdict can stand in for a human click on the ask path |
| 3 | Execution control | ★★★★☆ | A real, on-path, argument-analyzing pre-execution gate with fail-closed edges and one-shot exact-action approvals — capped because coverage is decided by a classifier that fails open at its edge, and full route adoption is not established by this review |
| 4 | Evidence | ★★☆☆☆ | The most complete operational audit record in the series (durable SQLite, staged lifecycle, secret redaction) — but mutable rows, no cryptographic provenance, and audit-write failures are swallowed while execution proceeds |
| 5 | Independent verification | ★☆☆☆☆ | Nothing signed or canonically serialized exists at any layer examined; the project's own trust story ("audit the harness") is a static claim about what the code *can* do, with no artifact establishing what it *did* |

---

## 1. Capability model — ★★★☆☆

Tool risk is a **declared property**, not an inline name check. `coworker/risk.py`
defines a closed effect vocabulary — `READ`, `EGRESS`, `WRITE_LOCAL`, `EXEC`,
`EXTERNAL` — and a single `classify()` that resolves a tool's effective class
from a by-name base table, a connector-catalog floor, aisuite metadata, and a
user-local override store. Two design details earn credit on their own:

- **Override direction is locked.** A user override "may *relax* a
  metadata/MCP tool … but may only ever **tighten** a built-in
  write/exec/egress tool or a connector-catalog write, never loosen one"
  (`classify()`'s own docstring). Downgrading a write to a read is refused
  because it would switch off path scoping and the read-only gate at once.
- **Effect class drives different treatment**, not one generic gate: writes
  get path scoping against writable roots, egress gets domain allowlists and
  host-named approval cards, exec gets mode gating plus command analysis.
  The model-chosen-egress reasoning in `risk.py` (why `web_search`'s
  free-text query is an outbound channel even though its destination is
  fixed; why contact-enrichment lookups are "the `web_search` case with
  worse payloads") is unusually honest threat analysis, in source, where it
  binds behavior.

Why not higher. First, **classification is not total**: after the base table,
the catalog floor, and a `requires_approval` metadata check, an unknown tool
falls through to `READ` —

```python
if bool(getattr(metadata, "requires_approval", False)):
    return RiskClass.EXTERNAL
return RiskClass.READ
```

— and `is_consequential()` is defined as "anything but a pure read," so a
READ-classified tool never reaches the permission engine's gates at all
("Non-consequential tools always run", `permissions.py`). The high-consequence
surfaces reviewed do not exhibit it: MCP servers default to `requires_approval:
True` (`mcp/config.py`, both the dataclass default and the raw-config parse),
the connector catalog floors its own tools, and the override store cannot
loosen built-ins. But the edge is live in-tree at the pinned commit, not
hypothetical: the team-board verbs (`teams/tools.py` — `create_item`,
`transition`, `assign`) mutate the local team store, carry no
`requires_approval` metadata, and appear in no base risk table, so they
classify READ and run ungated. The blast radius is low — local coordination
data — but it is an instance of exactly this fallback. And it is real
extension-safety pressure on metadata correctness — a newly introduced or
third-party tool that is consequential while its metadata is absent or wrong
is treated as non-consequential, silently. The degraded state is full-allow,
not an unknown-requires-resolution state. For a
harness whose selling point includes "any tool reachable over MCP plugs in,"
that edge matters more operationally than it looks.

Second, the capability model stops at classification. There is no construct
separating the capability to invoke a tool from the authority to execute it —
no grantable, attenuable, revocable authority object. The right to call a
tool is holding a reference to it, gated per-call by the engine. That is a
strong *policy* layer over a thin *capability* layer.

- *Cite:* `classify`, `RiskClass`, `_BASE`, `_catalog_floor`, `is_consequential`
  — `coworker/risk.py`; `MCPServerDef.requires_approval` — `coworker/mcp/config.py`;
  MCP tool wrapping — `coworker/mcp/tools.py`.

---

## 2. Policy / trust root — ★★★☆☆

Authority does not originate in the model. The permission engine's inputs are
the session **mode** (Plan read-only · Interactive · Auto), user config
(allowlists, writable roots, domain lists), per-session grants from explicit
human clicks, and the risk classification — all external to the agent's
prompt and generation. Three constructions push this above the series
baseline:

- **A self-protection floor the agent cannot click through.** Before mode,
  allowlists, and every auto-approve path, write/shell calls touching
  OpenWorker's own settings — including the risk-override store and the
  database carrying saved grants — are refused with `needs_user=False`:
  "no human click in the flow can grant it either: loosening requires
  editing the files out-of-band" (`permissions.py`, `_touches_protected`).
  The policy store is unreachable *through the governed surface itself*.
- **Persistent authority is human-only.** Tools whose effects outlive the
  session are forced to a person, "over the reviewer and over every
  allowlist below," deliberately placed so a metadata slip cannot switch
  the floor off (`PERMANENT`-style handling of `PERSISTENT_AUTHORITY_TOOLS`
  in `permissions.py`).
- **The Auto-Approve reviewer is a soft component with hard bounds.** A
  second model call judges one proposed action against what the user asked
  — and the engine's wiring constrains what its verdict can do: it is
  consulted *only* on decisions the gate marked ask-a-human ("hard denies
  never reach it"), so it "can only turn 'ask the human' into 'go ahead' —
  never 'blocked' into 'go ahead'"; malformed output, timeouts, and unknown
  verdicts all fail closed to the human; and its input deliberately excludes
  page text, mail bodies, and file contents so "the attacker can address the
  agent, never the judge" (`coworker/reviewer.py` header; consultation sites
  in `engine.py`). This is a genuinely new shape for the series — contrast
  Review #03, where one `always_approve` decision generalizes into unscoped
  standing authority with no bound at all.

Why not higher. The trust roots are ordinary mutable local files and an
in-process engine: anything on the machine outside the governed surface — the
user, other software, or the agent via an approved shell command the analysis
does not catch — can rewrite policy, and nothing signs or attests the policy
that was in force when a decision was made. And the reviewer, bounded as it
is, means a model verdict *does* substitute for a human click on the ask
path in Auto mode: the bound is real, the substitution is also real, and
both halves belong in the score. Session-scoped "always allow" grants are
standing authority — scoped to a command prefix or domain and deliberately
excluded from some paths, far more careful than Review #03's version, but
still a human decision that generalizes beyond the action it approved.

---

## 3. Execution control — ★★★★☆ (the headline dimension)

**(a) The gate is on the ordinary dispatch path and decides before
execution.** The turn engine's authorization step calls
`PermissionEngine.evaluate(tool_name, arguments, metadata)` for each proposed
call; denied calls get a tool-error message appended and the call never runs;
execution (`_execute_sync` via a worker thread) happens only past that flow
(`coworker/engine.py`, `_authorize`; `coworker/permissions.py`, `evaluate`).
This is not a hook a caller may forget (Review #01) and not a mechanism
sitting beside the path (Review #04) — on the paths this review inspected, it
is the path.

**(b) The argument analysis assumes an adversarial command line.** Compound
commands are split on every separator before checking, "over-splitting only
ever produces MORE parts to justify, never fewer"; commands carrying opaque
constructs (substitution, redirection, variable expansion) are never
prefix-eligible; programs that run *other* programs named in their arguments
(`xargs`, `sudo`, `npx`, `docker`, …) always fall through to approval, as do
interpreters carrying inline code (`python -c`, `node -e`) and flags that
turn a search tool into a deletion tool (`find -exec`, `-delete`). Each rule
in `permissions.py` documents the bypass it closes.

**(c) Fail-closed edges exist where they are hardest to keep.** A write
whose path cannot be located "is not scoped-able, so it fails closed to
approval rather than slipping through auto/custom unscoped" — and that
approval is marked human-only, above the reviewer. Read-only modes hard-deny
consequential calls. In-project files that execute later (git hooks, CI
config) may be edited but never via an auto-approve path.

**(d) One-shot approvals bind the exact action and are consumed.**
`approve_action_once()` registers a human approval for "this EXACT action
(same tool, byte-identical canonical arguments)"; anything that differs at
all goes through the normal flow; the grant is "never standing: consumed on
first use" (`_consume_allow_anyway`). This is the single-use,
payload-bound approval semantics Reviews #02 and #03 were docked for
lacking — present here, at the exact-argument granularity.

**(e) Provenance feeds the gate.** The engine records what the agent itself
wrote or downloaded this session (`coworker/provenance.py`) and treats
running a file the agent just fetched as the fetch-then-execute chain it is —
a fact "the engine knows [that] neither of them does" surfaced at the
decision point, with the module honestly declining to claim general taint
tracking ("a miss leaves behaviour exactly as it is today, so partial
coverage only ever moves toward caution").

**(f) Unattended operation parks asks instead of lowering the bar.** The
unattended toggle changes "*where the human is reached*," not the autonomy
ceiling: prompts route to an inbox and the agent suspends
(`coworker/unattended.py`).

**Why ★★★★ and not ★★★★★ — the two bounds, stated as their own findings.**

First, **the gate's coverage is decided by a classifier that fails open at
its edge** (dimension 1's finding, restated here because this is where it
bites): a tool classified READ never reaches any of the machinery above. The
engine's quality cannot repair a misclassification, because a misclassified
call is precisely one the engine never sees.

Second, **route adoption is established for the paths inspected, not
exhaustively.** What this review verified from source: engines are
constructed through one `build_engine()` (`coworker/agent.py`) that wires the
`PermissionEngine`; scheduled automations build their engines through the
same constructor (`server/manager.py`, `_build_task_engine`, in Interactive
mode with task standing rules feeding the same matcher); MCP tools are
wrapped into ordinary registry tools carrying metadata the engine reads
(`mcp/tools.py`). What this review did *not* do is disposition every
execution route — connectors invoked outside a turn, background and callback
work, approval-resolution paths, the application's own non-agent subprocess
use — into mediated / structurally disabled / isolated / outside-the-claim.
Until someone does, the precise statement is: *OpenWorker has a substantial
central permission engine used by its normal tool-execution path* — not
*every consequential action is governed through one non-bypassable
boundary*. The strong layer must not be allowed to vouch for the claim the
inventory would establish.

---

## 4. Evidence — ★★☆☆☆

The audit layer is the most complete operational record the series has seen:
a durable SQLite store (`coworker/audit.py`, `AuditStore`) with per-call
staged lifecycle events (proposed / started / finished / auto_allowed /
denied), approval outcomes, session and workspace context, token counts, and
deliberate secret redaction before rows are written. Reviews #01, #03, and
#04 had nothing durable at all; Review #02's checkpointer persisted state as
a working buffer. Credit where due: this is a real record, designed as one.

It is not evidence in this dimension's sense, for three reasons:

1. **Mutable, unprovenanced rows.** No signature, no hash chain, no
   canonical serialization, no key material anywhere in the audit path. The
   only content hash found in the backend serves an unrelated gallery
   feature. Any process with write access to the
   store — on a typical single-user install, any same-user software,
   including the governed agent itself through an approved command the
   analysis does not catch — can rewrite history without cryptographic
   detection.
2. **Audit failure is swallowed while execution proceeds.** Both audit sinks
   in `engine.py` wrap the write in `try: … except Exception: pass` (the
   `_audit` method and the sink call inside `approve_action_once`). That is
   a defensible availability choice for observability — and incompatible
   with reading the trail as "every consequential action produces a
   record." A gap in the record is indistinguishable from nothing having
   happened; no state marks "executed, recording failed."
3. **No binding between decision, arguments, and outcome.** The stages are
   correlated rows, not a bound artifact: nothing cryptographically ties the
   approval that was granted to the bytes that ran to the result that was
   recorded.

A useful contrast inside the same codebase: the *one-shot approval* path
already thinks in exactly the terms tamper-evidence needs (exact action,
byte-identical canonical arguments, consumed once). The audit path does not
yet apply that discipline to its own records.

---

## 5. Independent verification — ★☆☆☆☆

Nothing is signed or canonically serialized at any layer examined, so there
is no artifact a third party can check — the unanimous finding of this
series, now five for five. It lands differently here, though, because the
project's own positioning leans on inspectability: the harness is open source
and local-first — "Everything lives on your machine" is the README's own
privacy framing (README §Privacy, at the pinned commit) — and the launch
announcement presents that inspectability, for security-minded work, as the
trust story. That framing is true and valuable — and it is a *static*
claim. Auditing source bounds what the harness *can* do; it establishes nothing about what any given
installation *did*, under which policy, with whose approval. For a tool
whose launch framing includes security work — and which supports open-weight
and fully local models (README, provider list), i.e. runs with fewer
model-side guardrails — the gap between "inspectable code" and "verifiable
record" is not academic. Today the answer to "prove what the agent executed
last Tuesday" is a mutable SQLite file whose writes are allowed to fail
silently.

---

## The one architectural question

> The permission engine already refuses to guess about *arguments*: a write
> whose path cannot be located "fails closed to approval rather than
> slipping through auto/custom unscoped" — marked human-only, above the
> reviewer. Why does a tool whose *effect* cannot be classified fail open to
> READ? `classify()`'s final fallback treats an unknown, undeclared tool as
> non-consequential, and non-consequential tools always run — so the
> engine's coverage is decided at the one point in the stack that defaults
> permissive. Extending the same fail-closed discipline from arguments to
> classification — an explicit UNKNOWN effect class that gates like
> EXTERNAL until a human or a declaration resolves it — would make the
> permission engine's coverage total, using a refusal shape the codebase
> already ships.

That question is fair (it credits a discipline the project already applies
where it is hardest), specific (it names the exact fallback and the exact
sibling behavior to mirror), and small: it changes a default, not an
architecture.
