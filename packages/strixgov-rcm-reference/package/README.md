# Send-ready lead package — RCM governed-agent proof

This folder is everything needed to arm a lead to email an RCM vendor. The
point: **show** — not argue — that policy/guardrails check the *plan*, while
Strix re-checks the *action at the moment it executes*. Same agent, same task,
run ungoverned vs. governed, across six failure modes from real prior-auth
deployments, on a real X12 278 surface with synthetic patients.

## What to send, in order

1. **`cover-email.md`** — the email the lead sends the vendor (opens with the
   3-question self-test, references the proof deck). Personalize + send.
2. **`../visual/proof-deck.html`** — the proof. **One self-contained file**
   (no install, opens in any browser): all six scenarios, ungoverned (red) vs.
   Strix-governed (green), side by side. Attach it, or paste screenshots of it.
3. **`comparison.md`** — the explainer one-pager ("plan-time vs. execution-time
   controls"). Send as the follow-up / leave-behind.

`self-test.md` is the same three questions as a standalone note; `shot-list.md`
is the filming guide if you want video instead of screenshots.

## Generating / refreshing the visuals

From `demos/rcm-governance-proof/`:

```bash
npm install
npm run visualize          # writes visual/*.html incl. proof-deck.html — no browser needed
```

`visual/proof-deck.html` is the single-page send artifact. `visual/index.html`
links the six per-scenario pages if you want them individually.

## Turning the HTML into clips or images (optional)

The HTML is enough to screenshot or screen-record. For baked images:

```bash
npm install -D playwright pngjs gifenc
npx playwright install chromium
npm run shots              # writes shots/<scenario>.png + shots/<scenario>.gif
```

- `shots/<id>.png` — full-page still per scenario.
- `shots/<id>.gif` — step-by-step reveal (good for LinkedIn / email).

(Needs a machine with a browser — the GIF encoder + Chromium can't run in a
headless CI sandbox.)

## The six scenarios

| Scenario | The veer (ungoverned) | Governed verdict |
|---|---|---|
| duplicate | retry submits the same 278 twice | BLOCKED · REPLAY |
| scope-creep | agent also posts an unapproved write-off | BLOCKED · UNAUTHORIZED |
| injection | inbound note injects a wrong CPT | BLOCKED · SCOPE_MISMATCH |
| intercept | high-cost study, no human sign-off | HELD · INTERCEPTED |
| downcode | legitimate in-family downcode | ADMITTED (Strix doesn't block legit work) |
| batch-bleed | wrong patient's member ID (context bleed) | BLOCKED · SCOPE_MISMATCH |

The `intercept` + `downcode` pair pre-empts the "won't this just block my
agents?" objection: Strix **holds** the genuinely risky action for a human and
**admits** the legitimate one — with a signed record.

## Honesty line (keep it in the pitch)

Strix re-evaluates each action against its **approved scope** at point-of-use;
it works because the agent's writes route through the gate. It is not "reading
the agent's mind." Everything here uses synthetic data against a payer endpoint
we control — **no production system is touched** (see `../DEMO-SAFETY-BOUNDARY.md`).
