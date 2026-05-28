# Mirror & Sync Model

This document explains how this repository relates to the rest of the
Strix codebase, and how changes flow between them.

---

## TL;DR

This repository is the **public release surface** for the Strix
open-source packages. It is not the source of truth.

It is a monorepo. Each package lives under `packages/<name>/`, at the
exact path that package's published `package.json` declares in
`repository.directory`:

| Package | Public path | npm |
|---|---|---|
| `@strixgov/verifier` | `packages/strixgov-verifier/` | live |
| `@strixgov/tool-gateway` | `packages/tool-gateway/` | live (0.4.1) |
| `@strixgov/capabilities-claude-code` | `packages/strixgov-capabilities-claude-code/` | live (0.1.0) |
| `@strixgov/capabilities-mcp-common` | `packages/strixgov-capabilities-mcp-common/` | live (0.1.1) |
| `@strixgov/mcp-adapter` | `packages/strixgov-mcp-adapter/` | live (0.1.0) |

The source of truth lives **upstream in the Strix monorepo**, where the
package code is co-located with the kernel, the proof routes, the
canonical-payload builders that produce the records we verify, and the
parity test machinery that keeps everything aligned.

Changes flow upstream-first: a fix lands in the monorepo, gets reviewed
against parity tests with the rest of the platform, then synchronizes
down to this repository at release time.

---

## Layout history

The verifier shipped first, before the multi-package plan, and
originally lived at the repo root. It now lives at
`packages/strixgov-verifier/` alongside the other packages. This was a
**directory-layout change only** — it did not change the source-of-truth
model (authority stays upstream; see "Stability of this contract"
below). The relocation also made every package's npm "Repository" link
resolve (each points at `Strixgov/strix/tree/main/packages/<name>`) and
let `@strixgov/tool-gateway`'s byte-parity suite run from this mirror —
those tests import the verifier as a sibling
(`../strixgov-verifier/src/index.mjs`), which only resolves once both
are under `packages/`.

---

## What lives here

Per package, under `packages/<name>/`:

| Artifact | Status | Notes |
|---|---|---|
| `src/` | Mirror | Byte-for-byte mirror of the upstream source. |
| `bin/` | Mirror | Byte-for-byte mirror (packages that ship a CLI). |
| `test/*.test.mjs` | Mirror | Byte-for-byte mirror. The verifier's redaction-promotion regression test and tool-gateway's verifier-parity suite both live here. |
| `package.json` | Adapted | Same package metadata as upstream, with `repository.directory` set to this package's path. |
| `LICENSE`, `CHANGELOG.md` | Mirror | Byte-for-byte mirror. |
| `README.md` | Adapted | Public-facing variant of the upstream README. |
| `assets/` | Mirror | Hero SVG + any package badges. |

Verifier-only, under `packages/strixgov-verifier/`:

| Artifact | Status | Notes |
|---|---|---|
| `JWKS.md` | Public-facing | Public contract for the JWKS surface. Distilled from internal architecture docs. |
| `CANONICAL_PAYLOAD.md` | Public-facing | Public contract for the SE v1 13-field canonical payload. Distilled from internal schema docs. |
| `GOLDEN_VECTORS.md` | Public-facing | Documentation for the byte-locked test vectors. |
| `SECURITY.md` | Public-facing | Verifier-specific security policy (the verifier is a cryptographic primitive; bugs are security-class). |
| `goldens/` | Generated | Test vectors. Generated from the upstream canonical builder. Lock file is the regression pin. |
| `examples/` | Generated | Offline test fixtures (verified / tamper / wrong-key / mutation). Generated from a throwaway test key. |

Repo root:

| Artifact | Status | Notes |
|---|---|---|
| `README.md` | This repo | Monorepo landing page — what each package is, how the mirror works. |
| `package.json` | This repo | Workspace root (`packages/*`). No dependencies; pins the package set. |
| `CONTRIBUTING.md`, `MIRROR.md`, `LICENSE` | This repo | Repo-level docs. No upstream counterparts. |
| `PUBLIC_RELEASE_INVARIANTS.md` | This repo | The chain-of-custody contract: source of truth, locked layout, derivation invariants (PR-1..PR-5), sync guarantees, what's omitted, provenance expectations. Enforced upstream by `scripts/lint-public-release-invariants.mjs`. |
| `LICENSING_BOUNDARY.md` | Mirror | Byte-for-byte mirror of the upstream root `LICENSING_BOUNDARY.md`. Documents the MIT / Elastic-2.0 split across all `@strixgov/*` packages. Referenced from `packages/tool-gateway/README.md` via `../../LICENSING_BOUNDARY.md`; must stay present at this repo root for that link to resolve on the public mirror. |

Marketing surface, under `marketing/<slug>/`:

| Artifact | Status | Notes |
|---|---|---|
| Static page bundles (HTML / JSX / CSS / SVG / mp4) | Mirror | Byte-for-byte mirror of the corresponding folder under `apps/strix-verify-web/marketing/<slug>/` in the upstream monorepo. Source of truth stays upstream; this directory is just a sibling-publication of the same files so anyone who clones the public repo can inspect, fork, or self-host the page. |
| `README.md` | Adapted | Public-facing variant of the upstream README — same files inventory, but the hosting + CSP guidance is rewritten for someone serving the page outside of upstream's Vercel deployment. |

Marketing-bundle invariants (no separate linter today; check by hand at sync time):

- Each `marketing/<slug>/` directory is self-contained — no relative imports that climb out of the directory, no hard dependency on upstream-only paths.
- No build step. The bundle is whatever's needed for `npx http-server` to serve it.
- Asset weight stays within reason for a public git repo (per-bundle target: < 25 MB committed). The mp4 in `marketing/mcp-tool-gateway/assets/` is the largest item today at ~13 MB.

Sync tooling (upstream, in the monorepo):
[`scripts/sync-verifier-to-public-release.mjs`](../../scripts/sync-verifier-to-public-release.mjs)
mirrors the verifier (with fixture + golden regeneration);
[`scripts/sync-packages-to-public-release.mjs`](../../scripts/sync-packages-to-public-release.mjs)
mirrors the tool-gateway + capability packs. The marketing surface is
not yet covered by a sync script — bundles are mirrored manually at
release time alongside the other artifacts in the same push. A future
`sync-marketing-to-public-release.mjs` can land if the cadence
warrants it.

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

A future automation lives upstream at
`.github/workflows/sync-public-release.yml`
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
