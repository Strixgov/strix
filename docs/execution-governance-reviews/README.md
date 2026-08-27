# Execution Governance Reviews

A series of vendor-neutral, source-cited reviews of how public AI agent
frameworks and runtimes handle **execution governance** — what happens between
an agent deciding to act and the side effect actually occurring.

Each review is a point-in-time read of a third party's public code, scored on
the same five fixed dimensions, with every score cited to a file and a named
symbol so any finding can be re-checked against the source.

## The five dimensions

Every review scores the same five questions, ★–★★★★★:

1. **Capability model** — what can the agent reach, and is the *right* to
   invoke an action distinct from the mere ability to call it?
2. **Policy / trust root** — where does authority originate, and can the
   governed process alter its own policy through its own tools?
3. **Execution control** — is there an on-path, pre-execution gate that can
   actually stop a side effect before it happens — and what authorizes
   passing through it?
4. **Evidence** — what durable record exists of what was decided and done,
   and could the party whose actions are in question alter it?
5. **Independent verification** — can a third party check that record with
   standard tooling, without trusting the system that produced it?

## Series rules

- **Vendor-neutral.** Review bodies name no product of ours and are never to
  be cited as third-party validation of anything we ship. Credit is given
  where the reviewed code earns it.
- **Cited, not asserted.** Every score is grounded in file paths and named
  symbols — at a pinned commit where one was obtainable, and disclosed
  plainly where it was not.
- **Point-in-time.** Scores describe the codebase as of the stated read
  date, not necessarily today's. Symbols move; line numbers are never cited.
- **Disputable by construction.** If a maintainer disputes a finding, the
  answer is to re-check the cited symbols at the stated read date — never a
  defense of the score against a later tree.

## Corrections

To dispute or correct a review, open an issue in this repository citing the
review number and the specific cited file/symbol. Accepted corrections are
recorded in the review's own publication-record header — reviews are never
silently edited.

## Published reviews

| # | Target | Read date | Published | Scores (1–5 dims) |
|---|--------|-----------|-----------|-------------------|
| 05 | [OpenWorker](05-openworker.md) (`andrewyng/openworker`) | 2026-08-26 | 2026-08-26 | ★★★ · ★★★ · ★★★★ · ★★ · ★ |

Reviews are added here as their public forms are published; numbering follows
the series' order, so gaps close over time.
