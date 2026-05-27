# Security Policy

The verifier is a public cryptographic primitive. A bug here directly
affects whether a third party can correctly establish the trust state
of a Strix-governed AI action. We treat verifier bugs as security-class
issues, not feature requests.

---

## Reporting a vulnerability

**Do NOT file a public issue for security-sensitive bugs.**

Use the GitHub Security Advisories flow for this repository:

→ [github.com/Strixgov/strix/security/advisories/new](https://github.com/Strixgov/strix/security/advisories/new)

That surface keeps the report private until a fix is published and
gives both sides a structured workflow for coordinated disclosure.

If you can't use GitHub Security Advisories for any reason, email
`security@strixgov.com` with:

- A clear description of the vulnerability.
- A reproducer (code, fixture, or steps).
- Your assessment of the impact.
- Your preferred coordination timeline.
- Whether you want public attribution after disclosure.

We aim to acknowledge security reports within 48 hours.

---

## In scope

The following classes of bug are in scope for this security policy:

| Class | Example |
|---|---|
| **Forge-positive bugs** | A way to produce or modify a record that the verifier reports as `VERIFIED` when it shouldn't (e.g., a canonical reconstruction that accepts a tampered hash). |
| **Forge-negative bugs** | A way to make a legitimate, properly-signed record fail verification (denial-of-trust, e.g., a parser bug that rejects valid records). |
| **Key resolution attacks** | The verifier resolves the wrong key, accepts a JWK that shouldn't be trusted, or fails to apply the JWKS retention contract correctly. |
| **Side-channel leaks** | The verifier leaks information about the signed payload that wasn't meant to be public (e.g., leaking through `--json` what would normally be redacted). |
| **Denial-of-service via crafted input** | A malformed record causes the verifier to hang, exhaust memory, or crash in a way that prevents legitimate verification from continuing. |
| **Dependency supply chain** | A vulnerability in a runtime path that could be exploited to compromise verification. (We try to keep this surface trivially small by shipping zero runtime dependencies, but report anything you find.) |

---

## Out of scope

These are NOT verifier security issues; please file them as normal
public issues:

- **CLI UX problems** that don't affect verification correctness.
- **Documentation errors** (other than ones that would mislead a user
  into trusting a record they shouldn't).
- **Network reachability issues** specific to your environment.
- **Compatibility issues** with non-LTS Node.js versions or
  pre-RFC-7517 JWKS implementations.
- **Issues with Strix's hosted services** that aren't bugs in this
  verifier package itself. File those upstream.

---

## Coordinated disclosure

Our default flow for a confirmed verifier vulnerability:

1. **Acknowledge** the report within 48 hours.
2. **Assess** severity within 7 days. Severity tiers:
   - **Critical**: forge-positive (false VERIFIED). Affects production
     trust claims.
   - **High**: forge-negative across a record class. Affects audit
     usability at scale.
   - **Medium**: forge-negative on a specific record. Side-channel
     leaks that don't immediately enable forgery.
   - **Low**: theoretical issues with no current exploitation path.
3. **Develop a fix** with the reporter as a collaborator. We aim for
   patches within:
   - Critical: 7 days
   - High: 30 days
   - Medium: 60 days
   - Low: opportunistic
4. **Publish** the fix as a new verifier release and publicly disclose
   the advisory with credit to the reporter (if desired).
5. **Notify** downstream consumers via the changelog and (for Critical)
   a coordinated GitHub Security Advisory.

If the vulnerability has been independently published or otherwise made
public before our disclosure window completes, we adjust the timeline
to match.

---

## Verification Disclosure Policy

The verifier's value proposition is the credibility of its proofs. A
**verification regression** — any condition where the verifier reports
`VERIFIED` (or any derived compliance flag) on a record that cannot be
independently re-verified — is the highest-stakes class of incident
regardless of who discovers it. This policy applies to self-discovered
regressions in addition to external reports.

**Definition.** A verification regression is any of:

- A record returning `VERIFIED` whose stored signature does not
  validate against the published JWKS.
- A `compliance.article*` flag asserted as `SATISFIED` whose underlying
  invariant cannot be reproduced by this verifier.
- A divergence between the hosted `/api/public/verify` surface and the
  latest published `@strixgov/verifier` release for the same record.
- A proof-chain link whose `proofChainHash` does not match the prior
  record's `recordHash`.

**Internal-discovery timeline.** When Strix engineering discovers a
verification regression (in CI, during routine testing, or via the
red-team harness), the public-disclosure target is **≤ 7 calendar
days** from confirmation. This is faster than the 90-day
coordinated-disclosure target above and overrides it.

**Disclosure surface.** Every confirmed verification regression is
recorded on the public incident-status page at
`https://www.strixgov.com/status/verification-incidents/` (planned),
with:

- Affected evidence-schema version(s) and signing-key id(s).
- Date range of affected records.
- Whether records remain verifiable under any preserved verifier
  version.
- Resolution status and the verifier version that confirms the fix.

Until the public status page is live, confirmed regressions will be
referenced from this `SECURITY.md` and from the verifier `CHANGELOG.md`
release notes.

**Claim wording during a regression.** While a verification regression
is open, public copy on the Trust Center and `/api/public/verify`
**MUST NOT** advance ahead of what the verifier can re-establish.
Specifically:

- Records that fail re-verification under the current verifier MUST
  surface their layer-1 status (`signatureValid: UNSIGNED` /
  `LEGACY_UNSIGNED` / `COMPLIANCE_VIOLATION`) rather than a derived
  "verified" badge.
- Compliance flags that depend on the regressed invariant MUST be
  returned as `null` (not asserted). Never assert a check that the
  verifier cannot currently reproduce.
- A regression banner on the Trust Center MUST link to the incident
  page (or, until the page is live, to the relevant CHANGELOG entry)
  until resolution.

**Pre-release transparency.** This verifier package is pre-1.0 in
terms of category maturity, even though the version number has crossed
1.0 (semver discipline for the package surface). This policy is
published before any verification regression has been disclosed via
this repo. Once an incident occurs, this section becomes the contract
for how we report it.

---

## Hall of fame

Verifier security bugs that have been responsibly disclosed will be
credited here (with the reporter's permission).

The May 2026 launch-day stack — nine bugs caught during pre-release
parity testing, including two response-flatten bugs that broke
signature verification on every public record (kid promotion and
evidenceId promotion) — is documented internally as a postmortem.
These were caught before any public verifier release, so they aren't
external advisories.

---

## Why this policy is strict

A verifier with a forge-positive bug is worse than no verifier — it
gives audit, compliance, and regulatory readers a false sense that
records have been cryptographically attested when they haven't. That
failure mode undermines the trust claim of the entire Strix
architecture, not just the verifier itself.

We take that risk seriously. We will publicly retract any verifier
release shown to have a forge-positive bug, and we coordinate with the
reporter to make sure the fix lands before the vulnerability becomes
exploitable in production.
