# Migrating `@strixgov/sdk` 0.1.x → 0.2.0

`@strixgov/sdk` 0.2.0 is the **open proof surface** of Strix. It can *verify*
governed-action receipts, decision tokens, and actor attestations against the
public JWKS — without trusting Strix. That is all it does, and that is the
point: anyone can verify with only this MIT package + the public key.

The **control layer** — issuing authority to execute — moved to the commercial
Strix platform package `@strixgov/governance-core` ("operated, not shipped").

## What stayed in `@strixgov/sdk` (no change)

- `canonicalizePayload`, `sha256`
- `deserializeToken`, `verifySignature`, `validateToken`, `TokenFormatError`,
  `TokenValidationResult`
- `buildExecutionRecord`, `computeRecordHash`, `verifyRecordIntegrity`,
  `MemoryEvidenceSink`, `FileEvidenceSink`, `createEvidenceSink`
- Actor-attestation verification + signing, `transaction-proof`, `mcp-proof`,
  `jwks`, the `web` verification badge, and all schema types
  (`SDTPayload`, `StrixDecisionToken`, the capability-graph types via
  `@strixgov/sdk/graph`, etc.)

If you only **verify**, upgrading is a no-op.

## What moved out (now in `@strixgov/governance-core`)

| Removed export | Where it lives now |
|---|---|
| `StrixGovernance`, `GovernanceBlockedError` | `@strixgov/governance-core` |
| `createPayload`, `signToken`, `serializeToken` (token **minting**) | `@strixgov/governance-core` |
| `LocalPolicyEngine`, `RemotePolicyEngine` | `@strixgov/governance-core` |
| `simulate` | `@strixgov/governance-core` |
| `CapabilityRegistry`, `ResolutionPipeline`, `Memory*Store`, profiles, packs | `@strixgov/governance-core` |
| `GovernedAgent`, `AgentRegistry`, `create*Agent` | `@strixgov/governance-core` |
| `@strixgov/sdk/middleware/express`, `@strixgov/sdk/middleware/trpc` | `@strixgov/governance-core/middleware/*` |

`@strixgov/governance-core` re-exports the full `@strixgov/sdk` surface, so you
import everything from one place when you have it.

## How to migrate

**You verify receipts/tokens (most consumers):** nothing to do — stay on
`@strixgov/sdk`.

**You run governed execution (engine, token minting, agents, middleware):**
that capability is now part of the commercial Strix platform. Replace:

```diff
- import { StrixGovernance, LocalPolicyEngine } from '@strixgov/sdk';
+ import { StrixGovernance, LocalPolicyEngine } from '@strixgov/governance-core';
```

```diff
- import { governedRoute } from '@strixgov/sdk/middleware/express';
+ import { governedRoute } from '@strixgov/governance-core/middleware/express';
```

Contact Strix for access to `@strixgov/governance-core`.

## Why

Open the proof; sell the control. The verification surface is more valuable the
more freely it can be inspected and run; the execution-control surface is the
commercial moat. Keeping minting/decisioning out of the MIT package is the
boundary that makes "don't trust us — verify the receipt" a true statement.
