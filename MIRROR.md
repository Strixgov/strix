# Mirror & Sync Model

This document explains how this repository relates to the rest of the
Strix codebase, and how changes flow between them.

---

## TL;DR

This repository is the **public release surface** for `@strixgov/verifier`.
It is not the source of truth.

The source of truth lives **upstream in the Strix monorepo**, where the
verifier code is co-located with the kernel, the proof routes, the
canonical-payload builders that produce the records we verify, and the
parity test machinery that keeps everything aligned.

Changes flow upstream-first: a fix lands in the monorepo, gets reviewed
against parity tests with the rest of the platform, then synchronizes
down to this repository at release time.

---

## What lives here

| Artifact | Status | Notes |
|---|---|---|
| `src/index.mjs` | Mirror | Byte-for-byte mirror of the upstream source. |
| `bin/verify.mjs` | Mirror | Byte-for-byte mirror. |
| `test/*.test.mjs` | Mirror | Byte-for-byte mirror, including the redaction-promotion regression test. |
| `package.json` | Adapted | Same package metadata as upstream, with `repository.url` pointing at this repo. |
| `LICENSE`, `CHANGELOG.md` | Mirror | Byte-for-byte mirror. |
| `README.md` | Adapted | Public-facing variant of the upstream README. Includes "Status & Roadmap" framing that's specific to the public release. |
| `JWKS.md` | Public-facing | Public contract for the JWKS surface. Distilled from internal architecture docs. |
| `CANONICAL_PAYLOAD.md` | Public-facing | Public contract for the SE v1 13-field canonical payload. Distilled from internal schema docs. |
| `GOLDEN_VECTORS.md` | Public-facing | Documentation for the byte-locked test vectors. |
| `goldens/` | Generated | Test vectors. Generated from the upstream canonical builder. Lock file is the regression pin. |
| `examples/` | Generated | Offline test fixtures (verified / tamper / wrong-key / mutation). Generated from a throwaway test key. |
| `CONTRIBUTING.md`, `SECURITY.md`, `MIRROR.md` | This repo | Public-repo-specific docs. No upstream counterparts. |

---

## Why this model (not a single repo)

Three reasons:

1. **The verifier's correctness depends on parity with surfaces it doesn't ship.**
   The canonical-payload builder in this verifier MUST produce bytes
   that are byte-identical to what the upstream signer wrote. That
   parity is enforced by mirror-file checks in the monorepo's CI. If
   the verifier lived only in this repo, the parity would have to be
   re-established at every release via cross-repo coordination, which
   is harder to maintain under incident pressure.

2. **The launch-day playbook needs one fix path.**
   May 2026 brought a nine-bug stack during the verifier's launch.
   Several bugs were `~5-line` changes that affected both the signer
   AND the verifier. Coordinating those across two repos would have
   doubled the incident response time. Keeping the source upstream
   means an incident fix is one PR, one merge, and one re-sync —
   never a divergent state across two repos that drifts under
   pressure.

3. **Community-friendliness doesn't require source-of-truth.**
   This repo can still be a clean, credible, contributor-friendly
   public surface (issues accepted here, docs maintained here,
   security disclosure flow here) without being the canonical source.
   The flow in CONTRIBUTING.md works.

---

## How sync happens

Currently, sync is **manual at release time**. The procedure:

1. A new release is tagged upstream (e.g. `verifier-v1.9.5`).
2. A maintainer runs the upstream sync command (documented in the
   monorepo's `scripts/`) which produces the release tree.
3. The tree is committed to this repository as a single sync commit
   with the upstream tag as the commit message reference.
4. A new release/tag is published from this repository.
5. The npm package is published from this tag.

A future automation lives at
[`.github/workflows/sync-verifier-to-public-release.yml`](.github/workflows/sync-verifier-to-public-release.yml)
(stub; requires a deploy key or GitHub App with write access to this
repository before it can be enabled). Until that's wired up, sync is
manual but reproducible.

---

## Source freshness

The bottom of every sync commit should reference the upstream commit
hash and tag. Look at this repository's recent commit history to see
which upstream commit the current `main` corresponds to.

If you spot drift between this repo's `src/index.mjs` and the published
npm package, that's a sync bug — please file an issue.

---

## What you can do with this repository

- **Inspect the verifier source.** All of it is here, byte-identical
  to what npm publishes.
- **Run the test suite.** `npm install` is a no-op (no deps); `npm test`
  runs the suite.
- **Validate your own reimplementation** against the goldens.
- **File issues** for bugs, documentation gaps, or reimplementation
  parity issues.
- **Submit PRs** — they get reviewed here and reconciled upstream.
- **Fork it.** MIT-licensed. Use it as a starting point for any tool
  that needs Ed25519 + JWKS verification of canonical payloads.

---

## What you cannot do from this repository alone

- **Verify the upstream signer is producing correct bytes.** The goldens
  in this repo verify that the canonical *builder* in this verifier
  produces specific bytes for specific inputs. They do NOT verify that
  the upstream signer is using the same builder — that parity is
  enforced upstream.
- **Verify that production records exist as claimed.** The verifier
  validates cryptographic claims; it doesn't validate the existence
  or completeness of the upstream record set. For that, query the
  production proof API directly.

---

## Stability of this contract

The fact that this repository exists as a release surface IS itself a
public contract. If we ever decide to flip the source-of-truth model
(e.g., move authority here), it will be announced in advance with a
migration window — never a silent flip.
