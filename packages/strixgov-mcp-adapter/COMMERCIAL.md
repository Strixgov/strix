# Commercial use of `@strixgov/mcp-adapter`

`@strixgov/mcp-adapter` is distributed under the
[Elastic License 2.0](./LICENSE) — **source-available**, free for
internal use, with one operational restriction.

This document is the plain-English summary of the license boundary
and the path to a commercial license when you need one. It is not
legal advice; the canonical terms live in [`LICENSE`](./LICENSE).

---

## Quick answer — 30 seconds (for the developer evaluating the package)

Walk down this tree. Stop at the first **yes**.

1. **Are you running it on your laptop, in CI, or in a private staging
   environment?**
   → **Free.** No license needed. Read, fork, modify, ship to your team.

2. **Are you deploying it to production to govern your own company's
   agents (the agents you operate, talking to the tools you operate)?**
   → **Free.** Same as above. Internal production is the headline ELv2
   grant — that's the whole point.

3. **Are you bundling it inside your own product, where your product's
   end users never see the governance UI, never call the adapter
   directly, and never make policy decisions through it?**
   → **Free.** You're using it as an internal dependency. The boundary
   ELv2 cares about is whether you expose the adapter's *features* to
   third parties as a service.

4. **Are you offering Strix governance itself as a hosted product? (e.g.
   "GovernanceCloud — bring your agents, we'll govern them" or a
   multi-tenant approval workbench)**
   → **Commercial license required.** Email
   [`sales@strixgov.com`](mailto:sales@strixgov.com).

5. **Are you reselling the adapter (rebranded or not) as part of an MSP
   or consulting offering that governs your customers' agents?**
   → **Commercial license required.** Same email.

6. **Are you unsure which side of the line you're on?**
   → Email [`sales@strixgov.com`](mailto:sales@strixgov.com) — we'd
   rather clarify in advance than have surprises later. Most "unsure"
   cases turn out to be free.

> The four MIT-licensed packages — [`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier),
> [`@strixgov/tool-gateway`](https://www.npmjs.com/package/@strixgov/tool-gateway),
> [`@strixgov/mcp-token-validator`](https://www.npmjs.com/package/@strixgov/mcp-token-validator),
> and the `@strixgov/capabilities-*` packs — have **no** commercial
> restrictions. Your security team can audit and your auditors can
> verify receipts without any ELv2 question.

---

## Scenarios table — for legal / procurement review

The ten cases we've actually received questions about. Each row maps a
concrete deployment to one of three outcomes. Cite the row number when
emailing for confirmation.

| # | Scenario | Outcome | Why |
|---|----------|---------|-----|
| 1 | Internal Slack/GitHub agent at our company, governed by the adapter | ✅ **Free** | Internal production use of the adapter for your own agents — the core ELv2 grant. |
| 2 | SaaS company embeds the adapter to govern the agents *we* operate inside *our* product; end users never interact with the adapter | ✅ **Free** | The adapter is an internal dependency. ELv2's "hosted service" restriction is about exposing the adapter's *features* to third parties, not about whether your product is itself a SaaS. |
| 3 | We fork the adapter, rebrand it, and offer it as "AgentGuard — managed governance for your agents" | 💰 **License required** | Hosting the adapter's features as a service to third parties is exactly what ELv2 reserves. |
| 4 | MSP / consultancy runs one adapter instance to govern five different customers' Slack workspaces | 💰 **License required** | Multi-tenant governance-as-a-service. Each customer is a "third party" relative to the operator. |
| 5 | Open-source project (non-commercial) includes the adapter as a dependency in its CI/agent tooling | ✅ **Free** | Internal use by the project maintainers; redistribution under ELv2 is permitted. |
| 6 | We embed the adapter inside an on-premise enterprise product we sell to customers; each customer installs and runs it on their own infrastructure to govern their own agents | ✅ **Free** | Each customer is operating it internally for themselves. You're distributing, not hosting. (If you also operate it for them as a managed service, the managed-service portion needs a license — see row 4.) |
| 7 | We run the adapter in production AND sync receipts to `strixgov.com` for centralized evidence retention | ⚠️ **Email us** | The adapter use itself is free per row 1; the hosted Strix platform features (EU AI Act retention, multi-tenant approvals, SIEM forwarding) have separate commercial terms. The hosted side is what you'd be buying. |
| 8 | We use only the MIT-licensed trust primitives (`@strixgov/verifier`, `@strixgov/tool-gateway`, `@strixgov/mcp-token-validator`) without `@strixgov/mcp-adapter` | ✅ **Free, MIT** | ELv2 only applies to `@strixgov/mcp-adapter` and `@strixgov/mcp-proxy`. The trust primitives are MIT and have no restrictions. |
| 9 | Federal / regulated buyer requires FAR/DFARS clauses, FedRAMP-adjacent posture, SOC 2 attestations, custom MSA | 💰 **License required (Enterprise tier)** | These are commercial terms on top of ELv2, not a license-validity question. Same email path — mention "federal" or the specific regime. |
| 10 | We're an investor / auditor / regulator who wants to verify receipts produced by someone else's deployment | ✅ **Free, MIT** | You only need `@strixgov/verifier`. The adapter that produced the receipts is the operator's concern; verification depends on public JWKS and standard crypto primitives, no Strix tooling required. |

### Reading the outcomes

- **✅ Free** — use under ELv2 without contacting us. Standard contribution and
  redistribution rules apply (see "What about contribution?" below).
- **💰 License required** — email [`sales@strixgov.com`](mailto:sales@strixgov.com)
  before deploying. Tier proposal returned within one business day; standard
  MSA available for review.
- **⚠️ Email us** — likely on the boundary or involves a separate Strix
  product (the hosted kernel). Quick clarification email saves both sides
  time later.

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

## What's free

Under ELv2 you may, at no cost:

- Read, fork, modify, and self-host the adapter
- Run it in **internal production** — governing your own agents'
  MCP traffic for your own business
- Distribute it bundled with your own product, *as long as that
  product is not a hosted or managed service that exposes the
  adapter's features or functionality to third parties*

The trust primitives the adapter depends on
(`@strixgov/verifier`, `@strixgov/tool-gateway`,
`@strixgov/mcp-token-validator`) are MIT-licensed separately and have
no commercial restrictions.

**Plain-English version:** if you're running it for yourself or your
own company's agents, you're free. Resell it as a service and you
need a license.

---

## When you need a commercial license

Buy a commercial license if you need any of the following:

1. **Offer the adapter as a hosted or managed governance service to
   third parties.** Anything where someone else's agents flow through
   your hosted Strix instance counts. Internal use is fine; B2B
   service offerings are not.
2. **Connected Mode at strixgov.com.** Centralized approvals, evidence
   retention beyond your local disk (EU AI Act 2-year requirement),
   multi-tenant policy management, SIEM forwarding, compliance
   evidence packs. None of those are part of the ELv2 grant — they're
   the Strix hosted platform.
3. **Enterprise features** the standard `governMCPServer` doesn't
   ship: SAML/OIDC SSO for approvers, RBAC on approval roles,
   KMS-backed signing keys (AWS KMS / GCP Cloud KMS), dedicated
   support, custom MSA, SOC 2 / FedRAMP / regulatory attestations.

If you're not sure which category you're in, email
[`sales@strixgov.com`](mailto:sales@strixgov.com) — we'd rather
clarify in advance than have surprises after deployment.

---

## How to get a commercial license

Email [`sales@strixgov.com`](mailto:sales@strixgov.com) with:

- Your company name + primary contact
- A one-paragraph description of how you intend to deploy the adapter
- Approximate scale (number of tenants, expected receipt volume per
  month, target compliance regimes — SOC 2 / EU AI Act / HIPAA /
  FedRAMP)
- Whether you need any of the Enterprise features listed above

We'll respond with a tier proposal (Commercial or Enterprise per
[`docs/strategy/mcp-adapter-packaging-v1.md`](https://github.com/Strixgov/strix/tree/main/docs/strategy/mcp-adapter-packaging-v1.md))
and a standard MSA for review.

Federal procurement contacts: same email, mention federal scope and
we'll route appropriately. FAR/DFARS clauses are accommodated; the
federal MSA path follows the FedRAMP-adjacent posture once that
workstream is in flight.

---

## What about contribution?

Contributions are welcome under ELv2. By submitting a pull request
you agree your contribution is licensed under the same terms as the
rest of the package — same approach as Elasticsearch, Kibana, Sentry,
and other ELv2 projects.

If you have a contribution that would benefit from a separate license
arrangement (e.g. you're contributing as part of a paid Strix
engagement), call it out in the PR description and we'll work it out
case-by-case.

---

## Where to read the actual terms

- [`LICENSE`](./LICENSE) — the verbatim Elastic License 2.0 text.
- [`docs/strategy/mcp-adapter-packaging-v1.md`](https://github.com/Strixgov/strix/tree/main/docs/strategy/mcp-adapter-packaging-v1.md) — the
  packaging spec that defines tiers (Community / Commercial /
  Enterprise) and the rationale behind the ELv2 choice over BSL 1.1.
- [https://www.elastic.co/licensing/elastic-license](https://www.elastic.co/licensing/elastic-license) — the
  canonical Elastic 2.0 source. The bundled `LICENSE` should match
  this verbatim; if you spot a discrepancy, the canonical source
  wins — file an issue.
