# @strixgov/verify-embed

**One-line embeddable verification card for Strix-governed AI agent evidence.** Drop `<strix-verify>` on any HTTPS page. WebCrypto Ed25519 runs in the visitor's browser. No Strix backend in the trust path.

```html
<script src="https://verify.strixgov.com/embed.js"></script>
<strix-verify evidence-id="5686"></strix-verify>
```

The element fetches the evidence record from the public proof API, resolves the signing key from the public JWKS, runs Ed25519 verification client-side, and renders a self-contained verification card with verdict, capability, actor role, signed-by kid, and EU AI Act compliance flag derivations.

**Bundle size:** 8.6 KB gzipped. Works in modern Chrome, Firefox, Safari, Edge.

## Why

Strix produces Ed25519-signed receipts for every governed agent action. The receipts are independently verifiable — anyone with the public JWKS can confirm an action happened, was approved, and hasn't been tampered with, without trusting Strix's infrastructure at all.

Until now, that verification required either the Node CLI (`npx @strixgov/verifier@latest <id>`) or visiting [verify.strixgov.com](https://verify.strixgov.com). The embed makes it a one-line drop-in — so any framework, blog post, audit report, or compliance dashboard can show verified Strix evidence inline.

## Installation

### CDN (recommended for simple embeds)

```html
<script src="https://verify.strixgov.com/embed.js"></script>
<strix-verify evidence-id="5686"></strix-verify>
```

### npm (pinned version, for production systems)

```bash
npm install @strixgov/verify-embed
```

```js
// Side-effect import auto-registers the <strix-verify> custom element.
import "@strixgov/verify-embed";

// Or use the programmatic API directly:
import { verify } from "@strixgov/verify-embed";

const result = await verify("5686");
console.log(result.verificationStatus);
// → "VERIFIED" | "COMPLIANCE_VIOLATION" | "UNSIGNED" |
//   "LEGACY_UNSIGNED" | "NOT_FOUND" | "ERROR"
```

## Attributes

| Attribute | Required | Notes |
|---|---|---|
| `evidence-id` | yes | The evidence record ID to verify. Numeric or string. |
| `compact` | — | Boolean. Renders a smaller card; hides the details block. |
| `proof-base` | — | Override the proof API base URL. Defaults to `https://www.strixgov.com`. Used for forks + testing. |
| `jwks-url` | — | Override the JWKS URL. Defaults to the canonical Strix JWKS endpoint. |
| `auto-refresh` | — | Milliseconds between re-verifications. Minimum 30000 (30s). |

## Programmatic API

```js
const el = document.querySelector("strix-verify");

// Trigger a verification (returns the result object directly)
const result = await el.verifyNow();

// Or listen for results bubbling out of the shadow tree:
el.addEventListener("strix-verify:result", (e) => {
  console.log(e.detail);
});
```

## Styling

The card lives in a Shadow DOM so host-page CSS can't change its layout. Theme via CSS custom properties:

```css
strix-verify {
  --sv-bg: #ffffff;
  --sv-surface: #f7f7f9;
  --sv-fg: #1a1a1a;
  --sv-accent: #5b8def;
  --sv-verified: #1f7e3d;
  --sv-font-sans: "Inter", system-ui, sans-serif;
}
```

Full token list in [`src/styles.mjs`](./src/styles.mjs).

## Trust model

`<strix-verify>` is a **client-side verifier**. The only Strix-controlled surfaces in the trust path are:

1. The proof API at `https://www.strixgov.com/api/public/proof/<id>` (or your fork's equivalent), which returns the signed record.
2. The JWKS at `https://www.strixgov.com/.well-known/strix-jwks.json` (or your fork's equivalent), which returns the public verification keys.

Both surfaces are public, cacheable, and inspectable in browser DevTools. The verification itself happens in the visitor's browser using WebCrypto's native Ed25519 — Strix can't lie about a record's validity because the signature math runs on the visitor's machine.

The bundle is byte-for-byte canonical-payload-equivalent to `@strixgov/verifier` (the Node CLI). A mirror-invariant test in this package's test suite enforces it.

## Outcome language

Matches `@strixgov/verifier` exactly:

| Status | Meaning |
|---|---|
| `VERIFIED` | Signature is valid against the resolved public key. |
| `COMPLIANCE_VIOLATION` | Record has a signature but it does NOT verify — tampered or wrong key. |
| `UNSIGNED` | Record exists but has no signature. |
| `LEGACY_UNSIGNED` | Pre-Signed-Evidence-v1 record (records 1–41 in the public surface). |
| `NOT_FOUND` | No record with that ID in the public proof API. |
| `ERROR` | Network failure, JWKS unreachable, or other infrastructure issue. |

## EU AI Act compliance flags

When the verified record opts into a compliance framework via `regulatoryContext.complianceMode`, the embed derives and displays the four flags:

- `article12_traceable` — trace fields present + hash valid
- `article12_tamper_resistant` — hash + chain + signature all valid
- `article14_oversight_supported` — trace fields present
- `article28_audit_ready` — all checks pass

**Flags are NEVER read from the record.** They are derived by the embed from the verification outcome — the same way `@strixgov/verifier` does it. A signing host cannot write `article28_audit_ready: true` into a record and have the embed honor it (CI-5 / SE-18 invariant).

## Versions

| Version | Notes |
|---|---|
| 0.1.0 | Initial release. WebCrypto Ed25519. Mirror-invariant tested against `@strixgov/verifier`. |

## License

MIT. See [LICENSE](./LICENSE).
