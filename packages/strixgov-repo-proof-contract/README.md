# @strixgov/repo-proof-contract

The canonical contract for the Repo-to-Proof manifest.

**The schema is the source.** `schema/repo-proof-manifest-v1.schema.json` is
language-neutral and authoritative. The TypeScript and Python bindings under
`generated/` are produced from it and are **never hand-maintained** — that is a
ratified constraint (W0-0 Acceptance 1), and `--check` enforces it in both
directions:

```bash
node scripts/generate-bindings.mjs          # write the bindings
node scripts/generate-bindings.mjs --check  # CI: fail on ANY divergence
node --test test/*.test.mjs                 # contract tests
```

A hand-edited binding fails. A schema change without a regenerate fails.
Neither is visible by reading the files, which is why the check exists.

## Authority

Owned by the Strix Platform Architecture owner/operator. **Consumers may
propose changes; they may not redefine the contract.** The package is neutral
with respect to consumers — it deliberately lives outside
`integrations/openclaw/`, `solo-builder-core`, `@strixgov/sdk`, the Console UI,
the attack runner, the proof renderer, and any individual specimen — but it is
not ownerless.

## Three capability namespaces, never collapsed

`capabilityReconciliation` preserves all three roles rather than merging them
into one identifier:

| Field | Namespace | Role |
|---|---|---|
| `discoverySignal` | `gsd1` | what discovery detected |
| `governedEffect` | `specimen-declared` / `strix-effect` | the real-world effect claimed to be mediated |
| `enforcementAction` | `governed-action-types` | what the kernel actually evaluates |

plus `disposition` (exact · broader · narrower · composite · **unresolved** ·
inapplicable) and `provenance` (derived · manually-reviewed ·
specimen-declared).

`unresolved` is a **first-class outcome**, not a gap to be closed so a manifest
validates. And a `derived` mapping may never be asserted `exact` — that is
string similarity by another name, and the validator refuses it.

## What the validator refuses

- an `enumerated` ungoverned set that omits a relevant path (RPF-2)
- `enumerated` without naming the surface map it was derived from (RPF-2)
- an in-process hook declared unbypassable (RPF-3)
- a `derived` mapping asserted `exact` (anti-aliasing)
- identity by tag, branch, short SHA or bare project name (Acceptance 2)

Validation reports refusals. It never repairs a manifest to make it pass.
