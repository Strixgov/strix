# Changelog — `@strixgov/sdk`

All notable changes to the published package. Dates are UTC.

## 0.4.0 — 2026-06-02

### Changed
- **MC-1 (`mcp_proof_v1`) promoted `RESERVED` → `ACTIVE`.** The verifier's
  capability gate (rule 2) now admits production `mcp_proof_v1` receipts.
  Governed Tool Action Receipts that are signed by the production operational
  key and pass all 12 rules now return `VERIFIED` against the live public JWKS
  with no Strix account.

### Why this is sound now (the promotion gate)
- A real receipt signed by the production operational key (`strix-prod-2026-06`)
  was minted and verified against `/.well-known/strix-jwks.json`. Before this
  release the **only** failing rule was the capability gate; signature,
  principal/agent attestation, plan binding (ADR-012), and the K-BIND-3
  parameter binding all passed. This flip is the single deliberate change that
  lets that receipt verify — nothing about the verifier's semantics changed.
- Promoted concurrently with the Python schema authority
  (`solo_builder.capabilities`) so the two registries stay in lockstep.

### Boundaries (unchanged)
- AA-2 and AC-1 remain `RESERVED`. The flip is MC-1 only.
- This activates the **receipt layer + public verification path**. The runtime
  rollout that emits receipts across every governed integration
  (`@strixgov/mcp-adapter`) continues; this release makes the receipts that
  *are* produced independently verifiable. We do not claim "every tool action
  is verified."
- The gate mechanism is intact, not removed: forcing MC-1 back to `RESERVED`
  still fails closed at rule 2 (pinned by `scripts/mc1-injected-key.mts` test 9).

### Verification
- Conformance 36/36, injected-key 9/9, MC-1 dogfood 3/3, mcp-proof goldens
  91/91, `tsc --noEmit` clean.

## 0.3.0 — 2026-06-02

### Added
- **MC-1 injected-key signing adapter.** `Ed25519Keyring` now accepts
  caller-held key material via `injectPrivateKey(iss, kid, KeyObject | raw-32-seed)`,
  plus an optional `strict` constructor flag. This lets a holder of an existing
  Ed25519 private key (e.g. the production operational key) sign an
  `mcp_proof_v1` receipt under a specific published `(iss, kid)` — instead of
  deriving a throwaway key from the keyring seed. In `strict` mode, signing an
  un-injected `(iss, kid)` fails closed (throws) rather than silently deriving.
  The private key is never exposed (no getter) or serialized; only the derived
  raw **public** key is exposed (`publicKeyHex` / `jwksByOrigin`).

### Unchanged / boundaries
- **This is a signing adapter, not a trust upgrade.** **MC-1 remains
  `RESERVED`.** The verifier still fails closed at rule 2
  (`mc1_capability_not_active`); a receipt minted with an injected production
  key resolves its key on the public JWKS but only verifies `VERIFIED` after the
  deliberate `RESERVED → ACTIVE` promotion ships in a later release. Verifier
  semantics are unchanged.
- Derived-key signing (the existing `new Ed25519Keyring()` path) is byte-for-byte
  unchanged; AC-1 (`transaction_proof_v1`) is unaffected.

### Verification
- Injected-key tests: 9/9 (`scripts/mc1-injected-key.mts`). Cross-language
  conformance: 36/36. MC-1 real-Ed25519 dogfood: 3/3. `tsc --noEmit` clean.
  No private key material in tests, fixtures, or docs.

## 0.2.0 — 2026-06-02

### Added
- **MC-1 (`mcp_proof_v1`) TypeScript verifier + reference signer** under the
  `@strixgov/sdk/mcp-proof` subpath: the 12-rule fixed-order verifier
  (`verifyMcpProof`), the reference signer (`signMcpProof` + `Ed25519Keyring`),
  canonical bytes, parse, JSON-LD round-trip, and the ADR-020 §5 tri-state
  public `toolCall` block. Conformant to the Python schema authority's 25-vector
  golden corpus (byte-identical), with a real-Ed25519 "verify in the wild"
  dogfood.
- The SDK is the **open verifier surface** (MIT) for Tool Action Receipts — a
  third party can `npm install @strixgov/sdk` and verify a receipt with no Strix
  account. The runtime (`@strixgov/mcp-adapter`, kernel) stays closed.

### Boundaries
- MC-1 ships `RESERVED`. The verifier fails closed (`mc1_capability_not_active`)
  until the cross-repo promotion gate is earned. No public claim of "active"
  is made by this release.
