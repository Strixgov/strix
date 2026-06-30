# Strix brand assets

Implemented from the Strix Design System handoff (Claude Design export).

## Files

- `strix-logomark.svg` — the governance "owl" logomark. **Baked cyan `#3BB5C9`
  (fill + stroke) — do not recolor.** `viewBox="0 0 279 365"`.
- `tokens.css` — the design tokens (color surface/foreground ramp, type scale,
  radii, shadows). Source of truth for the palette used by the proof-kit visuals.
- `_card.css` — the 700px preview card shell (imports `tokens.css`).
- `logo-lockups.html` — faithful recreation of the design's `logo-lockups.html`:
  primary (mark + wordmark + tagline), stacked, wordmark-only, mark-on-dark.

## Lockup rules

- **Wordmark:** `STRIX` in Arial Black (weight 900), tracked **`+0.08em`**, all-caps.
- **Tagline:** `EXECUTION CONTROL` — Arial 500, `0.18em` tracking, uppercase, muted (`--fg-3`).
- **Mark color** is the baked cyan `#3BB5C9`. The brand **accent blue `#2F81F7`**
  (links/active/focus) is intentionally a *different* color — don't conflate them.
- Mark-on-dark uses background `#04080F`.

The proof-kit visuals (`src/visual/html.ts`) inline this mark in the page header
as the primary lockup so each generated page stays self-contained.
