# `@strixgov/sdk` — AC-1 `transaction_proof_v1` verifier (TS port)

A TypeScript port of the Python schema authority
(`solo-builder-core/src/solo_builder/transaction_proof.py`, ADR-018) that
**accepts a Python-signed AC-1 bundle**. This is Deliverable #1 of the
"independently verifiable AC-1 receipt" track: a third party with no special
setup can run this verifier and reproduce a `VERIFIED` verdict (and a
tampered copy is rejected).

## What's here

| File | Mirrors (Python) | Purpose |
|---|---|---|
| `canonical.ts` | `_canonical.canonicalize` | The single byte contract — sorted keys, no whitespace, UTF-8. Proven byte-identical to the corpus (see below). Reuses the SCJ v1 `canonicalizeJSON`; no parallel serializer. |
| `types.ts` | `transaction_proof.py` vocabularies | 4 counterparty kinds, 5 transaction kinds, 6 networks, 14 reason codes, 12 verifier rules, sub-record + payload constructors with the locked construction-time invariants. |
| `actor-attestation.ts` | `actor_attestation.verify_attestation` | AA-1 sub-verifier (rules 3 & 4 delegate here) + AA-PRE-2 allow-set. |
| `device-attestation.ts` | `device_attestation.verify_device_attestation` | AA-2 sub-verifier (rule 5 delegates here) + DEVICE-PRE-2 allow-set. |
| `network-signatures.ts` | `network_signatures.py` | Real `Ed25519NetworkSignatureResolver` for rule 10 (gate C). Fail-closed. |
| `capabilities.ts` | `capabilities.py` | RESERVED→ACTIVE registry (AA-1 ACTIVE; AA-2 / AC-1 RESERVED by default — never flipped unilaterally in source). |
| `verifier.ts` | `verify_transaction_proof` | The 12-rule, fixed-order, short-circuit verifier. |
| `json-ld.ts` | `to_json_ld` / `from_json_ld` | Lossless AP2 / A2A round-trip at the locked `@context`. |
| `parse.ts` | `_record_from_view` | Reconstruct a record from its on-wire dict view (same validation order as the reference). |

## Crypto is pluggable

`verifyTransactionProof` injects a `SignatureVerifier` (rule 12 bundle
signature) and an optional `NetworkSignatureResolver` (rule 10). The
conformance corpus replays with an `AlwaysGood` verifier exactly as the
Python harness does; production wires a real Ed25519 verifier. The bundled
`Ed25519NetworkSignatureResolver` uses `node:crypto` (synchronous, so the
whole verifier stays synchronous like the reference); a browser/edge build
can supply a WebCrypto-backed resolver via the same interface.

## Conformance

The cross-language contract is the corpus under
`tests/golden-vectors/transaction_proof_v1/` — a byte-identical copy of the
Python authority's `vectors/transaction_proof_v1/` (30 vectors, incl. the
non-Strix-issuer `ac1-pos-12`). Run the
drift gate:

```bash
pnpm run test:ac1-conformance     # node:test, no vitest dependency
```

It asserts: every positive vector re-canonicalizes to the pinned
`canonical_bytes_hex` and verifies clean; every verify-time negative returns
the named `failing_rule` + `reason`; every construction-time negative is
rejected with the named substring; and the **gate-C** vector's real Ed25519
network signature is cryptographically checked (wrong key / tampered
signature fail). CI: `.github/workflows/ac1-conformance.yml` (Node 20/22/24).
The vitest mirror `tests/transaction-proof-goldens.test.ts` encodes the same
contract for environments with a working vitest.

## Not yet ported (tracked follow-ups in the AC-1 program)

- `proof_bundle_v2` outer-envelope verifier (Deliverable #1, remaining half).
- Runtime wiring: `/api/transaction-proof/verify`, the `/proof/[evidenceId]`
  transaction block, `<strix-proof-badge>` (Deliverable #3).
