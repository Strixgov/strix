# Public Release Invariants

The public-facing chain-of-custody statement for this repository. It says
what this repo *is*, how it is derived, and what is guaranteed about that
derivation — so a third party auditing or depending on these packages can
reason about provenance without trusting us by reputation.

Companion to [MIRROR.md](MIRROR.md) (the how) — this document is the
*contract* (the what-must-hold).

---

## Source of truth

- **Authoritative source:** the upstream Strix monorepo (private). All
  package code, tests, canonical-payload builders, and parity machinery
  live there, co-located with the systems that produce the records these
  packages verify.
- **This repository is a derived artifact.** It is a mirror. It is not the
  source of truth, and editing it does not change what npm publishes.
- Changes flow upstream-first: land in the monorepo → reviewed against
  platform-wide parity tests → synchronized here at release time.

This is a **directory-layout + derivation contract, not an authority
model**. Moving files within this mirror (e.g. the verifier's relocation
from repo root into `packages/strixgov-verifier/`) does not move authority.
Any change to the *authority* model — making this repo canonical — would be
announced in advance with a migration window, never a silent flip.

---

## Expected layout (locked)

This repo is a monorepo. Each package lives under `packages/<name>/` at the
exact path its published `package.json` declares in `repository.directory`:

| Package | Path |
|---|---|
| `@strixgov/verifier` | `packages/strixgov-verifier/` |
| `@strixgov/tool-gateway` | `packages/tool-gateway/` |
| `@strixgov/capabilities-claude-code` | `packages/strixgov-capabilities-claude-code/` |
| `@strixgov/capabilities-mcp-common` | `packages/strixgov-capabilities-mcp-common/` |
| `@strixgov/mcp-adapter` | `packages/strixgov-mcp-adapter/` |
| `@strixgov/mcp-proxy` | `packages/strixgov-mcp-proxy/` |
| `@strixgov/verify-embed` | `packages/strixgov-verify-embed/` |
| `@strixgov/healthcare-demo` | `packages/strixgov-healthcare-demo/` |

Adding or removing a package is a deliberate change that updates this table
**and** the locked `EXPECTED_PACKAGES` list in the upstream invariant lint
in the same change.

---

## Invariants

Enforced upstream by `scripts/lint-public-release-invariants.mjs` over the
staging tree before it is pushed here:

- **PR-1 — Repository truthfulness.** Every package's
  `repository.directory` equals its own path under `packages/`, and
  `repository.url` is `https://github.com/Strixgov/strix`. The "Repository"
  link on every npm page resolves to the actual source.
- **PR-2 — Path existence.** Every declared `repository.directory` exists in
  the tree. (Operationally also enforced at sync time — the sync script
  refuses to mirror a package into a path that disagrees with its metadata.)
- **PR-3 — Locked package set.** The package set is exactly the expected
  list — no missing packages, no unexpected directories under `packages/`.
- **PR-4 — Root scaffolding.** The workspace `package.json`
  (`workspaces: ["packages/*"]`) and the repo-level docs are present.
- **PR-5 — Baseline files.** Every package ships `package.json`,
  `README.md`, and `LICENSE`.

---

## Sync guarantees

- **Reproducible tooling.** The mirror is produced by deterministic sync
  scripts (`scripts/sync-verifier-to-public-release.mjs` for the verifier,
  `scripts/sync-packages-to-public-release.mjs` for the rest), not ad-hoc
  packaging. Re-running them against an unchanged upstream produces an
  unchanged tree.
- **Byte-for-byte source mirror.** Package `src/`, `bin/`, and `test/` are
  copied verbatim from upstream. `package.json` is adapted only to set
  `repository.directory`; no behavioral fields are rewritten.
- **Honest about the human step.** Today the push to this repo is
  **manual** — the release-time automation
  (`.github/workflows/sync-public-release.yml`) is a stub pending a deploy
  key / GitHub App with write access here. Until that lands, "reproducible"
  applies to the *tree generation*, not the push: a human runs the sync and
  pushes. The invariant lint gates the staging tree, not this live repo, so
  the trusted step is "the push mirrors the staged tree verbatim."

---

## Intentionally omitted from the mirror

- The hosted Strix kernel, Console, proof routes, and platform application
  code. This repo is the open verification + governed-execution primitives
  only.
- Internal architecture docs, runbooks, and ceremony scripts. Public
  contracts (JWKS, canonical-payload, golden-vector docs) are distilled into
  each package's own docs; the internal originals stay upstream.
- CI for the platform. The invariant lint above runs upstream against the
  staging tree, not in this repo.

---

## Release provenance expectations

- Each package version on npm corresponds to a tag on the upstream monorepo
  (`<pkg-slug>-v<semver>`), and the publish runs from upstream CI
  (`publish-packages.yml`), not from this repo.
- This repo's history records *what was mirrored*; the upstream tag records
  *what was published*. They are expected to agree at each release.
- Forward-looking (not yet in place): signed release attestations / SLSA
  provenance / transparency-log inclusion would attach here as they land.
  This document is the seam they plug into.

---

## What you can rely on today

- Clone this repo and read the exact source npm publishes (modulo the
  adapted `repository.directory`).
- Run each package's suite cross-platform: `npm test --workspaces` (or
  `node --test` inside a package) — works on Windows, macOS, Linux.
- Validate your own reimplementation against `packages/strixgov-verifier/goldens/`.
- File issues and PRs here; they reconcile upstream per
  [CONTRIBUTING.md](CONTRIBUTING.md).

## What you cannot rely on from this repo alone

- That the upstream signer produces bytes matching the verifier's builder —
  that parity is enforced upstream, not provable from the mirror.
- That the published npm tarball is byte-identical to this tree at any given
  moment between releases — the guarantee is per-release, not continuous.
- That this repo is the authority — it is a derived artifact.
