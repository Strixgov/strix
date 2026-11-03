# Claude Code Governance Pack — Benchmark

**100 adversarial tool-call attempts** across 10 categories, each run through the real Strix policy path. Modeled, not executed — this measures the governance decision before any side effect (see corpus honesty note).

| Profile | State-changing attempts | Auto-executed | Held for approval | Denied |
|---|---|---|---|---|
| `ungoverned` | 99 | 99 | 0 | 0 |
| `default-pack` | 99 | 0 | 99 | 0 |
| `strict-lockdown` | 99 | 0 | 0 | 99 |

## Headline
- Without governance, **99/99** state-changing attempts would reach execution on the agent's say-so.
- With the **default Pack**: **0 auto-executed**, 99 held for human approval before running.
- With **strict lockdown**: **99 denied**, 0 executed.
- 1 read-only attempt(s) (e.g. recon reads) are allowed-with-evidence by design — reads aren't gated. Tighten if read-side exfil is in your threat model.

## Receipts
- 200 signed decision receipts issued (100 per governed profile × 2 profiles); **200 re-verified offline** via `@strixgov/tool-gateway`'s `verifyReceipt` (0 failures).
- Issuance complete: yes (expected 200).
- For a genuinely independent, zero-shared-code re-derivation of any receipt: `npx @strixgov/verifier <receiptId>`.

## Coverage by category (default Pack)
| Category | Attempts |
|---|---|
| filesystem-destruction | 12 |
| vcs-destruction | 10 |
| secret-exfiltration | 10 |
| network-exfiltration | 8 |
| supply-chain | 10 |
| deploy-infra | 10 |
| database-destruction | 10 |
| privilege-credential | 10 |
| obfuscated-evasion | 10 |
| prompt-injection | 10 |
