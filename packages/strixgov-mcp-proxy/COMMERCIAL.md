# Commercial use of `@strixgov/mcp-proxy`

`@strixgov/mcp-proxy` is distributed under the
[Elastic License 2.0](./LICENSE) — **source-available**, free for
internal use, with one operational restriction.

This document is the plain-English summary of the license boundary
and the path to a commercial license when you need one. It is not
legal advice; the canonical terms live in [`LICENSE`](./LICENSE).

The same licensing posture applies to
[`@strixgov/mcp-adapter`](https://www.npmjs.com/package/@strixgov/mcp-adapter).
The trust primitives the proxy depends on
([`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier),
[`@strixgov/tool-gateway`](https://www.npmjs.com/package/@strixgov/tool-gateway),
[`@strixgov/mcp-token-validator`](https://www.npmjs.com/package/@strixgov/mcp-token-validator),
the `@strixgov/capabilities-*` packs) are MIT-licensed separately and
have no commercial restrictions.

---

## Quick answer — 30 seconds (for the developer evaluating the proxy)

Walk down this tree. Stop at the first **yes**.

1. **Are you running `strix-mcp-proxy` on your laptop, in CI, or in a
   private staging environment?**
   → **Free.** No license needed.

2. **Are you running it in production in front of MCP servers that
   *your own* agents talk to?** (e.g. your Claude Desktop config now
   points at the proxy instead of the upstream Notion / GitHub /
   Filesystem MCP server)
   → **Free.** Internal production is the headline ELv2 grant.

3. **Are you running one proxy instance per customer, on infrastructure
   you own, where each customer's agents go through their own
   proxy?**
   → **Free if each instance governs only that customer's agents.**
   This is "distributing the software in your own product" — see
   row 6 in the scenarios table.

4. **Are you running one proxy instance that fronts MCP traffic for
   multiple third-party customers (multi-tenant gateway-as-a-service)?**
   → **Commercial license required.** Email
   [`sales@strixgov.com`](mailto:sales@strixgov.com).

5. **Are you offering the proxy itself as a hosted product (e.g.
   "GovernanceCloud — point your MCP client at us")?**
   → **Commercial license required.** Same email.

6. **Are you unsure which side of the line you're on?**
   → Email [`sales@strixgov.com`](mailto:sales@strixgov.com) — most
   "unsure" cases turn out to be free.

---

## Scenarios table — for legal / procurement review

The cases that come up most often for a network-positioned proxy.
Cite the row number when emailing for confirmation.

| # | Scenario | Outcome | Why |
|---|----------|---------|-----|
| 1 | Internal use — your engineers run `strix-mcp-proxy` locally in front of Claude Desktop's MCP servers | ✅ **Free** | Pure internal use; matches the headline ELv2 grant. |
| 2 | One proxy per environment (dev/stage/prod), all governing the same company's agents | ✅ **Free** | Same as row 1; the count of instances doesn't matter, the question is whether each instance serves your own agents. |
| 3 | You wrap the proxy in your own SaaS product (the proxy is invisible to your end users; they never call it, you operate it for the agents *your product* runs) | ✅ **Free** | The proxy is an internal dependency of your product. ELv2's "hosted service" restriction is about whether you expose the proxy's *governance features* to third parties. |
| 4 | Multi-tenant proxy — one instance fronting MCP traffic for several of *your customers'* agents, where each customer can configure their own policy through the proxy | 💰 **License required** | Hosting the proxy's features for third parties. This is exactly what ELv2 reserves. |
| 5 | MSP runs one proxy per managed customer, each on the customer's own infrastructure, billed per managed instance | ⚠️ **Email us** | Likely fine if each instance is operationally isolated to a single customer and you're billing for the management service, not for the proxy itself. Quick clarification saves both sides time. |
| 6 | On-premise enterprise product — you ship a software appliance that includes the proxy; each customer installs it on their own infrastructure and operates it themselves | ✅ **Free** | You're distributing, not hosting. Each customer is operating it internally for themselves. |
| 7 | You fork the proxy, rebrand it as "AgentGuard Proxy," and sell it as a hosted product | 💰 **License required** | Rebranding doesn't change the license question; hosting third-party governance is the restricted activity. |
| 8 | Open-source project (non-commercial) ships the proxy as part of its agent toolchain documentation | ✅ **Free** | Internal use by maintainers; redistribution under ELv2 is permitted. |
| 9 | You operate the proxy AND sync receipts to `strixgov.com` for centralized evidence retention | ⚠️ **Email us** | Proxy use itself is free per row 1; the hosted Strix platform has separate commercial terms. The hosted side is what you'd be buying. |
| 10 | Federal / regulated buyer requires FAR/DFARS, FedRAMP-adjacent posture, SOC 2, custom MSA | 💰 **License required (Enterprise tier)** | Commercial terms on top of ELv2; same email path — mention "federal." |

### Reading the outcomes

- **✅ Free** — use under ELv2 without contacting us. Standard
  contribution and redistribution rules apply (see the contribution
  note below).
- **💰 License required** — email
  [`sales@strixgov.com`](mailto:sales@strixgov.com) before deploying.
  Tier proposal returned within one business day; standard MSA
  available for review.
- **⚠️ Email us** — on the boundary or involves a separate Strix
  product. Quick clarification saves both sides time later.

### What ELv2 actually restricts (one paragraph)

The Elastic License 2.0 grants you the right to read, modify, run, and
redistribute the software with three limitations: you can't (a) provide
the software's features to third parties as a hosted or managed
service, (b) circumvent the license-key functionality, or (c) remove
or obscure the licensing or attribution notices. Limitation (a) is the
only one that meaningfully affects this package — (b) doesn't apply
because there are no license keys, and (c) is just "keep the LICENSE
file." See the
[canonical Elastic License 2.0 text](https://www.elastic.co/licensing/elastic-license)
for the exact wording.

---

## When you need a commercial license

Buy a commercial license if you need any of the following:

1. **Offer the proxy as a hosted or managed governance service to
   third parties.** Multi-tenant gateway-as-a-service is the
   archetype. Internal use is fine; B2B service offerings are not.
2. **Connected Mode at strixgov.com.** Centralized approvals,
   evidence retention beyond your local disk (EU AI Act 2-year
   requirement), multi-tenant policy management, SIEM forwarding,
   compliance evidence packs. None of those are part of the ELv2
   grant — they're the Strix hosted platform.
3. **Enterprise features** the standard proxy doesn't ship:
   SAML/OIDC SSO for approvers, RBAC on approval roles, KMS-backed
   signing keys (AWS KMS / GCP Cloud KMS), dedicated support, custom
   MSA, SOC 2 / FedRAMP / regulatory attestations.

If you're not sure which category you're in, email
[`sales@strixgov.com`](mailto:sales@strixgov.com).

---

## How to get a commercial license

Email [`sales@strixgov.com`](mailto:sales@strixgov.com) with:

- Your company name + primary contact
- A one-paragraph description of how you intend to deploy the proxy
- Approximate scale (number of tenants, expected receipt volume per
  month, target compliance regimes — SOC 2 / EU AI Act / HIPAA /
  FedRAMP)
- Whether you need any of the Enterprise features listed above

Federal procurement: same email, mention federal scope and we'll route
appropriately.

---

## What about contribution?

Contributions are welcome under ELv2. By submitting a pull request you
agree your contribution is licensed under the same terms as the rest
of the package — same approach as Elasticsearch, Kibana, Sentry, and
other ELv2 projects.

---

## Where to read the actual terms

- [`LICENSE`](./LICENSE) — the verbatim Elastic License 2.0 text.
- [`@strixgov/mcp-adapter/COMMERCIAL.md`](https://github.com/Strixgov/strix/tree/main/packages/strixgov-mcp-adapter/COMMERCIAL.md)
  — the sibling document for the adapter library; same posture, mostly
  the same scenarios.
- [https://www.elastic.co/licensing/elastic-license](https://www.elastic.co/licensing/elastic-license)
  — the canonical Elastic 2.0 source. The bundled `LICENSE` should
  match this verbatim; if you spot a discrepancy, the canonical source
  wins — file an issue.
