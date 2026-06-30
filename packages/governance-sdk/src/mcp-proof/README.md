# `@strixgov/sdk` — MC-1 `mcp_proof_v1` verifier (TS port)

A TypeScript port of the Python schema authority
(`solo-builder-core/src/solo_builder/mcp_proof.py`, ADR-020) that **accepts a
Python-signed MC-1 bundle**. MC-1 is the governed MCP tool-call envelope — the
answer to *"did this agent invoke this tool, with these parameters, on this
server, on behalf of this principal?"* — and a sibling of AC-1
(`transaction_proof_v1`), NOT a derived type. This is WS-1 of the MC-1
promotion track: a third party can run this verifier and reproduce the
reference's verdict on every vector.

## What's here

| File | Mirrors (Python) | Purpose |
|---|---|---|
| `canonical.ts` | `_canonical.canonicalize` | The single byte contract — sorted keys, no whitespace, UTF-8. Proven byte-identical to the corpus. Reuses the SCJ v1 `canonicalizeJSON`; no parallel serializer. |
| `types.ts` | `mcp_proof.py` vocabularies | 4 MCP server kinds, 4 risk tiers, 3 execution statuses, 15 reason codes, 12 verifier rules, sub-record (`McpServer` / `ToolCall` / `ExecutionReceipt`) + 12-field payload constructors with the locked construction-time invariants (capability id, AA-PRE-2 agent pair, K-BIND-3 hashes, `tool_call.server_id` ↔ `mcp_server.id` cross-binding). |
| `verifier.ts` | `verify_mcp_proof` | The 12-rule, fixed-order, short-circuit verifier — incl. K-BIND-3 param/schema binding (rule 7) and the fail-closed `signed_server` signature path (rule 10). |
| `json-ld.ts` | `to_json_ld` / `from_json_ld` | Lossless AP2 / A2A round-trip at the locked `@context` (`…/ld/mcp-proof/v1`). |
| `parse.ts` | `_record_from_view` | Reconstruct a record from its on-wire dict view (same validation order as the reference). |
| `sign.ts` | (producer side) | Real Ed25519 MC-1 emitter — signs the nested AA-1/AA-2 attestations + the outer envelope, reusing the shared `Ed25519Keyring`. The WS-2 enabler the `@strixgov/mcp-adapter` v0.2 path composes a record through. |
| `tool-call-block.ts` | `ToolCallBlock` / `render_tool_call_block` | ADR-014 §3 / ADR-020 §5 public-endpoint block, tri-state `verified` (true / null-on-substrate-error / false), privacy invariant (no hashes / signatures / attestations leave the bundle). |

The AA-1 / AA-2 sub-verifiers (rules 3/4/5), the capability registry (rule 2),
and the pluggable crypto protocols are **shared** with AC-1 — MC-1 reuses
`../transaction-proof/{actor-attestation,device-attestation,capabilities,verifier-types}.ts`
rather than forking them. The Python reference proves they are shared
(`mcp_proof.py` and `transaction_proof.py` both import the one
`actor_attestation` / `device_attestation` module); there is exactly one AA-1
and one AA-2 verifier in this SDK, and no sibling drift.

## Crypto is pluggable

`verifyMcpProof` injects a `SignatureVerifier` (rule 12 bundle signature), a
`PlanResolver` (rule 6/7), and optional `McpServerResolver` (rule 9) +
`ServerSignatureResolver` (rule 10). The conformance corpus replays with an
`AlwaysGood` verifier exactly as the Python harness does; production wires a
real Ed25519 verifier and the gateway-side resolvers. The verifier is
synchronous, matching the reference.

## Conformance

The cross-language contract is the corpus under
`tests/golden-vectors/mcp_proof_v1/` — a byte-identical copy of the Python
authority's `vectors/mcp_proof_v1/` (25 vectors: 10 positive across all 4
server kinds + 3 execution statuses, 11 verify-time negatives, 4
construction-time negatives). Run the drift gate:

```bash
pnpm run test:mc1-conformance     # node:test, no vitest dependency
```

It asserts: every positive vector re-canonicalizes to the pinned
`canonical_bytes_hex` and verifies clean; the JSON-LD form round-trips to the
same bytes; every verify-time negative returns the named `failing_rule` +
`reason`; every construction-time negative is rejected with the named
substring; and the ADR-020 §5 public block renders the correct tri-state
(`verified=null` only on the `mcp_server` substrate-error path). CI:
`.github/workflows/conformance.yml` `transaction-proof` job (Node 20/22/24),
via `pnpm run test:conformance`. The vitest mirror
`tests/mcp-proof-goldens.test.ts` encodes the same contract for environments
with a working vitest.

The **real-Ed25519 round-trip** (sign → publish JWKS → neutral third party
verifies, tamper rejected, wrong-origin fails closed) runs via:

```bash
pnpm run dogfood:mc1              # node:test, real node:crypto Ed25519
```

Byte-identity with the Python reference is established two ways: every corpus
vector re-canonicalizes to the Python authority's pinned `canonical_bytes_hex`
(verifier direction), and a record signed by `sign.ts` verifies VALID under
the Python `verify_mcp_proof` (emitter direction, confirmed out of band).

## Promotion gate (what WS-1 does and does not close)

This module closes the **TS verifier** precondition for promoting MC-1
`RESERVED → ACTIVE`. Still open (tracked in
`solo-builder-core/docs/operations/mc1-ts-port-scope.md`): the
`@strixgov/mcp-adapter` v0.2 MC-1 emission (WS-2), a `signed_server`
attestation path (WS-3), a gateway plugin consuming MC-1 (WS-4), the public
`/proof/[evidenceId]` `toolCall` surface (WS-5), and the two external items
(npm publish, third-party verification). `capabilities.ts` keeps MC-1
`RESERVED` by default — promotion stays a deliberate, gated edit.
