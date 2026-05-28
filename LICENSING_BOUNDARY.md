# Licensing Boundary

Strix uses a deliberate **two-tier license split**, not a single license. This
document is the canonical definition of that boundary. It exists so the split
is explicit, defensible, and cannot drift later through convenience PRs.

The split is enforced in CI by `scripts/lint-license-parity.mjs`
(workflow: `.github/workflows/license-parity-lint.yml`). That linter is the
freeze: changing a package's tier requires editing the linter's `POLICY` table,
the package's `LICENSE` file, its `package.json` `license` field, **and** this
document together.

## The principle

- **Open trust primitives → MIT.** Independent verification only has value if
  anyone can inspect and run the verification surface freely. Open verifier +
  public JWKS + canonical payload specs materially strengthen the trust claims
  Strix makes publicly. Friction here would undermine credibility and adoption.
- **Protected runtime / control surfaces → Elastic License 2.0.** The execution
  enforcement and control-plane orchestration are the defensible
  commercialization moat. Source-available and free to use, but not free to
  resell as a competing managed service.

This avoids the dangerous middle ground: MIT-everywhere would weaken the moat
around runtime governance; Elastic/BSL-everywhere would weaken the credibility
and adoption velocity of the verification layer.

## Tier 1 — Open trust primitives (MIT)

The surfaces a third party must be able to read, run, and trust without
permission:

| Package | Path | Why open |
|---|---|---|
| `@strixgov/verifier` | `packages/strixgov-verifier` | Offline verification primitive; the proof only matters if anyone can run it |
| `@strixgov/sdk` | `packages/governance-sdk` | SDK interfaces / governed-action contract |
| `@strixgov/tool-gateway` | `packages/tool-gateway` | Local-first developer distribution surface |
| `@strixgov/capabilities-claude-code` | `packages/strixgov-capabilities-claude-code` | Capability schema contracts |
| `@strixgov/capabilities-mcp-common` | `packages/strixgov-capabilities-mcp-common` | Capability schema contracts |
| `@strixgov/mcp-token-validator` | `packages/strixgov-mcp-token-validator` | Token-validation primitive |

Canonical payload schemas, JWKS verification semantics, and capability schema
contracts that ship inside these packages inherit MIT by virtue of being part
of them.

## Tier 2 — Protected runtime / control surfaces (Elastic-2.0)

The execution and orchestration surfaces that constitute the moat:

| Package | Path | Why protected |
|---|---|---|
| `@strixgov/mcp-adapter` | `packages/strixgov-mcp-adapter` | MCP runtime gateway / governed `callTool` enforcement |
| `@strixgov/mcp-proxy` | `packages/strixgov-mcp-proxy` | MCP runtime proxy |

The hosted governance kernel, policy execution infrastructure, and hosted
coordination surfaces are not published packages and are not distributed under
either license; they are operated, not shipped.

## Private / unpublished apps (not gated)

Some internal apps declare a license in `package.json` but set
`"private": true` and are **not** published to npm. They are therefore not part
of the public license surface and are **not** enforced by the parity gate:

- `apps/strix-ct-sequencer` (`@strixgov/ct-sequencer`, currently Elastic-2.0, private)
- `apps/strix-ct-witness` (`@strixgov/ct-witness`, currently MIT, private)

> **Open item — sequencer/witness topology.** If the CT sequencer/witness
> operational topology is ever published, it must be explicitly placed in a
> tier. The sequencer leans protected (Elastic-2.0); the witness's tier should
> be decided deliberately at publish time rather than inherited from its
> current advisory header. Until then, their headers carry no public
> commitment.

## Copyright

All Strix-authored `LICENSE` files use:

```
Copyright (c) 2026 Velaris Group
```

(The root `LICENSE` previously carried an incorrect upstream attribution; it has
been corrected to the line above.)

## How to add or reclassify a package

1. Decide the tier from the principle above (trust primitive → MIT; runtime /
   control → Elastic-2.0). If it is genuinely neither, that is a signal to
   reconsider the boundary, not to invent a third tier silently.
2. Set the `license` field in the package's `package.json`.
3. Add the matching `LICENSE` file (copy the MIT or Elastic-2.0 text from an
   existing same-tier package).
4. Add the package path to `POLICY` in `scripts/lint-license-parity.mjs`.
5. Add a row to the appropriate table above.
6. Confirm `node scripts/lint-license-parity.mjs` exits 0.

A new **published** package under `packages/` that is missing from the linter's
`POLICY` fails CI by design — public surface cannot ship unclassified.
