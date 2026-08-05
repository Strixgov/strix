# @strixgov/governed-action

Wrap one consequential mutation in a governed action that produces an
independently verifiable signed receipt.

## Try it in one command

```bash
npx @strixgov/governed-action demo
```

One real kernel decision, one real Ed25519-signed receipt, and the command to
verify it yourself. No account, no config. The side effect is simulated — the
demo proves the governance path, not that a business action occurred, and it
says so on every run.

Add `--self-check` to exercise the same wiring offline against a local server,
or `--json` for machine-readable output.

## Install

```bash
npm install @strixgov/governed-action
```

```ts
import { governedFetch } from '@strixgov/governed-action';

const { verifyCommand } = await governedFetch(
  'mcp.github.merge_pull_request',
  'https://api.github.com/repos/acme/api/pulls/482/merge',
  { method: 'PUT', headers: { Authorization: `Bearer ${token}` } },
);

console.log(verifyCommand);
// npx @strixgov/verifier@latest <the evidenceId your run just minted>
```

The id is minted per run — this example deliberately does not show a real one.
An earlier draft of this README printed `cmry11c1e000kld04qv8mrzx8` here, which
is a genuine production receipt but for `sales_pipeline_deal_create` on
2026-07-23, not for the `mcp.github.merge_pull_request` call above. A real
fingerprint attached to the wrong capability reads as evidence for something
that never happened, so it is gone. (`lint-fabricated-fingerprints` cannot catch
this class: the id was real, just borrowed.)

Run that command and anyone — you, an auditor, a customer — gets
`Status: VERIFIED` from a package that shares no code with this one.

**No account required to try it.** With `STRIX_API_KEY` / `STRIX_TENANT_ID`
unset, a short-lived sandbox credential is provisioned automatically.

## What it guarantees

The order is the point, and it is enforced on every path:

1. **Evaluate before executing.** The kernel decides first.
2. **A block never executes.** Deny, approval-required, and an unreachable
   kernel all throw *before* your operation runs. Failing closed is the
   default, not a configuration.
3. **Record what happened.** An evidence row, then a signed receipt.
4. **Never fabricate.** If the receipt call fails, `signedEvidenceId` is
   `null` — the mutation already happened and is not undone for want of a
   receipt, but nothing is invented to fill the gap.

## Two entry points

`governedAction(input, operation)` wraps any async function.

```ts
await governedAction(
  { capabilityId: 'payments.refund.issue', payload: { orderId, amountCents } },
  () => stripe.refunds.create({ payment_intent: pi }),
);
```

`governedFetch(capabilityId, url, init)` wraps an HTTP call. Request
**headers are never hashed or recorded** — that is where credentials live. A
non-2xx response is returned rather than thrown, because the call genuinely
happened and the evidence should say so.

## Is your action consequential?

Time-to-First-Proof only counts a proof if the action was consequential —
registered at HIGH/CRITICAL, or on an irreversible boundary. This package
reports that honestly instead of assuming it:

```ts
import { resolveCapability } from '@strixgov/governed-action/capabilities';
import { githubCapabilities } from '@strixgov/capabilities-mcp-common/github';

resolveCapability('mcp.github.merge_pull_request', githubCapabilities);
// { qualification: { status: 'QUALIFIES', tier: 'CRITICAL', … } }
```

Three outcomes, deliberately: `QUALIFIES`, `NOT_CONSEQUENTIAL`, and
`UNKNOWN` for an id absent from the classifications you supplied. It is never
collapsed to a boolean, because a library cannot know your private registry.

**Known limitation, stated plainly:** of the 13 currently classified Slack
capabilities, none is HIGH or CRITICAL. A Slack action can be governed and
recorded, but it cannot back a qualifying first proof today, and
`resolveCapability` will tell you so rather than promote it.

Placeholder ids (`test`, `dummy`, `example`, …) are refused outright. A proof
bound to a placeholder proves nothing.

## Errors

| Error | Did your operation run? |
|---|---|
| `StrixDenied` | No |
| `StrixApprovalRequired` | No |
| `StrixUnreachable` | No |
| your own error | Yes — recorded, then rethrown |

## Notes

Canonicalization is imported from `@strixgov/sdk`, never re-implemented — one
canonical byte contract across every Strix signer and verifier.

MIT.
