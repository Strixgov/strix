# STRIX · MCP Tool Gateway · Marketing Video

A 55-second branded video that wraps the local-CLI demo
(`assets/mcp-tool-gateway.mp4`) with six animated scenes:
**Open → Problem → Gateway → Live demo → Capabilities → CTA**. It
exists to show what `@strixgov/tool-gateway` actually does at the
command line, end-to-end, without requiring a viewer to install or
configure anything.

Pure static — HTML + JSX + CSS + one mp4. No build step.

## Files

| File | Purpose |
|---|---|
| `index.html` | Entry. Loads React, ReactDOM, and Babel-standalone from `unpkg.com` (subresource-integrity pinned), then the three JSX files. |
| `index.css` | Body + `#root` positioning. Kept as a file (not an inline `<style>`) so a host page can serve under a strict CSP without `'unsafe-inline'` for styles. |
| `colors_and_type.css` | Design-system tokens. |
| `animations.jsx` | `<Stage>` + timeline + scene primitives (`Sprite`, `KeyFrames`, easing helpers). Reusable across marketing videos. |
| `gateway_video_scenes.jsx` | The six scenes (`GVScene1Open` through `GVScene6CTA`) and the `<GVMovie>` composer that sequences them. Embeds the mp4 at scene 4 with a 1.7s pre-roll offset. |
| `bootstrap.jsx` | Mounts `<Stage><GVMovie/></Stage>` into `#root`. Pulled out of the HTML so a host page can serve under a strict CSP without `'unsafe-inline'` for scripts. |
| `strix-logomark.svg` | Brand mark used in scenes 1, 5, and 6. |
| `assets/mcp-tool-gateway.mp4` | The 20-second CLI walkthrough that scene 4 wraps. ~13 MB. |

## Viewing it

The page does *not* run from `file://` URLs — Babel-standalone has to
fetch the `.jsx` files via XHR, and browsers block XHR on `file://`.
You need any static HTTP server:

```bash
# from this directory
npx http-server -p 8080
# then open http://localhost:8080/
```

Or any equivalent (`python -m http.server`, `caddy file-server`, etc.).

## Hosting it

If you serve this page behind a Content-Security-Policy, the policy
needs:

- `script-src 'self' 'unsafe-eval' https://unpkg.com`
  - `'unsafe-eval'` because Babel-standalone compiles the JSX in the
    browser. Removing this requirement means pre-compiling the JSX to
    plain JS at build time and dropping the Babel script tag.
  - `https://unpkg.com` for the React / ReactDOM / Babel CDN. Each
    script tag carries a `integrity` SRI hash, so the CDN cannot serve
    tampered content.
- `style-src 'self'` — no inline styles or `<style>` blocks. The JSX
  uses `style={{}}` object props which React applies via DOM
  `.style.X = "..."` assignments, which are not subject to CSP.
- `media-src 'self'` — for the embedded mp4.

The video element is `muted + playsInline` so browser autoplay rules
permit it without user interaction. Don't add audio.

## Source

Mirrored from the upstream Strix monorepo's
`apps/strix-verify-web/marketing/mcp-tool-gateway/` directory. The
canonical hosted copy is served from that app's deployment; see the
root [`MIRROR.md`](../../MIRROR.md) for the source-of-truth model.

## License

MIT, same as the rest of this repository. See the root [`LICENSE`](../../LICENSE).
