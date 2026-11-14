# Commercial use of `@strixgov/governed-egress`

**Status: publish-ready, not yet published.** Licence changed on 2026-11-13
from Elastic-2.0 to the **Strix Proprietary Software License** (owner decision
"Proprietary everywhere"). The owner states no copy was shared under
Elastic-2.0 (not independently verified here). Nothing is on npm or a
container registry until an operator runs the publish steps in
`docs/runbooks/governed-egress-proxy-publish.md`. Counsel has not reviewed
this licence or this document.

`@strixgov/governed-egress` is Strix's data-release control layer: it detects
sensitive data in an outbound artifact bound for an external AI provider,
de-identifies it by consistent tokenization, re-scans the sanitized result, and
binds a single-use egress authorization to the exact sanitized artifact. That
authorization-minting function is a runtime control surface, which
[`LICENSING_BOUNDARY.md`](../../LICENSING_BOUNDARY.md) now reserves for the
proprietary tier.

---

## Quick answer

This is a summary, not the licence. The [`LICENSE`](./LICENSE) text controls.

1. **Reading the source, rebuilding it, hashing it, running the included tests
   and publishing your verification method and results?** Allowed, including
   during evaluation (licence section 2.3). Do not publish the Software or
   substantial parts of it.
2. **Trying it on synthetic or test data, internally, to decide whether to
   buy?** Allowed for 30 days from first receipt, or the period Strix states
   in writing (section 2.2).
3. **Running it on live, real or production data, or embedding it in a
   product you operate?** Needs a signed Agreement with Strix (section 2.1).
4. **Offering it, rebranded or not, as a hosted or managed service, or running
   one instance for several customers?** Not allowed without an Agreement
   that says so.
5. **Copying, redistributing, sublicensing or modifying it?** Not allowed
   without an Agreement, except local changes needed to perform verification
   (section 3).
6. **Using it or its docs to build or train a competing product?** Not allowed.

Unsure which side of the line you are on? Email
[`sales@strixgov.com`](mailto:sales@strixgov.com) before deploying.

---

## What changed from Elastic-2.0

Elastic-2.0 let anyone run, copy and modify the software in production for
free and only barred offering it as a hosted service. The proprietary licence
keeps the source open to inspection and verification but requires an Agreement
for production use, redistribution and modification. Public statements that
said "free to self-host" no longer apply to this package.

---

## How to get an Agreement

Email [`sales@strixgov.com`](mailto:sales@strixgov.com) with your company
name, a one-paragraph description of the intended deployment, approximate
scale, and whether you need any Enterprise features (SSO for approvers,
KMS-backed signing keys, dedicated support). Availability of Enterprise
features requires separate written agreement; none is represented as shipped
in v0.1. Federal procurement contacts: same email, mention federal scope.

---

## Contributions

By submitting a contribution you agree Strix may use it under the licence
terms of this package (licence section 6 covers feedback).

---

## Where to read the actual terms

- [`LICENSE`](./LICENSE): the Strix Proprietary Software License, as adapted for this package.
- [`LICENSING_BOUNDARY.md`](../../LICENSING_BOUNDARY.md): the tier definition this classification was made under.
