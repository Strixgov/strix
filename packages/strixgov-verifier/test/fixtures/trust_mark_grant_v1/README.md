# TM-1 (`trust_mark_grant_v1`) — Golden Test Vectors

The cross-language conformance corpus for the TM-1 Consumer Trust Mark capability (ADR-029) — **"is this surface governed by Strix, live, right now?"**

The fifth evidence-stack capability corpus (after MC-1, AC-1, AA-2, AA-1); the shape mirrors the AA-1 corpus. This corpus is the named unblock for the strix-platform verifier port ("item C"): the normative rule order and `tm1_*` reason-code strings live in ADR-029 + the schema-authority module, and conformance is defined against these vectors.

**Schema authority:** [`src/solo_builder/trust_mark.py`](../../src/solo_builder/trust_mark.py)
**ADR:** [`docs/architecture/ADR-029-trust-mark-grant-v1.md`](../../docs/architecture/ADR-029-trust-mark-grant-v1.md)
**JSON Schema:** [`docs/specs/trust-mark-grant-v1.schema.json`](../../docs/specs/trust-mark-grant-v1.schema.json)
**Generator (Python):** [`scripts/generate_tm1_vectors.py`](../../scripts/generate_tm1_vectors.py)
**Conformance harness (Python):** [`tests/test_golden_vectors_tm1.py`](../../tests/test_golden_vectors_tm1.py)

> **TM-1 is ACTIVE.** The ADR-029 §6 promotion (like AA-1/MC-1): TM-1 is
> `ACTIVE` in the capability registry, promoted **concurrently** with the
> strix-platform side — the `@strixgov/verifier` `TM1_CAPABILITY_STATUS` flip in
> v1.14.0 and the runtime `STRIX_TRUST_MARK_V1` flip — so the live badge and the
> independent verifier agree. Positive vectors verify against the shipped
> registry; the rule-4 fail-closed path (`tm1_capability_not_active`) is
> preserved and exercised against a RESERVED replica. See ADR-029 §6.

> **No JSON-LD.** Like AA-1/AA-2, TM-1 surfaces via the public
> grant-resolution block, not a signed-envelope JSON-LD form, so vectors
> carry no `json_ld` field.

> **Deterministic time.** Rule 8 (validity_window) depends on verification
> time, so every vector pins `verification_inputs.verified_at` explicitly.
> Harnesses MUST use the pinned time, never "now".

---

## What's here

| Directory / file | Purpose |
|---|---|
| `index.json` | Canonical manifest. Cross-language ports MUST iterate this, not the directory listing. |
| `positive/` | 7 vectors that MUST verify. Cover all 3 mark classes, coverage + revocation resolvers present/absent, the full bound-resolution embed path, and a **real Ed25519 signature**. |
| `negative/rule*.json` | 7 verify-time negatives — grant-binding mismatch, surface mismatch, expired window, not covered, coverage unavailable (substrate tri-state), revoked, revocation unavailable (substrate tri-state). |
| `negative/construction-*.json` | 7 construction-time negatives — wrong capability_id, invalid mark_class, **private key component in the heartbeat JWK**, empty grant_id, http (non-https) surface origin, malformed `kernel_policy_hash`, non-positive (boolean) `coverage_window_seconds`. |

Total: **21 vectors** (7 positive + 7 verify-time negative + 7 construction-time negative).

## The 14-field signed payload

The Strix authority signs **14** fields (locked vocabulary; additions are a
schema bump):

`grant_id` · `capability_id` · `tenant_id` · `licensee` · `mark_class` ·
`surface_origin` · `heartbeat_key` · `kernel_policy_hash` ·
`coverage_window_seconds` · `valid_from` · `valid_until` · `issued_at` ·
`iss` · `environment`.

`kernel_policy_hash` and `coverage_window_seconds` were added **pre-freeze**
(contract **0.6.0 → 0.7.0**) so verifier rule 9 (coverage) is
**independently re-derivable**: the comparand a live heartbeat is judged
against (the certified policy hash) and the staleness bound are now *signed by
the authority*, not read from an unsigned row. A verifier holding only the
signed grant + the licensee's heartbeat surface can decide coverage trusting
nothing but the authority signature.

- **`kernel_policy_hash`** — a `sha256:<64 lowercase hex>` content reference
  (regex `^sha256:[0-9a-f]{64}$`), matching the heartbeat's
  `kernelPolicyHash` / `chainHeadHash` shape so rule 9 compares like with
  like. A malformed value is a **structural** failure (schema / construction),
  never silently coerced at coverage time.
- **`coverage_window_seconds`** — a positive integer (`> 0`). It serializes as
  a **bare integer** in the canonical bytes (`...,"coverage_window_seconds":3600,...`),
  never a string. `bool` is an `int` subclass, so `true`/`false` are rejected
  explicitly — they cannot pose as a window.

The rule-9 coverage resolver receives both as keyword arguments
(`kernel_policy_hash`, `coverage_window_seconds`) extracted from the **verified
payload**. Cross-language ports MUST hand the resolver these signed comparands,
not consult an out-of-band source for "what should the policy be / how fresh is
fresh".

## The 10 verifier rules (normative order — ADR-029 §3)

`schema` → `signature` → `jwks_resolution` → `capability` → `mark_class` →
`surface_origin` → `heartbeat_key` → `validity_window` → `coverage` →
`revocation`.

Positions **9 (coverage)** and **10 (revocation)** were consumed by the
strix-platform runtime before this corpus existed and are locked —
renumbering is a contract break. Rules 9/10 are tri-state and opt-in:
`verification_inputs.coverage_status` / `revocation_status` of `null` means
"no resolver supplied; rule skipped", which is distinct from the passing
statuses (`covered` / `not_revoked`). `unavailable` is the substrate-error
case: the failure reason is `tm1_*_check_unavailable` and the public block
renders `verified=null`, never `false` — and never silently passes.

TM-1 revocation emits `tm1_revoked`, **not** a signature-invalid mapping
(AA-1's choice): revocation withdraws the grant, not the authority key.

## Coverage matrix

### Positive
| Vector | Mark class | Notes |
|---|---|---|
| 01-governed-agent | `governed_agent` | base reference |
| 02-governed-commerce | `governed_commerce` | distinct licensee + origin |
| 03-governed-content | `governed_content` | staging, origin with port |
| 04-coverage-covered | `governed_agent` | rule 9 resolver supplied |
| 05-revocation-not-revoked | `governed_agent` | rule 10 resolver supplied |
| 06-full-resolution | `governed_agent` | both bindings + both resolvers |
| 07-real-ed25519-signature | `governed_agent` | **real signature, pinned key** |

### Verify-time negative
| Vector | Rule | Reason |
|---|---|---|
| rule6-grant-binding-mismatch | `surface_origin` | `tm1_grant_binding_mismatch` |
| rule6-surface-mismatch | `surface_origin` | `tm1_surface_mismatch` |
| rule8-validity-window-expired | `validity_window` | `tm1_validity_window_violated` |
| rule9-coverage-not-covered | `coverage` | `tm1_not_covered` |
| rule9-coverage-unavailable-substrate | `coverage` | `tm1_coverage_check_unavailable` |
| rule10-revocation-revoked | `revocation` | `tm1_revoked` |
| rule10-revocation-unavailable-substrate | `revocation` | `tm1_revocation_check_unavailable` |

### Construction-time negative
| Vector | Invariant |
|---|---|
| construction-wrong-capability-id | `capability_id` const `"TM-1"` |
| construction-invalid-mark-class | `mark_class` enum membership |
| construction-private-key-component | heartbeat JWK must be public-only (no `d`) — the mint-ceremony refusal |
| construction-empty-grant-id | non-empty public resolution key |
| construction-http-surface-origin | covered surface must be an https origin |
| construction-invalid-kernel-policy-hash | `kernel_policy_hash` must match `^sha256:[0-9a-f]{64}$` (JSON Schema `pattern`) |
| construction-non-positive-coverage-window | `coverage_window_seconds` must be a positive integer (JSON Schema `type: integer` refuses the `true` boolean) |

The one construction invariant deliberately absent from the corpus is
`valid_from < valid_until` — a cross-field comparison JSON Schema cannot
express; it is locked by the dataclass, verifier rule 8, and
`tests/test_trust_mark.py` (ADR-029 §4).

## Conformance contract

A non-Python implementation is conformant when it:

1. Reproduces every vector's `canonical_bytes_hex` byte-for-byte from
   `record.payload` (SCJ v1: sorted keys, no whitespace,
   `ensure_ascii=False`-equivalent UTF-8, no NaN).
2. Verifies every positive vector (with TM-1 treated as ACTIVE) using the
   recorded `verification_inputs` — including a real Ed25519 check for
   `pos-07` against the pinned `signing_key.public_key_hex`.
3. Produces the named `failing_rule` + `reason` for every verify-time
   negative.
4. Refuses to construct every construction-time negative (error containing
   `construction_error_substring`), or — for ports without construction-time
   typing — rejects them via the JSON Schema.
5. Verifies the base positive against the shipped registry (TM-1 ACTIVE, the
   §6 promotion), and still fails it at rule 4 with `tm1_capability_not_active`
   against a RESERVED replica — the fail-closed path is preserved, it is just no
   longer the shipped default.

Regenerate with `python scripts/generate_tm1_vectors.py`; drift between the
Python reference and the committed vectors fails
`tests/test_golden_vectors_tm1.py` immediately.
