# Cover email — lead → vendor

*Send this with `proof-deck.html` attached (or screenshots of it). Personalize the bracketed bits.*

---

**Subject:** Where a clean plan still ships the wrong claim

Hi [Name],

You've got strong policy and guardrails on your prior-auth agents — I'm not questioning that. But there's a gap I couldn't explain well before, and now I can just show you.

Three questions about your setup:

1. If the agent plans correctly but then submits to the **wrong payer** — or the **wrong patient** in a batch — what stops the submit from going out?
2. If an approved authorization is **retried**, can it go out **twice**?
3. If you **revoke** an approval mid-task, does the in-flight action still fire?

For most stacks the honest answer to all three is *"we'd catch it after — in the logs, or at the denial."* That's detection, not prevention.

I put together a side-by-side proof on a **real X12 278** stack (synthetic patients, no real PHI): the **same agent**, the **same task**, run once with policy + guardrails only and once governed at the execution boundary — across **six failure modes pulled from real RCM deployments**. In each one you can watch the wrong, duplicated, or out-of-scope action fire in the ungoverned run, and get **stopped at the moment it executes** in the governed run.

Open the attached **`proof-deck.html`** (single page, opens in any browser). The short version is in the table at the top; scroll for each scenario.

Worth 20 minutes to walk through live against your actual workflow?

Best,
[Lead]
