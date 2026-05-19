# Signed Evidence v1 — Canonical Payload Specification

The signed bytes of a Strix governance evidence record. **Locked schema.**
Reordering any field or adding new fields invalidates every previously-
signed record; changes ship as a new schema version (v2) side-by-side
with v1, never as a silent flip.

This document is the public-contract version of the canonical-payload
specification. If you are reimplementing the canonical builder in
another language or runtime, this is the authoritative source.

For byte-locked test vectors against which to validate your
reimplementation, see [GOLDEN_VECTORS.md](GOLDEN_VECTORS.md) and
[`goldens/se-v1-canonical-vectors.json`](goldens/se-v1-canonical-vectors.json).

---

## The 13 fields, in locked order

| # | Field | Type | Description |
|---|---|---|---|
| 1 | `schemaVersion` | integer | Always `1` for SE v1. |
| 2 | `evidenceId` | integer | Monotonically-increasing record identifier. Unique per source system. |
| 3 | `evidenceHash` | string (64 hex chars) | SHA-256 of the original event content, prior to signing. The hash anchors the record's identity in the proof chain. |
| 4 | `proofChainHash` | string (64 hex chars or empty) | SHA-256 of the previous record's canonical payload. Empty string for the genesis record. |
| 5 | `capabilityId` | string | Identifier of the governed capability (e.g. `admin.members.updateRole`). |
| 6 | `action` | string | The decision: `allow`, `deny`, `intercept`. |
| 7 | `actorId` | string | Stable identifier of the actor that initiated the action. Format varies by source (user ID, system identifier, agent ID). |
| 8 | `actorRole` | string | Role classification: `owner`, `admin`, `member`, `system`, `agent`. |
| 9 | `createdAt` | string (RFC 3339, ms, Z suffix) | When the original event occurred. Format: `YYYY-MM-DDTHH:MM:SS.sssZ`. **Always Z-suffixed; never an offset.** |
| 10 | `signingKeyId` | string | The kid of the key that signed this record. Always the FULL kid (e.g. `strix-prod-2026-05`), never the redacted form. |
| 11 | `environment` | string | Deployment environment at signing time: `production`, `staging`, `dev`, etc. |
| 12 | `tenantId` | string | Tenant identifier at signing time. Distinct from any RLS-layer scoping. |
| 13 | `regulatoryContext` | object | EU AI Act compliance context — see below. |

### `regulatoryContext` sub-object

Always present, even if `complianceMode` is null. Field order within the
sub-object is also locked.

| # | Field | Type | Description |
|---|---|---|---|
| 1 | `complianceMode` | string \| null | The compliance regime that applied at signing time. `"eu-ai-act"` for records signed under EU AI Act applicability; `null` for records where no specific framework was declared. |
| 2 | `euAiActArticle12` | boolean | Whether Article 12 (technical documentation) applies. |
| 3 | `euAiActArticle14` | boolean | Whether Article 14 (human oversight) applies. |
| 4 | `euAiActArticle28` | boolean | Whether Article 28 (provider obligations) applies. |

The article flags declare **applicability at signing time**, not
per-record verification outcomes. The verifier derives the four EU AI
Act compliance flags from cryptographic outcomes after the fact:

- `article12_tamper_resistant` ← `hashValid AND chainValid AND signatureValid`
- `article12_traceable` ← `chainValid AND signatureValid`
- `article14_human_oversight` ← `signaturePresent AND actorFieldsBound`
- `article28_provider_obligations` ← `signatureValid`

A record signed without `regulatoryContext.complianceMode` set returns
`compliance: null` from the public verify endpoint — never a synthetic
green check. (CI-5: truthful representation. We don't claim a
compliance property we didn't verify.)

---

## Serialization rules

The canonical payload is a UTF-8 JSON document with **explicit field
ordering**. The verifier reconstructs it with a hand-written serializer
that emits fields in the order above; relying on `JSON.stringify` to
preserve insertion order is fragile across engines and is forbidden in
production code.

Specifically:

1. **Field order is the order in the table above.** No re-ordering, no
   alphabetization.
2. **No whitespace.** Compact serialization. No leading/trailing
   whitespace, no indentation, no newlines.
3. **Strings are JSON-escaped UTF-8.** Standard `JSON.stringify` rules
   for strings apply.
4. **Booleans and numbers are bare.** `true`, `false`, `42` — no
   quoting.
5. **`null` values serialize as `null`** — they must not be elided.
   `complianceMode: null` MUST appear as `"complianceMode":null` in the
   canonical bytes.
6. **Nested objects** (only `regulatoryContext`) follow the same
   ordering and serialization rules recursively.

Example canonical bytes (formatted across lines for readability — the
actual canonical form is single-line, no whitespace):

```json
{
  "schemaVersion":1,
  "evidenceId":5686,
  "evidenceHash":"...64 hex chars...",
  "proofChainHash":"...64 hex chars...",
  "capabilityId":"cron.evidenceOutboxRetry",
  "action":"allow",
  "actorId":"system:cron",
  "actorRole":"system",
  "createdAt":"2026-05-15T05:27:14.691Z",
  "signingKeyId":"strix-prod-2026-05",
  "environment":"production",
  "tenantId":"example-tenant",
  "regulatoryContext":{
    "complianceMode":"eu-ai-act",
    "euAiActArticle12":true,
    "euAiActArticle14":true,
    "euAiActArticle28":true
  }
}
```

---

## Signature scheme

- **Algorithm:** Ed25519 (RFC 8032). Deterministic; no nonce involved.
- **Input:** The canonical bytes as defined above.
- **Output:** 64-byte Ed25519 signature, base64url-encoded (no padding)
  when transported as JSON.
- **Verification:** `crypto.verify(null, canonicalBytes, publicKey, signature)`
  in Node.js. Equivalent in any Ed25519-capable language.

---

## Hash scheme

- **`evidenceHash`** is SHA-256 of the original event content (the
  data structure produced by the source system prior to canonical
  signing). The exact content layout is source-system-specific; the
  hash anchors the record's identity in the proof chain.
- **`proofChainHash`** is SHA-256 of the *previous* record's canonical
  bytes. Empty string for the first record in a chain.
- Both hashes are 64-character lowercase hex strings.

---

## Common pitfalls when reimplementing the canonical builder

These are the bug classes that have shown up in real signer/verifier
implementations:

| Pitfall | Symptom | Fix |
|---|---|---|
| Promoting the redacted kid (`strix-***-YYYY-MM`) from a public-API response into the canonical bytes | Every signed record returns `SIGNATURE_INVALID`. | Use `fields.signingKeyId` (full kid) from the structured response, not the top-level `signingKeyId` (display-only redacted form). |
| Storing `createdAt` in a `timestamp without time zone` column and re-canonicalizing from the Date | Two-millisecond TZ drift; every record fails. | Store the canonical Z-suffixed string verbatim in a text column; never re-canonicalize from a Date. |
| Using `JSON.stringify` directly | Field-order non-determinism across engines. | Hand-written serializer that emits fields in the locked order. |
| Eliding `null` from `regulatoryContext.complianceMode` | Canonical bytes differ from signer; `SIGNATURE_INVALID`. | Always emit `"complianceMode":null` — never strip. |
| Trusting `Date.parse` instead of strict RFC 3339 validation | Permissive parser accepts malformed timestamps that downstream verifiers reject. | Use a strict RFC 3339 validator (the verifier's `isStrictRfc3339` helper is one reference implementation). |
| Field-order drift between signer and verifier across services | Verifier reconstruction produces different bytes. | Mirror the canonical builder byte-for-byte across every service that signs or verifies. The internal mirror-file contract pins this. |

---

## Versioning

- This document is `schemaVersion: 1`.
- A future v2 will ship side-by-side with v1, not as a hard cutover.
  The verifier's CLI will accept both versions transparently; clients
  reimplementing the canonical builder will need to support both
  during the migration window.
- The migration window for any schema change is **at least 12 months**
  to give external auditors and integrators time to update.
