# Security Policy

This repository hosts the open-source Strix packages. Security bugs in
any of them are taken seriously — several are trust primitives, where a
bug directly affects whether a third party can correctly establish the
trust state of an AI action.

## Reporting

**Do not file a public issue for a security-sensitive bug.** That
includes anything that could:

- make the verifier report a record as `VERIFIED` when it should not (or
  fail a legitimate record),
- let the tool-gateway emit a receipt that misrepresents a decision, or
  bypass a deny/approval outcome,
- forge, replay, or tamper with a signed receipt or its proof chain
  undetected.

Report these privately to **security@strixgov.com**. Include a
reproducer, the affected package + version, your Node.js version and
platform, and the impact you observed. We aim to acknowledge within two
business days.

## Per-package detail

The verifier carries its own, more detailed security policy — it is a
cryptographic primitive and bugs there are the highest-severity class:
[`packages/strixgov-verifier/SECURITY.md`](packages/strixgov-verifier/SECURITY.md).

## Source-of-truth note

These packages are mirrored from the upstream Strix monorepo (see
[MIRROR.md](MIRROR.md)). A security fix lands upstream first, where it is
reviewed against the rest of the platform's parity tests, then syncs here
with the release that carries it. We will not disclose a vulnerability
publicly until a fixed release is available on npm.
