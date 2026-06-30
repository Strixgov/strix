# Signed Evidence v1 — Conformance Vectors

`se-v1-conformance-vectors.json` is the **language-neutral conformance
contract** for Strix Signed Evidence v1. It is the artifact that lets anyone —
a customer's security team, an auditor, a regulator, a competitor — write or
run an independent verifier and confirm it agrees with ours, byte-for-byte,
without trusting any Strix code.

## What's in it

```
publicJwk            Ed25519 public key (OKP) the signatures verify against
signingKeySeedHex    deterministic seed for the key (lets you re-derive + re-sign)
vectors[]            one per canonical form:
  name               console-form | academy-form | signed-payload-passthrough
  inputRecord        the raw evidence record fields a verifier receives
  expectedCanonical  the EXACT bytes that were signed (what you must reproduce)
  expectedSha256     sha256(expectedCanonical)
  signatureB64url    Ed25519 signature over expectedCanonical (base64url)
```

## The contract (what an independent verifier MUST do)

For each vector:

1. Reconstruct the canonical bytes from `inputRecord` and assert they equal
   `expectedCanonical`, **byte-for-byte**.
2. Assert `sha256(canonical) == expectedSha256`.
3. Verify `signatureB64url` against `publicJwk` over the canonical bytes.
4. Confirm a one-byte tamper **fails** verification.

If your implementation passes all three vectors, it is conformant with the
Strix SE v1 reference.

## The load-bearing detail: the dual-form discriminator

SE v1 has two byte-shapes that verify against **different** signatures:

| | `schemaVersion` / `evidenceId` | `regulatoryContext` key order |
|---|---|---|
| **Console** (default) | JSON **strings** | `complianceMode` first |
| **Academy** (`sourceApp == "academy-platform"`) | JSON **numbers** | `euAiActArticle12` first |

Collapsing the two into one form silently breaks every record signed in the
dropped form (4,450+ historical Academy records). Any conformant verifier must
reproduce **both**. A third byte-rule: serialize with compact separators
(`,` / `:`), no whitespace, and emit raw UTF-8 (do not `\u`-escape non-ASCII).

The `signed-payload-passthrough` vector covers the reconstruction-free path: if
a record carries `signedPayload` (the original signed bytes), that string *is*
the canonical — return it verbatim.

## Who reads this fixture today

- **JavaScript reference:** `../se-v1-conformance-fixture.test.mjs`
- **Python (`strix-verify`):** reads the same fixture from its conformance test suite (in the upstream Strix monorepo).

Both read this one file and must agree. That is what makes "two independent
implementations verify the same signed evidence against the same contract" a
*tested* statement rather than a claim.

## Regenerating

The fixture is generated from the JS reference verifier and is transitively
locked by `../se-v1-golden-vectors.test.mjs` (so it cannot drift from the
locked goldens without that test failing first):

```
node generate.mjs
```

Do **not** hand-edit the JSON. If a value here ever needs to change, that is a
canonical-serialization change — an SE v2 / gate-review event per ADR 002
(`docs/architecture/decisions/002-signed-evidence-schema-freeze.md`), not a
fixture edit.
