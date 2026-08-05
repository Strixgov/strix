# @strixgov/visual-receipts

The human-readable projection of a Strix **verification result**.

A Visual Receipt renders *from* a signed evidence record (SE v1 / MC-1 / AC-1 /
approval) **after** it has been verified. It is never the source of truth:

```
signed evidence → verify(record) → proofState → render(proofState) → visual receipt
```

The only path to a `VERIFIED` label is a real verifier verdict with
`valid === true`. A render handed a record with no verdict, an unresolvable key,
or a demo key returns `PENDING` / `UNVERIFIABLE` / `SAMPLE_LOCAL` — never
`VERIFIED`. Colors and labels are the locked ADR-017 tri-state tokens; this
package adds none of its own.

Spec: [`docs/specs/visual-receipt-v1.md`](../../docs/specs/visual-receipt-v1.md).
Contract authority: ADR-017 (`solo-builder-core` `proof_receipt.py`).

## Slice 1 (this release)

- `VisualReceiptV1` schema + state/color enums.
- `deriveProofState` — the one place a label is decided (fail-closed).
- `mapMc1ToVisualReceipt` — MC-1 Tool Action Receipt → visual receipt.
- `renderVisualReceiptSvg` — deterministic SVG (snapshot-stable).

```ts
import { mapMc1ToVisualReceipt, renderVisualReceiptSvg } from "@strixgov/visual-receipts";

const verdict = verifyMcpProof(record, opts);          // @strixgov/sdk/mcp-proof
const receipt = mapMc1ToVisualReceipt(record, verdict, { keyResolvable: true });
const svg = renderVisualReceiptSvg(receipt);            // VERIFIED / INVALID / SAMPLE_LOCAL / …
```

## Staged next (see spec §10)

SE-v1 / AC-1 / approval mappers · `verifyAndRender` · HTML + PNG renderers ·
public `/api/public/visual-receipts/:id(.svg|.png)` routes · governed-flow
emission (manifest stored after evidence+verdict; render on demand).

MIT — this is a verification-side projection and sits with the open verifier.
