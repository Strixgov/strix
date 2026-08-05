# @strixgov/trust-mark-embed

One-line embeddable **`<strix-trust-mark>`** web component — the consumer
one-click layer of the Consumer Trust Mark (TM-1).

```html
<script src="https://verify.strixgov.com/trust-mark.js"></script>
<strix-trust-mark grant-id="tm-grant-0001" auto-refresh="60000"></strix-trust-mark>
```

It resolves a grant's **live** status from the licensee's public surface and
renders the locked four-state badge:

| State | Meaning |
|---|---|
| 🟢 GREEN | Verified live — all rules pass, fresh |
| 🔴 RED | Definitive failure (revoked, expired, coverage failed, invalid) |
| 🟡 YELLOW | Cannot verify right now (substrate unreachable / unknown) — time-boxed |
| ⚫ SLATE | No trust mark |

**Render-only.** The badge renders the verdict the public status route produced
(that route runs the real `trust_mark_grant_v1` verifier + the rule-9 coverage
check); it never determines a verdict itself. **Never-fake-GREEN** holds by
composition: GREEN renders only when the route returns `badge: "GREEN"`, an
unrecognized badge degrades to YELLOW, and `auto-refresh` prevents a stale GREEN
from persisting past the route's short cache window.

The independent, zero-Strix-trust re-derivation is the skeptic CLI:

```
npx @strixgov/verifier trustmark <grantId>
```

## Attributes

- `grant-id` (required) — the grant to resolve.
- `proof-base` (optional) — override the status API base (testing/forks).
- `compact` (optional) — render a single inline pill.
- `auto-refresh` (optional, ms ≥ 30000) — re-resolve on an interval.

## API

```js
import { fetchTrustMarkState } from "@strixgov/trust-mark-embed";
const state = await fetchTrustMarkState("tm-grant-0001");
// → { badge, grantId, markClass, surfaceOrigin, verificationStatus, verificationReason, coverage, note }
```

MIT. Part of the Strix open trust-primitive set (`@strixgov/verifier`, `@strixgov/verify-embed`).
