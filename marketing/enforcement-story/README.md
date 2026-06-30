# STRIX · Enforcement in Action

A scroll-driven 2-act story showing how the Strix kernel enforces
policy in real time:

- **Act 1 — Human Input.** A clinician submits patient data. STRIX
  classifies, applies HIPAA minimum-necessary, verifies actor identity,
  and signs an Ed25519 audit receipt — before the model sees a name.
- **Act 2 — Adversarial Prompt.** A compromised account tries to coerce
  the assistant into exporting raw PHI. The model may follow the
  injection; the kernel scope-checks the tool call and refuses.
  Receipt is signed either way.

Pure static — HTML + CSS + one inline-IIFE JS file. No build step,
no frameworks, no external script dependencies.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure. References the four assets below. No inline `<style>` / `<script>` / `style="..."`. Carries OpenGraph + Twitter `summary_large_image` meta pointing at `card.svg`. |
| `styles.css` | Full design CSS, plus six small CSP-safe class replacements for what were `style="..."` attributes in the design source. |
| `colors_and_type.css` | Design-system tokens. |
| `app.js` | Scroll-driven driver: builds the pipe SVGs, maps act-vertical-scroll progress to phase/local time, types fields, lights kernel rows, illuminates decision cards, prints receipts. Pure IIFE; no dependencies. |
| `card.svg` | 1200×630 OG-image card for LinkedIn / X unfurls. Source of truth for the meta-tag image. For platforms that don't render SVG OG images (LinkedIn historically), export to PNG and upload in the post composer; the meta-tag then becomes ornamental. |

## Viewing it

The page does *not* run from `file://` URLs — the browser blocks
`<link rel="stylesheet">` siblings cleanly under `file://` on some
configurations, and the `<script src>` resolution can be flaky. Any
static HTTP server works:

```bash
# from this directory
npx http-server -p 8080
# then open http://localhost:8080/
```

Or `python -m http.server`, `caddy file-server`, etc.

## Hosting it

A modest, CSP-friendly page. If you serve under a Content-Security-Policy,
this is sufficient:

```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
base-uri 'self';
frame-ancestors 'none';
```

The bundle deliberately has no inline scripts, no inline styles, and
no inline `style="..."` attributes — so the policy above runs the page
without needing `'unsafe-inline'` or `'unsafe-eval'`.

## Source

Mirrored from the upstream Strix monorepo's
`apps/strix-verify-web/marketing/enforcement-story/` directory. The
canonical hosted copy is served from that app's deployment; see the
root [`MIRROR.md`](../../MIRROR.md) for the source-of-truth model.

## License

MIT, same as the rest of this repository. See the root [`LICENSE`](../../LICENSE).
