# Changelog — @strixgov/rcm-reference

All notable changes to the RCM governed-agent reference implementation.

## 0.1.0

Initial public reference implementation.

- Six failure-mode scenarios on a real X12 278 prior-authorization surface,
  each run twice (ungoverned vs. governed): `duplicate`, `scope-creep`,
  `injection`, `intercept`, `downcode`, `batch-bleed`.
- Faithful re-implementation of the Strix execution-token contract (single-use,
  time-bound, scope-bound, intent-bound via `actionParamsHash`) — the same wire
  format and deny-reason vocabulary as the upstream decision-token service.
- Deterministic, filmable terminal runner + self-contained HTML visual layer
  (governed vs. ungoverned side-by-side) + Playwright PNG/GIF capture.
- Strix design-system brand lockup applied to all visuals.
- Synthetic patients only; mock payer or a cleared sandbox; no production
  target in the code (`DEMO-SAFETY-BOUNDARY.md`).
- 13 invariant regression tests.
