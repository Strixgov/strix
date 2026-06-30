# @strixgov/sdk

**Governed execution infrastructure — fail-closed enforcement of irreversible actions via cryptographically signed decision tokens.**

Applications do not directly execute state-changing operations. They redeem signed decision tokens issued by a governance policy engine. The SDK enforces this invariant at the application boundary — for AI agents, autonomous workflows, enterprise systems, or any code where "undo" is expensive or impossible.

## Installation

```bash
npm install @strixgov/sdk
```

## The 5 Architectural Pillars

| Pillar | Description |
| :--- | :--- |
| **Token Standard** | Strix Decision Token (SDT) — Ed25519 signed, single-use, with standardized claims |
| **SDK Ergonomics** | `governedAction()` wrapper that feels native to tRPC/Express developers |
| **Engine Independence** | Works with local (air-gapped), remote (Strix console), or custom policy engines |
| **Immutable Evidence** | Every execution (or block) generates a tamper-evident `ExecutionRecord` with SHA-256 hash |
| **Fail-Closed Invariant** | No token → no execution. No exceptions. |

## Quick Start

Before the code below works, you need an Ed25519 signing keypair. The SDK
expects `STRIX_SIGNING_KEY` as a base64-encoded PKCS8 private key. The
fastest way:

```bash
# Generate a fresh keypair, base64-encode the private half, set as env var
node -e "
  const c = require('node:crypto');
  const { privateKey, publicKey } = c.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const pubJwk = c.createPublicKey(privateKey).export({ format: 'jwk' });
  console.log('STRIX_SIGNING_KEY=' + priv);
  console.log('STRIX_PUBLIC_JWK=' + JSON.stringify({ ...pubJwk, kid: 'strix-sdk-local', use: 'sig', alg: 'EdDSA' }));
" > strix-keys.env
# Source it into your shell:
set -a; source strix-keys.env; set +a
# Or on Windows PowerShell:
# Get-Content strix-keys.env | ForEach-Object { $k,$v = $_ -split '=',2; [Environment]::SetEnvironmentVariable($k, $v, 'User') }
```

The public-JWK half is what `@strixgov/verifier` needs to verify records
later — save it as `./public-jwks.json` per the [Verifying what you
produced](#verifying-what-you-produced) section.

```typescript
import { StrixGovernance, LocalPolicyEngine } from '@strixgov/sdk';

const strix = new StrixGovernance({
  policyEngine: {
    type: "custom",
    engine: new LocalPolicyEngine({
      capabilities: [{
        capabilityId: "app.resource.delete",
        riskLevel: "critical",
        allowedEnvironments: ["development", "production"],
        approvalsRequired: 0,
        irreversible: true,
      }],
      signingKey: process.env.STRIX_SIGNING_KEY!,
    }),
  },
  evidenceSink: { type: "file", path: "./evidence/audit.jsonl" },
  verificationKey: process.env.STRIX_PUBLIC_KEY!,
});
```

## Governed Actions

Wrap any irreversible handler with `governedAction()`:

```typescript
const deleteResource = strix.governedAction({
  capability: "app.resource.delete"
}, async (input: { id: number }, ctx) => {
  await db.delete(resources).where(eq(resources.id, input.id));
  return { deleted: input.id };
});

// Step 1: Request a decision (issues an SDT if approved by policy)
const decision = await strix.requestDecision({
  capabilityId: "app.resource.delete",
  actorId: "usr_123",
});

// Step 2: Execute with the token (fails without a valid token)
await deleteResource({ id: 42 }, {
  token: decision.token!,
  actorId: "usr_123",
});
```

### High-risk action with 2-of-N approval

The canonical case for sensitive actions: classify the capability HIGH or
CRITICAL with `approvalsRequired >= 1`, and the policy engine returns
`INTERCEPT` instead of `ALLOW`. The action is held until approvers sign
off (out-of-band via your approval workflow); only then does
`requestDecision` return an issued token.

```typescript
const engine = new LocalPolicyEngine({
  capabilities: [{
    capabilityId: "payments.wire.send",
    riskLevel: "critical",
    allowedEnvironments: ["production"],
    approvalsRequired: 2,                  // two distinct approvers
    irreversible: true,
  }],
  signingKey: process.env.STRIX_SIGNING_KEY!,
});

const decision = await strix.requestDecision({
  capabilityId: "payments.wire.send",
  actorId: "agent-treasury",
});

// decision.status === "INTERCEPT"  → no token, awaiting approval
// decision.status === "ALLOW"      → token issued, ready to execute
// decision.status === "DENY"       → blocked by policy
```

### Error handling — `GovernanceBlockedError`

Every failure path throws a `GovernanceBlockedError` with a specific
`reason`. Wrap every governed call in a try/catch and treat the reason
as the audit signal:

```typescript
import { GovernanceBlockedError } from "@strixgov/sdk";

try {
  await deleteResource({ id: 42 }, { token: decision.token!, actorId: "usr_123" });
} catch (err) {
  if (err instanceof GovernanceBlockedError) {
    // err.reason ∈ {
    //   "MISSING_TOKEN",         // no token provided
    //   "INVALID_SIGNATURE",     // token signature didn't verify
    //   "EXPIRED",               // token TTL elapsed
    //   "REPLAYED",              // token already consumed
    //   "CAPABILITY_MISMATCH",   // token bound to different capabilityId
    //   "PAYLOAD_MISMATCH",      // payload hash didn't match
    //   ...
    // }
    log.warn("governance blocked", { reason: err.reason, capabilityId: err.capabilityId });
    return res.status(403).json({ error: "blocked", reason: err.reason });
  }
  throw err;  // genuine downstream error
}
```

The evidence sink ALSO records a blocked-execution record for each
throw, so the audit trail captures the refusal even when the calling
code doesn't.

## Decision Outcomes

Every governance evaluation produces one of three outcomes:

| Outcome | Description | Token Issued? |
| :--- | :--- | :--- |
| **ALLOW** | Action permitted by policy | Yes (SDT) |
| **DENY** | Action blocked by policy | No |
| **INTERCEPT** | Action requires human approval before execution | No (pending approval) |

## tRPC Integration

```typescript
import { createGovernedProcedure } from '@strixgov/sdk/middleware/trpc';

const governedProcedure = createGovernedProcedure(strix, protectedProcedure);

// In your router:
deleteProgram: governedProcedure("app.program.delete")
  .input(z.object({ id: z.number() }))
  .mutation(async ({ input, ctx }) => {
    await deleteProgram(input.id);
    return { success: true, executionId: ctx.strix.executionId };
  }),
```

## Express Integration

```typescript
import { createGovernanceMiddleware } from '@strixgov/sdk/middleware/express';

const governance = createGovernanceMiddleware(strix);

app.delete('/api/resources/:id',
  governance("app.resource.delete"),
  async (req, res) => {
    await deleteResource(req.params.id);
    res.json({ deleted: req.params.id });
  }
);
```

## Simulation Mode

Test governance decisions without side effects:

```typescript
const result = await strix.simulate({
  capability: "app.resource.delete",
  actorId: "usr_123",
});
// → { status: "ALLOWED" | "DENIED" | "REQUIRES_APPROVAL", ... }
```

## Local Mode vs. Connected Mode

### Local Mode (no account required)

Run fully offline. Evidence records are written locally and verifiable with the `@strixgov/verifier` CLI using a local JWKS export. No network calls, no cost, no account.

```typescript
const strix = new StrixGovernance({
  policyEngine: { type: "local", signingKey: process.env.STRIX_SIGNING_KEY! },
  evidenceSink: { type: "file", path: "./evidence/audit.jsonl" },
});
```

Verify evidence records locally:

```bash
npx @strixgov/verifier chain ./evidence/audit.jsonl --jwks ./strix-jwks.json
```

(`verify --file --keys` was the v0.x subcommand. The current verifier uses
`chain <path> --jwks <jwks>` — see [Verifying what you produced](#verifying-what-you-produced).)

Local Mode is production-capable. It enforces the same token, anti-replay, and evidence invariants as Connected Mode. The only difference is where evidence flows and who can query it.

### Connected Mode (API key + Strix console)

When you're ready to centralize governance visibility — audit exports,
quorum approvals, multi-tenant governance, compliance reports — add your
API key:

```typescript
const strix = new StrixGovernance({
  policyEngine: {
    type: "remote",
    url: "https://www.strixgov.com",
    apiKey: process.env.STRIX_API_KEY!,
    tenantId: process.env.STRIX_TENANT_ID!,
  },
});
```

**How to obtain `STRIX_API_KEY` + `STRIX_TENANT_ID`:** Connected mode is
operator-provisioned in v0.1.0 — self-serve signup is staged for a
future release. To request a tenant + API key today, email
`sales@strixgov.com` with: (a) your intended environment name
(`development` / `staging` / `production`), (b) the actor scope you need
(single agent / team / multi-tenant), (c) your data-residency
constraint, if any. Same-day provisioning during US business hours.

**Local Mode is the recommended default** for evaluation, single-agent
deployments, and any scenario where you don't need cross-machine
aggregation. The cryptographic guarantees are identical; only the
storage and visibility surface differ.

Evidence records flow to the Strix console at `strixgov.com`. The
`@strixgov/verifier` CLI can verify records against the public JWKS at
`https://www.strixgov.com/.well-known/strix-jwks.json`.

## Policy Engines

| Engine | Use Case |
| :--- | :--- |
| `LocalPolicyEngine` | Air-gapped environments, testing, single-app deployments |
| `RemotePolicyEngine` | Centralized governance via the Strix console |
| Custom (`PolicyEngine` interface) | Bring your own policy evaluation logic |

## Strix Decision Token (SDT) Format

```json
{
  "typ": "SDT",
  "alg": "EdDSA",
  "payload": {
    "capabilityId": "app.resource.delete",
    "actorId": "usr_123",
    "resourceId": "res_456",
    "decisionId": "dec_789",
    "environment": "production",
    "issuedAt": 1710150000,
    "expiresAt": 1710153600
  },
  "signature": "base64url_ed25519_signature"
}
```

SDTs are:
- **Single-use** — consumed on first redemption; replay attacks are blocked
- **Time-bound** — expire after a configurable TTL (default: 5 minutes)
- **Capability-bound** — tied to a specific action, cannot be used for other operations
- **Payload-bound** — tied to the exact request payload hash, preventing parameter tampering

## Evidence Records

Every governed execution produces an immutable `ExecutionRecord`:

```json
{
  "executionId": "exec_abc123",
  "decisionId": "dec_789",
  "capabilityId": "app.resource.delete",
  "actorId": "usr_123",
  "timestamp": "2026-03-11T12:00:00Z",
  "outcome": "EXECUTED",
  "recordHash": "sha256:..."
}
```

Verify integrity programmatically:

```typescript
import { verifyRecordIntegrity } from '@strixgov/sdk';

const isValid = verifyRecordIntegrity(record); // true or false
```

Evidence sinks:
- **Memory** — for testing (`MemoryEvidenceSink`)
- **File** — append-only JSONL file (`FileEvidenceSink`)
- **Custom** — implement the `EvidenceSink` interface for database, S3, or external systems

## Security Model

| Attack Vector | Protection |
| :--- | :--- |
| Direct API bypass (no token) | Fail-closed: missing token = hard block |
| Token replay | Single-use enforcement: consumed before execution |
| Payload tampering | Token bound to SHA-256 payload hash |
| Expired token | TTL enforcement with configurable expiration |
| Capability mismatch | Token bound to specific capabilityId |
| Forged token | Ed25519 signature verification |

## API Reference

### Core

- `StrixGovernance` — Main governance client
- `GovernanceBlockedError` — Thrown when execution is blocked

### Token

- `createPayload()` — Create an SDT payload
- `signToken()` — Sign a token with Ed25519
- `validateToken()` — Validate and verify a token
- `deserializeToken()` — Parse a serialized token

### Evidence

- `buildExecutionRecord()` — Create an execution record
- `computeRecordHash()` — Compute SHA-256 integrity hash
- `verifyRecordIntegrity()` — Verify record has not been tampered with

### Engines

- `LocalPolicyEngine` — Local, air-gapped policy evaluation
- `RemotePolicyEngine` — Remote policy evaluation via the Strix console

### Simulation

- `simulate()` — Dry-run governance evaluation without side effects

## Verifying what you produced

Every `governedAction` call (allowed or blocked) appends an
`ExecutionRecord` to the configured `evidenceSink`. To prove
independently that a record is genuine, hand it to
[`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier)
— a zero-dependency package with no Strix runtime:

```bash
# File sink at ./evidence/audit.jsonl produced records during your test run.
# Verify the chain (signatures + per-record hash + proof-chain link integrity):
npx @strixgov/verifier chain ./evidence/audit.jsonl --jwks ./public-jwks.json
```

`public-jwks.json` is a `{"keys":[…]}` document containing the public
half of the keypair the SDK was configured with. If you generated keys
via the Quick Start snippet, paste the printed `STRIX_PUBLIC_JWK` into
a `{"keys":[…]}` wrapper:

```bash
# Wrap the JWK from the Quick Start snippet output into a JWKS file
echo "{\"keys\":[$STRIX_PUBLIC_JWK]}" > public-jwks.json
```

The verifier confirms each record was signed by the holder of the
private key and that the proof chain has not been edited since.

## Troubleshooting

| Symptom | Most likely cause | Fix |
|---|---|---|
| Runtime error `STRIX_SIGNING_KEY is undefined` | Quick Start env-var wasn't sourced into the process; or shell session reset | Re-source `strix-keys.env`; for persistent setup use a `.env` file + `dotenv` or your platform's secret-manager |
| `Error: Invalid PKCS8 key` on first `governedAction` call | `STRIX_SIGNING_KEY` is not base64-encoded DER PKCS8 (e.g. you exported a PEM by mistake) | Regenerate with the Quick Start snippet — it produces the right format |
| `GovernanceBlockedError: MISSING_TOKEN` on every call | Calling code is invoking the wrapped action without passing the token from `requestDecision` | Always call `requestDecision` first; pass `decision.token` to the action |
| `GovernanceBlockedError: REPLAYED` on the second use of a valid token | Tokens are single-use by design — request a fresh decision per call | `await strix.requestDecision({...})` before each governed action |
| Verifier prints `KEY_NOT_FOUND` | `public-jwks.json` doesn't contain a key matching the `signingKeyId` from the record | Regenerate JWKS from the same private key the SDK was signing with; check the `kid` field matches |
| Connected Mode `401 Unauthorized` | `STRIX_API_KEY` or `STRIX_TENANT_ID` not set or invalid | See [Connected Mode](#connected-mode-api-key--strix-console) for provisioning |

## What this is NOT

- **Not a replacement for application authorization** — RBAC, OAuth
  scopes, user-permission checks still apply at the same layer they
  always did. The SDK governs the *side effect* boundary, not the
  user-identity boundary.
- **Not a runtime sandbox** — the SDK refuses to mint a token for a
  blocked action, and the `governedAction` wrapper refuses to execute
  without one. It does NOT prevent in-process code from calling
  underlying SDKs directly. If your application bypasses
  `governedAction`, the SDK can't help — defense-in-depth + code review
  matter.
- **Not protection against compromised credentials** — if the
  `STRIX_SIGNING_KEY` is leaked, an attacker can mint valid tokens for
  any capability the policy engine allows. Treat the signing key with
  the same discipline as any production secret (KMS, rotation, etc.).
- **Not "AI safety" or "prompt injection prevention"** — the SDK
  controls what actions execute; it does NOT control what the agent
  *attempts*. Defense-in-depth still requires prompt-side controls.
  See [`docs/security/AA-2-OUT-OF-SCOPE.md`](https://github.com/Strixgov/strix/blob/main/docs/security/AA-2-OUT-OF-SCOPE.md)
  for the architectural boundary.
- **Not a fully-managed service in v0.1.0** — Connected Mode is
  available but tenant provisioning is operator-driven (see Connected
  Mode section). Self-serve signup is a future workstream.

## Requirements

- Node.js 18+ (for `node:crypto` Ed25519 support)
- TypeScript 5.0+ (recommended — type definitions ship with the package)
- A package manager — npm (ships with Node), pnpm, or yarn all work
- No native build step

## License

[MIT](./LICENSE) © Velaris Group, 2026 — free to use, modify, embed, and
redistribute.

The SDK is an **open trust primitive**: it is the governed-action contract
every integrator builds against, so it carries no commercial restriction —
the same reason the verification primitives it pairs with
([`@strixgov/verifier`](https://www.npmjs.com/package/@strixgov/verifier),
[`@strixgov/tool-gateway`](https://www.npmjs.com/package/@strixgov/tool-gateway),
[`@strixgov/mcp-token-validator`](https://www.npmjs.com/package/@strixgov/mcp-token-validator))
are MIT. Only the protected runtime/control surfaces
([`@strixgov/mcp-adapter`](https://www.npmjs.com/package/@strixgov/mcp-adapter),
[`@strixgov/mcp-proxy`](https://www.npmjs.com/package/@strixgov/mcp-proxy)) are
Elastic-2.0. See [`LICENSING_BOUNDARY.md`](../../LICENSING_BOUNDARY.md) for the
canonical split.

See [LICENSE](./LICENSE) for the complete terms.
