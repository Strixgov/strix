# @strixgov/execution-authority

The external SDK for the **Strix Execution Authority Boundary v1**. It lets an
agent platform, an MCP server, or any service that performs consequential
actions ask Strix for bounded authority over one exact proposed action, redeem
that authority immediately before its own handler runs, report what happened,
and independently verify the signed evidence Strix produced.

It shares no code with the Strix issuer. Grant verification, canonicalization
and revocation handling are re-implemented here from the contract and pinned to
Strix's conformance corpus (`conformance/corpus/execution_authority_v1`).

```
npm install @strixgov/execution-authority
```

## The one rule

```ts
const result = await client.redeem(grant, currentExecution, presenter);
if (result.status !== 'PERMIT') {
  // the handler MUST NOT execute
}
```

`executeGoverned` is that rule as code. The handler it is given is entered in
exactly one place, after Strix has atomically consumed the grant for the
execution presented at that moment. On every other outcome it returns with
`handlerEntered: false` and the handler untouched.

## What a grant binds

A `strix-execution-authority-v1` grant is an Ed25519-signed artifact carrying
eight bound fields: `tenantId`, `principalId`, `proposalId`, `action`,
`consequenceId`, `executionRoute`, `payloadCommitment` and
`currentStateCommitment`. Strix never sees a payload or a state; it sees the
commitments the consumer computed and compares them again at redemption. If the
bytes the handler is about to act on, or the standing it just read, differ from
what was proposed, the presented execution differs and the grant does not cover
it.

`PERMIT` means Strix consumed a single-use, time-bounded, revocable grant for
the exact execution presented. It never means "policy looked okay".

## Usage

```ts
import { StrixExecutionAuthorityClient, executeGoverned, buildProposal, canonicalSha256 } from '@strixgov/execution-authority';

const client = new StrixExecutionAuthorityClient({
  baseUrl: 'https://www.strixgov.com',
  token: process.env.STRIX_TOKEN!,          // the v1 service credential
  strixTenantId: process.env.STRIX_TENANT!, // the Strix tenant id (cuid)
});

const payload = { orderId: 'order-7731', amountCents: 98900, destination: 'card:4242' };
const standing = await readOrderState('order-7731');

const proposal = buildProposal({
  proposalId: 'xp:order-7731:refund',
  tenantId: 'my-consumer-tenant',
  principalId: 'agent:refund-assistant',
  action: 'payments.refund.issue',
  consequenceId: 'refund:order-7731:98900',
  executionRoute: 'POST /refunds',
  payloadCommitment: canonicalSha256(payload),
  currentStateCommitment: canonicalSha256(standing),
});

const outcome = await executeGoverned({
  client,
  proposal,
  presenter: 'refund-service',
  // Re-read at the boundary: what is ABOUT to run, not what was proposed.
  currentExecution: async () => ({
    ...proposal,
    payloadCommitment: canonicalSha256(payload),
    currentStateCommitment: canonicalSha256(await readOrderState('order-7731')),
  }),
  handler: async () => processor.refund(payload),
});

switch (outcome.status) {
  case 'PERMIT':            // handler ran once; outcome.outcome carries the signed evidence reference
  case 'REQUIRE_APPROVAL':  // approvers must act in Strix; call again with the same proposalId later
  case 'REFUSE':            // Strix or this SDK refused; nothing ran; outcome.refusalEvidenceId when Strix recorded it
  case 'UNAVAILABLE':       // Strix could not answer; nothing ran; do not execute
}
```

For agent-platform tools, `governedTool` wraps a tool's `execute` so its
handler runs only under a PERMIT for the arguments presented.

### Verifying the evidence

```ts
const proof = await client.getEvidence(outcome.strixDecisionId);   // the public record, as served
const v = await client.verify(outcome.strixDecisionId);            // @strixgov/verifier, no credential
// v.verificationStatus === 'VERIFIED' when the record re-canonicalizes and its signature checks against the JWKS
```

## Outcomes, kept distinct

Four facts are recorded separately and never collapsed:

| Fact | Recorded by | Where |
|---|---|---|
| Strix consumed the grant at an instant for the presented execution | Strix | the grant row; `PERMIT.consumedAt` |
| the handler was entered | the consumer's report | `result.handlerEntered` on the signed terminal's unsigned result |
| the consequence the consumer observed | the consumer's report | `result.observedConsequence` |
| the external processor's consequence | nobody here | `result.externalProcessorConsequence = NOT_OBSERVED_BY_STRIX` |

The signed SE v1 evidence states that Strix's decision reached `EXECUTED` or
`FAILED` for a capability, under a tenant, at an instant. The consumer's report
rides beside those fields, labelled `CONSUMER_REPORTED`, and is not promoted
into them.

## What this SDK does not do

- It does not control code that reaches the consequence by another path. It
  governs the handler it is given; a second route to the same effect is
  outside it, and Strix does not claim universal route invariance.
- It does not make an unavailable Strix safe to act around. `UNAVAILABLE` is
  not a permit, and a stale or missing revocation document is refused, never
  read as "nothing revoked".
- It does not verify a grant's semantics. It verifies that Strix issued
  bounded authority for exactly the execution presented and that the authority
  is live; whether the action was a good idea is the approvers' judgement.
- It does not observe the external processor. What the processor did is the
  consumer's report.

## Trust inputs

Trust comes from two Strix-published documents, never from a grant:
`/.well-known/strix-authority-keys.json` (the authority key set, a sibling of
the evidence JWKS and never the same keys) and the signed
`strix-authority-revocation-v1` document at `/api/public/authority/revocations`,
re-signed on every fetch with a short `validUntil`. The client caches trust
until that instant and refuses a document whose generation regresses.

## License

MIT. See `LICENSE`.
