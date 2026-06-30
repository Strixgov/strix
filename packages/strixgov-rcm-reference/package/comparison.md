# Plan-time controls vs. execution-time control

*(The explanation that accompanies the clips. Names what you just watched.)*

Policy and guardrails are **plan-time** controls — they evaluate intent *before*
the agent acts. They're necessary, and a top-tier stack has strong ones. The
failures in these clips happen one layer down, at **execution time**, where a
correct plan still produces a wrong write.

| What actually happens in production | Plan-time guardrails | Execution-time control (Strix) |
|---|---|---|
| Plan is correct, but the 278 submits to the **wrong payer / wrong patient** after a context switch | Plan looked clean → passes | Action doesn't match the approved scope → blocked before it fires (`SCOPE_MISMATCH`) |
| Agent re-runs / retries and submits the **same auth or claim twice** → denial, recoupment | No concept of "already used" | Authorization is **single-use**; the second fire can't redeem (`REPLAY`) |
| Task was "submit auth," agent **also posts an adjustment / write-off / marks ready-to-bill** | Each step looks individually plausible | Authority doesn't transfer between actions; the extra write was never approved (`UNAUTHORIZED`) |
| Approval granted early in a **long-running session** gets reused later against changed context | Standing trust persists | Authorization is **time-bounded and revocable mid-task** (`EXPIRED` / revoked) |
| Inbound document (fax / portal / EHR note) **injects an instruction** that shifts the action | Filters the prompt, not the resulting tool call | The resulting action is re-evaluated against approved scope at point-of-use |

**The one-line version:** *We have controls on what the agent decides. We don't
have a hard gate on what the agent actually executes.* That second gate is the
entire job of Strix — and it's what the governed clips are demonstrating.

### What you're seeing in the governed clips, precisely

Every state-changing action routes through an execution gate. At the moment it
runs, the action is re-checked against what was actually approved — the exact
member, payer, and procedure code — using a single-use, time-bound, revocable
authorization. A diverged, duplicated, or out-of-scope action carries no valid
authorization for *that* action, so **it never executes**, and the block is
written as a signed evidence record you can verify independently.

> Scope note (kept honest): Strix evaluates each action against its **approved
> scope and parameters** at point-of-use. It works because the agent's writes
> route through the gate — it is not "reading the agent's mind," and it does not
> claim to detect an agent impersonating a human user. It enforces that what
> executes matches what was approved.
