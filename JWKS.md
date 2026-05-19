# JWKS Public Contract

The Strix JWKS (JSON Web Key Set) is the **only trust anchor** the
public verifier depends on. Everything in this document is a stable
public contract — changes ship with version bumps and migration windows,
never silent flips.

---

## Canonical endpoint

```
GET https://www.strixgov.com/.well-known/strix-jwks.json
```

- **RFC 7517** compliant.
- Content type: `application/json`.
- Cache control: `public, max-age=30, s-maxage=60`. Deliberately short
  so revocations and new keys propagate within a minute.
- **No `immutable` directive.** The JWKS is append-only in practice, but
  revocations and metadata refreshes do occur; `immutable` would block
  them.

A legacy alias `/api/jwks` exists for backward compatibility. It returns
the byte-identical response under all conditions. New consumers should
use `/.well-known/strix-jwks.json`.

---

## Response shape

```json
{
  "keys": [
    {
      "kid": "strix-prod-2026-05",
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "<44-char base64url>",
      "use": "sig",
      "alg": "EdDSA"
    },
    {
      "kid": "strix-prod-2026-04",
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "<44-char base64url>",
      "use": "sig",
      "alg": "EdDSA"
    }
  ],
  "_meta": {
    "schemaVersion": 1,
    "contractVersion": 2,
    "algorithm": "EdDSA",
    "curve": "Ed25519",
    "keyCount": 2,
    "servedAt": "<ISO 8601 timestamp>",
    "retentionPolicy": "minimum-24-months",
    "namespaces": {
      "platform": "strix-<env>-<YYYY-MM>",
      "agent": "agent-<agentId>-<YYYY-MM>"
    }
  }
}
```

The `_meta` block carries machine-readable annotations alongside the
`keys` array. Field semantics:

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | integer | Internal `_meta` schema. Independent of `contractVersion`. |
| `contractVersion` | integer | The public-verifier-facing contract. Today: `2`. Bumping this is a breaking change for consumers. |
| `algorithm` | string | Signature algorithm declared by all keys in this response. Today always `"EdDSA"`. |
| `curve` | string | Curve declared by all keys. Today always `"Ed25519"`. |
| `keyCount` | integer | Equal to `keys.length`. Convenience field; consumers MUST still read `keys[]` directly. |
| `servedAt` | string | ISO 8601 timestamp the endpoint produced this response. Display + telemetry only — not part of the signed-bytes path. |
| `retentionPolicy` | string | Machine-readable retention class. Today `"minimum-24-months"`, mirroring the human-readable framing below. |
| `namespaces` | object | Pattern-string-per-namespace map. Maps a namespace name (e.g. `"platform"`) to the kid pattern its keys follow. Adding a new namespace is additive within `contractVersion: 2`. |

Required HTTP response headers:

- `X-Strix-Contract-Version: 2`
- `Content-Type: application/json`

---

## Key identifier (kid) format

| Form | Pattern | Purpose |
|---|---|---|
| Platform key (full) | `strix-{env}-{YYYY-MM}` | The bytes that were signed over. Always present in `fields.signingKeyId` of a signed evidence record. |
| Platform key (redacted) | `strix-***-{YYYY-MM}` | Display-only form returned at the top level of `/api/proof/<id>` responses. Scrubs the environment segment to avoid leaking deployment context to unauthenticated callers. **MUST NOT be used for signature verification.** |
| Agent key (AA-1, reserved namespace) | `agent-{agentId}-{YYYY-MM}` | Reserved kid pattern for the future Actor Attestation v1 rollout. The `agentId` segment is the registered agent identifier (not a tenant slug). No keys in this namespace are active in production today; the JWKS declares the pattern via `_meta.namespaces.agent` so consumers can prepare resolver logic ahead of the activation. |

The verifier's `resolveJwksByKid()` helper handles both full and redacted
forms by suffix-matching the `{YYYY-MM}` segment. Multiple JWKs sharing
the same kid is supported (a legitimate kid collision arises during
cross-environment key rotation); the verifier tries each candidate
before declaring `SIGNATURE_INVALID`.

---

## Retention policy

| Class | Retention | Why |
|---|---|---|
| Active production key (current month) | Indefinite while in use. | Active signing. |
| Retired production key | **Minimum 2 years** from retirement date. | EU AI Act Article 12 (technical documentation) + Article 28 (provider obligations). Records signed under a retired key must remain independently verifiable for that window. |
| Test / development key | Not part of the public JWKS. | Test keys live in a separate test JWKS (e.g. `examples/test-jwks.json` in this package). |

After the 2-year retention window, retired keys MAY be removed from the
JWKS. If you operate on records older than 2 years, snapshot the JWKS
locally — the verifier supports verifying against a local JWKS file
(see the `receipt`/`chain` subcommands).

---

## Rotation protocol

When Strix rotates its signing key (typically monthly):

1. The new keypair is generated and the **public** half is added to the
   JWKS first. There is now a window where the JWKS contains both
   `strix-prod-2026-04` and `strix-prod-2026-05`.
2. The signer's private key is updated to the new value.
3. New records sign with the new kid. Records signed under the prior
   kid remain verifiable because the prior public key is still in the
   JWKS.
4. After at least 2 years (retention minimum), the retired public key
   may be removed.

The verifier handles rotation transparently — it looks up whichever kid
the record claims. No client-side coordination is required.

---

## Stability guarantees

These are **public contract** guarantees, not implementation details:

- **No kid reuse.** Once a kid string has appeared in the public JWKS,
  the same string will never refer to a different keypair. Period.
- **Append-only kids within a contract version.** New kids are added;
  retired kids are removed only after the retention window. The
  ordering of `keys[]` is not guaranteed; consumers must look up by kid.
- **No breaking schema change inside `_meta.contractVersion: 2`.** Adding
  new fields to `_meta` (or new entries to `_meta.namespaces`) is
  additive and explicitly allowed. Changing the type of an existing
  `_meta` field, removing a field, or changing the semantics of an
  existing kid pattern requires a `contractVersion` bump and a
  migration window.
- **Mirror parity.** Any official Strix-hosted mirror of the JWKS
  (e.g., `app.academytn.com/.well-known/strix-jwks.json`) returns the
  byte-identical response. Cross-mirror drift is a bug, not a feature.

---

## Verifier behavior on JWKS errors

| Condition | Verifier output | Exit code |
|---|---|---|
| JWKS endpoint unreachable | `Network error fetching <url>: <cause>` | 2 |
| JWKS returns HTTP 5xx | `JWKS fetch failed: HTTP <status>` | 2 |
| JWKS returns malformed JSON | `Failed to parse JWKS response` | 2 |
| Kid not found in JWKS | `Key not found in JWKS: <kid>` | 2 |
| Signature does not verify against the resolved key | `SIGNATURE_INVALID` | 1 |

The verifier **does not silently fall back** to a cached JWKS, a
hardcoded key, or any other source if the live JWKS is unreachable. If
you need offline verification, snapshot the JWKS yourself and supply it
via `--jwks <local-path>`.

---

## What this contract does NOT cover

- The **private** key. The private key is never published; verification
  uses the public half only.
- The **rotation cadence**. We rotate at least monthly; this is policy,
  not contract. Consumers should not key off the rotation cadence.
- The **production deployment topology**. The JWKS is the trust surface;
  how it's served (CDN, edge, origin) is an implementation detail.
- **Revocation list distribution.** A signed revocation list surface is
  on the roadmap (related to the offline-bundle work) but is not yet
  part of this public contract. Until it ships, retired kids remain in
  the JWKS for the full 2-year retention window without negative
  signaling.
