# Commercial use of `@strixgov/governed-egress`

**Status: publish-ready, not yet published.** As of 2026-09-27 the package
is no longer `"private": true` — it is classified Elastic-2.0 in
`LICENSING_BOUNDARY.md` and `scripts/lint-license-parity.mjs`, and the
self-hosted proxy, container and Claude Code prompt hook are packaged.
Nothing is on npm or a container registry until an operator runs the
publish steps in `docs/runbooks/governed-egress-proxy-publish.md`.
Deciding the license tier and deciding when to publish are two separate
decisions; this document only settles the first.

`@strixgov/governed-egress` is Strix's data-release control layer: it
detects sensitive data in an outbound artifact bound for an external AI
provider, de-identifies it by consistent tokenization, re-scans the
sanitized result, and binds a single-use egress authorization to the
exact sanitized artifact — so the artifact that was authorized is
provably the artifact released. That authorization-minting function is
exactly the kind of runtime control surface [`LICENSING_BOUNDARY.md`](../../LICENSING_BOUNDARY.md)
reserves for the protected tier, alongside `@strixgov/mcp-adapter` and
`@strixgov/mcp-proxy` — the MIT tier's own boundary invariant is that no
package in it may mint a decision token or make a policy decision, and
this package's whole purpose is minting exactly that kind of
authorization.

---

## Quick answer — the same three-limitation test as every other ELv2 package here

Elastic License 2.0 grants you the right to read, modify, run, and
redistribute the software, with one limitation that matters in practice:
you can't provide the software's features to third parties as a hosted
or managed service.

1. **Running it yourself, to gate your own outbound AI calls?** Free. No
   license needed.
2. **Embedding it inside your own product so it governs egress for the
   agents *you* operate?** Free. Internal production use is the core
   ELv2 grant.
3. **Offering it (rebranded or not) as a hosted "governed egress"
   service that gates other companies' outbound AI traffic?** Commercial
   license required — email [`sales@strixgov.com`](mailto:sales@strixgov.com).
4. **An MSP/consultancy running one instance to govern several
   customers' egress?** Same as (3) — commercial license required, each
   customer is a third party relative to the operator.
5. **Unsure which side of the line you're on?** Email
   [`sales@strixgov.com`](mailto:sales@strixgov.com) before deploying —
   most "unsure" cases turn out to be free.

No scenarios table follows this section. `@strixgov/mcp-adapter`'s
COMMERCIAL.md documents ten cases drawn from real questions the
adapter had actually received in the field; this package has no
deployment history yet to draw an equally-grounded table from, and
writing one from imagination rather than from real questions would be
exactly the kind of unbacked claim this document exists to avoid.
Once real usage questions arrive, add them here as rows, not as
invented hypotheticals.

---

### What ELv2 actually restricts (one paragraph)

The Elastic License 2.0 grants you the right to read, modify, run, and
redistribute the software with three limitations: you can't (a) provide
the software's features to third parties as a hosted or managed service,
(b) circumvent the license-key functionality, or (c) remove or obscure
the licensing or attribution notices. Limitation (a) is the only one
that meaningfully affects this package — (b) doesn't apply because there
are no license keys, and (c) is just "keep the LICENSE file." See the
[canonical Elastic License 2.0 text](https://www.elastic.co/licensing/elastic-license)
for the exact wording.

---

## When you'd need a commercial license

1. **Offer the egress-control layer as a hosted or managed service to
   third parties.** Internal use is free; B2B service offerings are not.
2. **Connected Mode at strixgov.com** — centralized evidence retention,
   multi-tenant policy management, or any other hosted-platform feature.
   None of those are part of the ELv2 grant.
3. **Enterprise features** a standard self-hosted deployment doesn't
   ship: SSO for approvers, KMS-backed signing keys, dedicated support,
   custom MSA, SOC 2 / FedRAMP / regulatory attestations.

If unsure, email [`sales@strixgov.com`](mailto:sales@strixgov.com) —
we'd rather clarify in advance than have surprises after deployment.

---

## How to get a commercial license

Email [`sales@strixgov.com`](mailto:sales@strixgov.com) with your
company name, a one-paragraph description of the intended deployment,
approximate scale, and whether you need any Enterprise features listed
above. Federal procurement contacts: same email, mention federal scope.

---

## What about contribution?

Contributions are welcome under ELv2. By submitting a pull request you
agree your contribution is licensed under the same terms as the rest of
the package.

---

## Where to read the actual terms

- [`LICENSE`](./LICENSE) — the verbatim Elastic License 2.0 text.
- [`LICENSING_BOUNDARY.md`](../../LICENSING_BOUNDARY.md) — the canonical
  two-tier split this package's classification decision was made under.
- [https://www.elastic.co/licensing/elastic-license](https://www.elastic.co/licensing/elastic-license) —
  the canonical Elastic 2.0 source; the bundled `LICENSE` should match
  this verbatim.
