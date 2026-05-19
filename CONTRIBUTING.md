# Contributing

Thanks for considering a contribution. This package is the public
release surface for `@strixgov/verifier`. The source of truth lives
upstream in the Strix monorepo; this repository receives synchronized
releases. See [MIRROR.md](MIRROR.md) for the sync model.

That model affects how contributions flow.

---

## How to file an issue

**Issues are accepted here.** The issue tracker on this repository is
the canonical place to report:

- Bugs in verification logic (a record that should verify but doesn't,
  or vice versa).
- CLI usability problems.
- Documentation errors, gaps, or unclear wording.
- Network/proxy/error-message clarity issues.
- Reimplementation parity issues (your re-implementation of the
  canonical builder produces different bytes than ours).

When filing a verification-correctness bug, please include:

1. The verifier version (`strix-verify --help` or `npm ls @strixgov/verifier`).
2. The exact command you ran.
3. The full output (including `--json` mode if possible).
4. For records reachable on the public proof API: the evidenceId.
5. For offline records: a minimal canonical payload that reproduces.
6. Your Node.js version and platform.

For network-related issues: try the troubleshooting commands documented
in the README's Troubleshooting section first.

---

## How to file a PR

**PRs against this repository are accepted, but the change has to land
upstream too.** A PR here is reviewed, but the actual code change
reconciles upstream in the monorepo and then re-syncs back to this
repo as part of the next release.

The flow:

1. Open a PR here against `main`. Describe the change as you would for
   any open-source project.
2. A maintainer reviews and (if accepted) opens the corresponding
   upstream PR in the monorepo, citing your PR here.
3. The upstream change merges, gets released, and syncs back to this
   repo automatically. Your PR's branch is then either merged or
   superseded by the sync commit.

This sounds awkward but it's the right discipline. The verifier is
tightly coupled to the upstream signer/proof-route/canonical-builder
implementations; a divergent fix in two repos is a future incident.
Keeping the upstream as canonical means there's exactly one place
where the signing/verifying contract is maintained.

### What constitutes an accepted PR here

- A clearly described bug with a reproducer.
- A focused fix that doesn't introduce new behavior outside the bug
  scope.
- A test (or updated test) that captures the regression.
- Updated documentation if the fix changes externally observable
  behavior.

### What we cannot accept

- Changes to the canonical-payload schema. Schema changes ship as new
  versions (v2), not in-place edits to v1. The locked-schema discipline
  is documented in [CANONICAL_PAYLOAD.md](CANONICAL_PAYLOAD.md).
- Changes that produce different canonical bytes for an existing input
  vector in [GOLDEN_VECTORS.md](GOLDEN_VECTORS.md) without an explicit
  versioning plan.
- Vendoring or duplication of the canonical builder logic. There MUST
  be one source of truth.
- Removing or weakening the offline-verification fixtures in
  `examples/`.
- Changes that reduce the verifier's stability guarantees on the
  JWKS or canonical-payload contract documented in [JWKS.md](JWKS.md)
  and [CANONICAL_PAYLOAD.md](CANONICAL_PAYLOAD.md).

---

## Security-sensitive bugs

If you find a bug that could compromise verification trust — i.e., a
way to produce a record that the verifier reports as `VERIFIED` but
shouldn't, or a way to make a legitimate record fail verification —
**do not file a public issue**.

Follow the responsible-disclosure flow in [SECURITY.md](SECURITY.md).

---

## Coding conventions

If you're submitting a code PR:

- Match the surrounding style. The verifier source is pragmatic
  modern JavaScript with JSDoc type hints, no TypeScript build step,
  no transpilation. Don't introduce build tooling.
- Zero runtime dependencies. The verifier intentionally ships only
  Node's built-in `crypto` and global `fetch`. New runtime deps are
  rejected by default; raise the request in an issue first.
- Tests are `node:test`. Run with `npm test`.
- Comments explain WHY non-obvious choices were made, not WHAT the
  code does. Especially for security-sensitive code paths, document
  the threat model the code is defending against.

---

## Tests

The test suite must pass before any PR is merged:

```bash
npm test
```

The test suite includes:

- `test/redaction-promotion.test.mjs` — regression pin for the
  v1.9.2 / v1.9.3 response-flatten bug class. **Do not modify or skip
  this test** without writing an equivalent that pins the same invariant.
- `test/attestations-e1-5.test.mjs` — attestation verification flow.

Goldens (`goldens/se-v1-canonical-vectors.json`) must also continue to
verify against the lock file — see the sample validator in
[GOLDEN_VECTORS.md](GOLDEN_VECTORS.md).

---

## Documentation contributions

Documentation improvements are some of the highest-value contributions
this project can receive. Specifically welcomed:

- Clarifications when an existing section was confusing.
- New troubleshooting rows for failure modes you encountered.
- Translation notes if you've reimplemented the canonical builder in
  another language and want to share the gotchas (target audience:
  someone else attempting the same reimplementation).
- Examples beyond the four shipped fixtures.

For documentation-only PRs, the upstream-reconciliation flow still
applies but with much lower friction — typo and clarity fixes typically
sync upstream within a release cycle.

---

## Code of Conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)
v2.1. By participating, you agree to abide by its terms.

Report violations or concerns confidentially via the contact in
[SECURITY.md](SECURITY.md).
