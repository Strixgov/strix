# @strixgov/mcp-token-validator

**Drop-in validator for Strix `execution_authorization_v1` tokens. Enforces Mode 3 — Capability-Enforced — governance at any downstream MCP server, network proxy, or credential-broker wrap. Zero Strix runtime dependency.**

```sh
npm install @strixgov/mcp-token-validator
```

This package is the **enforcement half** of Strix Mode 3. The Strix mcp-adapter mints
short-lived, single-use Ed25519-signed authorization tokens; this validator verifies
them at the action site so the side effect refuses to execute without a genuine token.

The validator has **no Strix dependency, no network calls, no HTTP**. It uses only
`node:crypto` plus a vendored reference implementation of Strix Canonical JSON v1
(SCJ v1) and strict RFC 3339. Customers verifying Strix tokens never need to trust
a Strix-published service to be up, honest, or reachable.

## What it's for

Strix categorises MCP enforcement into three modes
([full framing](https://github.com/Strixgov/strix/tree/main/docs/strategy/mcp-mode-ladder-v1.md)):

| Mode | What Strix proves | Where this package fits |
|---|---|---|
| **1 — Observed** | Every governed call produces a signed receipt verifiable against the public JWKS. | — |
| **2 — Approval-Gated** | HIGH / CRITICAL actions are held at the action boundary until a known approver releases them. | — |
| **3 — Capability-Enforced** | The downstream tool refuses sensitive actions unless a valid Strix execution authorization is present. | **This package — the validator the downstream calls.** |

The Mode 3 claim depends on a deployment posture that requires the token *at the
action site*. There are three known postures:

- **Posture A — credential-broker:** the Strix mcp-adapter is the sole holder of
  downstream API credentials; the adapter validates its own tokens in-process.
- **Posture B — network egress gating:** a Strix-operated proxy is the only path
  from agent network segments to downstream APIs; the proxy validates the
  `Strix-Execution-Authorization` header on every request.
- **Posture C — first-party MCP token validation:** the customer's own MCP server
  is modified to validate Strix authorizations on tools they want governed. This
  is the most common starting point.

Postures A and C use the object-form API (`validateAuthorization`); Posture B uses
the header-form (`validateAuthorizationFromHeader`). The crypto is identical.

Full architecture: [`docs/architecture/mcp-mode-3-enforcement-v1.md`](https://github.com/Strixgov/strix/tree/main/docs/architecture/mcp-mode-3-enforcement-v1.md).

## NSA MCP report alignment

NSA Cybersecurity Information [`U/OO/6030316-26 | PP-26-1834 | May 2026 Ver. 1.0`](https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/4192261/nsa-releases-cybersecurity-information-on-security-considerations-for-the-model/)
calls out authorization gaps in current MCP deployments — per-call
admission decisions are implementer-defined, and many MCP servers run
without a deny-by-default posture at the action site. This validator is
the **enforcement half** that lets a downstream MCP server, network
proxy, or credential-broker refuse a sensitive action unless a valid
Strix execution authorization is present. It uses only `node:crypto`
plus a vendored reference implementation of Strix Canonical JSON v1
and strict RFC 3339 — zero Strix dependency, no network calls, no HTTP.
Customers verifying Strix tokens never need to trust a Strix-published
service to be up, honest, or reachable. The durable map from each
NSA-named concern to the file + invariant that addresses it lives at
[`docs/launch/2026-05-23-nsa-mcp-technical-companion.md`](https://github.com/Strixgov/strix/blob/main/docs/launch/2026-05-23-nsa-mcp-technical-companion.md).

## 5-minute integration (Posture C — first-party MCP)

```js
import { validateAuthorization } from "@strixgov/mcp-token-validator";

// 1. Fetch and cache the JWKS at startup. In production this should pin to
//    a Strix-curated source (e.g. https://well-known.strixgov.com/strix-jwks.json)
//    OR a JWKS the customer themselves manages and curates.
const jwks = await fetch("https://well-known.strixgov.com/strix-jwks.json").then(r => r.json());

// 2. In every tool handler that should be Strix-required, validate before acting.
async function handleNotionUpdatePage(request) {
  const token = request.params._meta?.strix_authorization;
  const result = await validateAuthorization(token, {
    jwks,
    expectedTenantId: "acme-corp",
    expectedEnvironment: "prod",
    burnNonce: async (nonce) => {
      // Atomic single-use enforcement against your durable store.
      // The contract: return true iff this nonce was burned AND was
      // not previously burned. Anything else → false.
      try {
        await db.run("INSERT INTO strix_burned_nonces(nonce) VALUES(?)", [nonce]);
        return true;
      } catch (e) {
        if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return false;
        throw e;
      }
    },
  });
  if (!result.ok) {
    throw new McpError("STRIX_AUTHORIZATION_INVALID", { reason: result.reason });
  }
  // Token is valid + burned. Proceed with the real side effect.
  return await reallyUpdatePage(request.params);
}
```

## API

### `validateAuthorization(token, opts)`

**`token`** — the parsed `execution_authorization_v1` object as the mcp-adapter
emits it (the 11-field canonical payload plus `signingKeyId` and `signature`).

**`opts`**:

| Field | Type | Description |
|-------|------|-------------|
| `jwks` | `{ keys: JsonWebKey[] }` | Required. The JWKS the validator resolves `signingKeyId` against. Must contain Ed25519 OKP keys. |
| `burnNonce` | `(nonce: string) => Promise<boolean>` | Required. Atomic single-use enforcer. Return `true` iff the nonce was successfully burned and was not previously burned. |
| `expectedTenantId` | `string` | Optional. When set, must equal `token.tenantId` or validation fails with `TENANT_MISMATCH`. |
| `expectedEnvironment` | `string` | Optional. When set, must equal `token.environment` or validation fails with `ENVIRONMENT_MISMATCH`. |
| `expectedActorClass` | `string` | Optional. When set, must equal `token.actorClass` or validation fails with `ACTOR_CLASS_MISMATCH`. |
| `now` | `() => number` | Optional. Override for `Date.now()`. Test-only. |

**Returns** `Promise<ValidationResult>`:

```ts
type ValidationResult =
  | {
      ok: true;
      authorizationId: string;
      actorId: string;
      capabilityId: string;
      payloadHash: string;
      expiresAt: string;
    }
  | { ok: false; reason: ValidationReason; error?: string };
```

### `validateAuthorizationFromHeader(headerValue, opts)`

Same `opts`. The `headerValue` is the raw `Strix-Execution-Authorization`
HTTP header value in the wire format
`<base64url(canonical-json-payload)>.<base64url(signature)>`.

The header form additionally asserts that the on-wire bytes are
byte-equal to the SCJ v1 reserialization of the parsed payload. This
defends against the attack class where an attacker submits semantically
equal JSON with different bytes — the canonical form would produce the
same hash and the signature would verify against it, but the on-wire
bytes the verifier compared against would never have matched.

## Stable validation-reason strings

Validation runs rules in declared order; the first failure returns its
reason and later rules do not run. **Adding a reason is additive;
renaming or removing one is a breaking change** — these strings are the
public contract that downstream audit, alerting, and proxy responses
key off.

| Reason | When |
|---|---|
| `TOKEN_MALFORMED` | Required field missing; opts malformed; timestamp not strict RFC 3339; expiresAt before issuedAt |
| `CANONICALIZATION_DRIFT` | On-wire payload bytes don't match SCJ v1 reserialization (header form only); canonicalizer rejection (e.g. NaN value) |
| `SCHEMA_VERSION_UNSUPPORTED` | `schemaVersion` not in the supported set (currently just `1`) |
| `KEY_NOT_FOUND` | `signingKeyId` missing or absent from the provided JWKS |
| `KEY_NOT_ATTESTED` | *Reserved for v0.2.0* (operational-key attestation chain) — see "What v0.1.0 does NOT yet check" |
| `KEY_REVOKED` | *Reserved for v0.2.0* (signed-revocation-list check) — see "What v0.1.0 does NOT yet check" |
| `SIGNATURE_INVALID` | Ed25519 signature verification returned false; missing signature; non-base64url signature; JWK isn't Ed25519 OKP |
| `EXPIRED` | `now >= expiresAt` |
| `TENANT_MISMATCH` | `opts.expectedTenantId` provided and differs from `token.tenantId` |
| `ENVIRONMENT_MISMATCH` | `opts.expectedEnvironment` provided and differs from `token.environment` |
| `ACTOR_CLASS_MISMATCH` | `opts.expectedActorClass` provided and differs from `token.actorClass` |
| `NONCE_REUSED` | `burnNonce` returned non-true; `burnNonce` threw (fail-closed) |

### Rule ordering matters (audit distinguishability)

`NONCE_REUSED` is intentionally the **last** rule. A token that was good
but already used (replay attempt) gets that reason; a token that was
never good (forgery / tamper) fails earlier with a more specific
reason. The distinction matters for incident response.

## `burnNonce` contract

The validator is otherwise pure — given a token and JWKS, it verifies.
The single thing it cannot do alone is enforce single-use, because that
requires durable state in the customer's deployment.

Implement `burnNonce` against your durable store. Three sketches:

- **SQL** — `INSERT INTO strix_burned_nonces(nonce, ts) VALUES (?, NOW())`
  with a UNIQUE constraint on `nonce`. INSERT succeeds → `true`; UNIQUE
  violation → `false`. A cleanup job purges rows past `expiresAt + retention`.
- **Redis** — `SET strix:nonce:<nonce> 1 EX <ttl> NX`. `OK` reply → `true`,
  nil reply → `false`. `NX` makes it atomic; TTL handles cleanup.
- **In-memory** — acceptable only for single-process deployments
  (CLI tools, single-node MCPs). Multi-process deployments must share
  state; otherwise nonces are not actually single-use.

If `burnNonce` throws, the validator returns `NONCE_REUSED`. There is
no "couldn't check, so allowed" path.

## What v0.1.0 does NOT yet check

Two rules from
[`mcp-mode-3-enforcement-v1.md §8`](https://github.com/Strixgov/strix/tree/main/docs/architecture/mcp-mode-3-enforcement-v1.md)
are explicitly deferred to v0.2.0:

- `KEY_NOT_ATTESTED` — operational-key attestation chain to a pinned
  root via OB-1.
- `KEY_REVOKED` — signed-revocation-list check.

In v0.1.0 the JWKS the caller passes in IS the trust boundary. If the
JWKS comes from a Strix-curated source (e.g.
`well-known.strixgov.com`), attestation and revocation are enforced
upstream by Strix removing unattested / revoked keys from the JWKS.

If the caller self-hosts the JWKS or pulls from an untrusted source,
the caller is responsible for curating it. v0.2.0 will add pluggable
`isKeyAttested` and `isKeyRevoked` callbacks so callers can layer
additional trust-root enforcement on top.

This is documented as a deliberate phasing, not a gap that will be
papered over. The reason strings are reserved in `VALIDATION_REASONS`
so callers can pre-handle them today; in v0.2.0 the validator will
start emitting them when the corresponding callbacks reject.

## Test surface

50 tests under `node --test`:

- `test/happy-path.test.mjs` — full mint → validate → burn → replay cycle.
- `test/reason-codes.test.mjs` — every stable reason string is forced and asserted, including the two rule-ordering invariants.
- `test/canonical-json-parity.test.mjs` — locked SCJ v1 golden vectors so the vendored canonicalizer cannot drift from solo-builder-core.
- `test/header-transport.test.mjs` — Posture B wire format, including the byte-equality defence against same-JSON-different-bytes attacks.

Run `npm test` (or `node --test test/*.test.mjs`).

## License

MIT — see [LICENSE](./LICENSE). The validator is part of the open trust
path; you can use, modify, and redistribute it under MIT without any
Strix commercial license.

The Mode 3 *issuance* side (`@strixgov/mcp-adapter` and the
forthcoming `mode: "enforced"` option) is source-available under
Elastic License 2.0 — see that package for terms.
