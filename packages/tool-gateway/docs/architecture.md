# Architecture — @strixgov/tool-gateway

The gateway is a single-process inline admission point between an AI
agent and an execution surface. It owns three things: classification,
policy, and proof.

```
┌────────┐   1.invoke    ┌─────────────────────────┐   6.execute    ┌──────────┐
│ Agent  │──────────────▶│  @strixgov/tool-gateway │───────────────▶│   Tool   │
│ (LLM,  │   8.result    │                         │   7.result     │ (fs/sh/  │
│  MCP)  │◀──────────────│   ┌──────────────────┐  │◀───────────────│  MCP/...)│
└────────┘               │   │ classify(tool)   │  │                └──────────┘
                         │   │ evaluate(policy) │  │
                         │   │ approve()? (TTY) │  │
                         │   │ issueReceipt()   │  │
                         │   │ append(chain)    │  │
                         │   └──────────────────┘  │
                         └────────────┬────────────┘
                                      │
                              5.append signed
                                receipt
                                      ▼
                         ┌─────────────────────────┐
                         │ ~/.strix-gateway/       │
                         │   receipts.jsonl        │
                         │   keys/signing-key.pem  │
                         │   keys/public-jwk.json  │
                         │   policy.json           │
                         └─────────────────────────┘
```

## Execution flow (`Gateway.execute`)

Order is load-bearing. The implementation in `src/gateway.mjs` follows
this sequence and CI tests assert it.

1. **Validate** — `invocation.capabilityId` is a string; `executor` is
   a function. Anything else throws synchronously (programmer error).
2. **Classify** — look up the registered `ToolCapability` for
   `invocation.capabilityId`. Unknown capabilities synthesize a
   CRITICAL EXECUTE placeholder so we can still mint a denial receipt.
3. **Evaluate policy** — `PolicyEngine.evaluate(invocation)` returns
   `{ decision, matchedRule, reason }`. Lookup order:
   - exact rule for `cap.id`
   - longest matching prefix rule (`filesystem.*`)
   - `riskOverrides[cap.risk]`
   - `ruleset.default`
   - `DENY` (fail-closed)
4. **Approve if needed** — if `decision === APPROVAL_REQUIRED` and the
   gateway is configured for interactive approval, call
   `approval.prompt(cap, invocation, { timeoutMs })`. Timeout, EOF,
   non-TTY stdin, and prompt errors all resolve as `DENY`. The result
   becomes the `finalDecision`.
5. **Acquire chain mutex → mint → append** — under a per-instance
   serializing promise:
   - read `storage.lastReceipt()` to get `previousChainHash`
   - call `issueReceipt({ ... })` which signs the canonical payload
   - `storage.appendReceipt(receipt)`
6. **Execute (only if `ALLOW`)** — `executor(invocation.args)`. An
   executor exception is caught and surfaced as `{ ok:false, decision:
   "ALLOW", error: { code:"EXECUTOR_ERROR" } }` — the receipt has
   already been written, so the audit trail records the attempt.

A denied invocation returns `{ ok:false, decision:"DENY", receipt }`
without invoking the executor.

## Proof chain

The chain is a hash-linked list of receipts. Each link binds the
previous link's `proofChainHash` into its own:

```
evidenceHash    = sha256(invocationHash || decision || timestamp)
proofChainHash  = sha256(prevProofChainHash || evidenceHash)
signature       = ed25519(canonicalReceiptPayload(receipt))
```

Genesis chain hash is `0x00…00` (64 hex zeros).

`gateway.verifyChain()` walks the JSONL and re-derives each link's
`proofChainHash`, returning `{ valid:false, brokenAt:<receiptId> }` on
the first divergence. It does NOT verify Ed25519 signatures — that is
the verifier's job, and it can run from a separate machine on a copy
of `receipts.jsonl` plus the public JWKS.

Tamper resistance properties:

- changing `evidenceHash`, `decision`, `timestamp`, or `args` in any
  receipt produces a different `proofChainHash` for that record AND
  for every subsequent record → `verifyChain` fails at the modified
  link
- changing the `signature` while leaving the canonical payload alone
  → `verifyReceipt` fails for that record
- inserting a new receipt mid-chain → impossible without forging an
  Ed25519 signature with the gateway's private key

## Canonical payload

Two locked schema versions live in `src/canonical.mjs`. The current
serializer dispatches on `r.schemaVersion`.

**v1 (frozen — pre-v0.1.1, 11 fields):**
```
schemaVersion → receiptId → capabilityId → action → decision
→ risk → mode → invocationHash → evidenceHash → proofChainHash
→ timestamp
```

**v2 (current — v0.1.1+, 14 fields):**
```
schemaVersion → receiptId → capabilityId → action → decision
→ risk → mode → policyVersion → tenantId → environment
→ invocationHash → evidenceHash → proofChainHash → timestamp
```

`canonicalReceiptPayload(r)` returns a deterministic byte string with:
- keys in the exact order for `r.schemaVersion`
- `JSON.stringify` for each value (no whitespace, no trailing comma)
- no extra fields, no defaults inserted

v1 receipts on disk continue to verify forever — the field order is
permanent. New receipts always use v2; the `policyVersion` /
`tenantId` / `environment` fields close the audit gaps surfaced in the
360 review (April 2026): which policy was in force, which tenant
issued the receipt, which environment was active.

The verifier (`@strixgov/verifier` ≥ 1.5.0) reconstructs the same byte
string from a stored receipt before checking the signature. Any drift
between the gateway's serializer and the verifier's serializer breaks
every previously-issued signature, so both serializers are pinned by a
cross-package parity test (`test/verifier-parity.test.mjs`).

## Policy versioning

`PolicyEngine.version` is `sha256(canonicalJSON({ rules, riskOverrides,
default }))` — a content-addressable hash. The Gateway binds this hash
into every receipt's canonical payload at issuance time. Properties:

- two semantically-equal rulesets (same rules, defaults, overrides —
  any key insertion order) produce the same version
- changing any decision rotates the version
- editorial metadata (description, owner) does NOT affect the version
- `Gateway.setPolicy()` rotates the version; subsequent receipts carry
  the new value, prior receipts retain the old one

This closes the "which policy was active?" audit gap end-to-end with
no out-of-band coordination required.

## Observability

`Gateway` extends `EventEmitter`. Four events are emitted in order:

| Event      | When | Listener payload |
|------------|------|------------------|
| `decision` | After `PolicyEngine.evaluate`, before approval prompt | `{ evaluation, invocation }` |
| `receipt`  | After `storage.appendReceipt` (always, regardless of decision) | `Receipt` |
| `denial`   | When `finalDecision === "DENY"` (policy or hardfail) | `{ receipt, evaluation?, approval?, hardfail? }` |
| `error`    | When the executor throws on an `ALLOW` path | `{ receipt, err, invocation }` |

Listener errors are caught and dropped (`Gateway._safeEmit`) so a
buggy observer cannot poison the receipt-issuance flow. The `error`
event has a no-op default handler so it does not crash the process if
nothing else is listening.

## Headless approval — `fileApprover`

For environments without a TTY (CI, containers, server-side agents),
`fileApprover` implements a file-watcher protocol:

```
1. fileApprover writes <requestDir>/<requestId>.request.json (mode 0600)
2. an out-of-band channel (Slack bot, GitHub Action, sign-off form)
   reads the request and writes <requestDir>/<requestId>.response.json
3. fileApprover polls for the response file
4. the response is parsed; only { approved: true } counts as approval
5. both files are deleted before fileApprover returns
```

Default-deny applies at every failure point:

- timeout (no response file written within `timeoutMs`) → `TIMEOUT`
- malformed JSON in response → `PROMPT_FAILED`
- response without `approved === true` (any other value, including
  `"yes"`, `1`, `null`) → `USER_DENIED`
- IO error writing the request → `PROMPT_FAILED`

## Storage

Default driver is `JsonlStorage` writing to
`~/.strix-gateway/receipts.jsonl` (mode 0600). Append-only; reads
parse the whole file (acceptable for a developer tool — the chain
should not exceed a few thousand entries between rotations).

Concurrency: `appendReceipt` and `Gateway.execute` each take a
per-instance promise-chain mutex so two concurrent invocations cannot
observe the same `lastReceipt()` and produce a forked chain.

`MemoryStorage` is provided for tests only. It is unsafe for
production because receipts vanish on process exit.

## Key management

Ed25519 keypair, persisted under `~/.strix-gateway/keys/`:

- `signing-key.pem` — PKCS8 PEM, mode 0600, private bytes
- `public-jwk.json` — published JWK with `kid`, `kty:OKP`, `crv:Ed25519`, `x` (raw 32-byte public key, base64url)

`kid` format: `local-{YYYY-MM}` — distinguishes a developer's local
gateway from a hosted Strix kernel (`strix-prod-{YYYY-MM}`,
`strix-dev-{YYYY-MM}`, etc) at a glance.

Rotation: copy the old key out of band, regenerate (`rm
~/.strix-gateway/keys && strix-gateway init`). Old receipts remain
verifiable with the old JWK; new receipts use the new key. A future
`strix-gateway keys rotate` will automate this.

## Adapter contract

An adapter is any module that translates a domain API (`fs.readFile`,
`mcp.callTool`, ...) into `gateway.execute` calls. The contract:

1. Register every capability the adapter exposes via
   `gateway.registerCapability(cap)`. This is what gives the
   PolicyEngine ground truth for risk and mode.
2. Convert the domain call into a `ToolInvocation`:
   `{ capabilityId, action, args, actorId?, actorRole? }`.
3. Pass an executor closure that performs the underlying work only
   if the gateway returns `{ ok:true }`.

Adapters MUST NOT cache decisions across invocations. Every call is a
fresh evaluation (invariant #2).

## Verifier wire contract

A receipt is verifiable by any party that has:

1. The receipt JSON (from `receipts.jsonl` or `strix-gateway receipts get <id>`)
2. The signing JWKS (from `strix-gateway keys jwks`)

Verifier flow:

```
input  = receipt JSON, JWKS
1. resolve JWK by receipt.signingKeyId (exact or YYYY-MM suffix match)
2. JWK.x (base64url, 32 bytes) → SPKI DER → KeyObject
3. canonical = buildReceiptCanonicalPayload(receipt)   // 11 fields, locked order
4. ed25519.verify(KeyObject, canonical bytes, base64url(receipt.signature))
output = VERIFIED | TAMPERED | UNSIGNED | ERROR
```

This is exactly what `@strixgov/verifier receipt <file>` does. The
gateway and verifier MUST stay byte-compatible on the canonical
serialization; tests in both packages anchor that.
