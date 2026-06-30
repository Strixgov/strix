# @strixgov/healthcare-demo

**30-second clinical AI agent governance demo for Strix.** Generates a synthetic PHI-handling workflow, applies HIPAA minimum-necessary redaction, signs the action with a throwaway test key, verifies it cryptographically, and prints the HIPAA + EU AI Act compliance flag derivations. No real PHI. No Strix backend. No account.

```bash
npx @strixgov/healthcare-demo
```

That's the whole pitch. Three seconds, four phases, full cryptographic receipt at the end, all four EU AI Act flags and all three HIPAA Technical Safeguards flags derived from the verification outcome.

## What it shows

```
  STRIX · Clinical AI Agent Governance Demo
  Synthetic patient data. No real PHI. No Strix backend.

Step 1 of 4 · INTAKE — clinician submits patient note
──────────────────────────────────────────────────────────────────────
  Clinician          user:dr-rivera
  Role               physician.cardiology
  Capability         clinical.note.submit

  Submitted note (raw):
  Patient name       Quintessa Aethelwood          ← deliberately fictional
  DOB                04 / 17 / 1962
  MRN                MRN-FX9-1042
  Note               post-op day 3, mild edema. BP 132/84. Continue lisinopril 10mg.

Step 2 of 4 · CLASSIFY — kernel applies minimum-necessary
──────────────────────────────────────────────────────────────────────
  PHI present        true
  Fields redacted    patientName, dob, mrn
  Fields retained    note, ageBracket, mrnToken

  Redacted payload (what the AI model actually sees):
  Patient name       [REDACTED]
  Age bracket        60-69                          ← HIPAA Safe Harbor 10-yr bucket
  MRN token          MRN-…
  Note               post-op day 3, mild edema. BP 132/84. Continue lisinopril 10mg.

Step 3 of 4 · EVALUATE + SIGN — policy + Ed25519
──────────────────────────────────────────────────────────────────────
  Decision           ALLOW
  Evidence ID        029896
  Signing key        strix-test-2026-05            ← TEST key, not production
  Signature          koEtD72c3u5HyRFu0WakWYfv…gUTS2hAQ

Step 4 of 4 · VERIFY — cryptographic + regulatory derivation
──────────────────────────────────────────────────────────────────────
  Status             VERIFIED
  Signature valid    true

  EU AI Act compliance (derived, never asserted):
  ✓ Article 12 · Traceability
  ✓ Article 12 · Tamper-Resistance
  ✓ Article 14 · Human Oversight Supported
  ✓ Article 28 · Audit Ready

  HIPAA Technical Safeguards (45 CFR §164.312, derived):
  ✓ §164.312(b) · Audit Log Present
  ✓ §164.312(c)(1) · Integrity Assured
  ✓ §164.312(d) · Access Authenticated
```

## Why it exists

If you work in healthcare AI — RCM operations, clinical decision support, agentic prior-auth, Medicaid enrollment — and you've been asked "how would you prove an AI agent handled PHI correctly?" then this demo is the answer in 30 seconds.

The workflow it walks through is the same one that runs in production Strix deployments. Same canonical-payload format, same Ed25519 signature path, same compliance flag derivation logic. The only difference is the demo uses a published throwaway test key — so anyone can run it offline without involving Strix.

**The compliance flags are DERIVED from the verification outcome, never asserted by the producer.** You can run the demo yourself, tamper with the receipt, and watch every flag turn red. That's the load-bearing trust property — a covered entity can't fake compliance by writing flags into a record; the audit trail derives them from cryptographic evidence.

## Run it

```bash
# Default — uses today's seed for the synthetic data
npx @strixgov/healthcare-demo

# Pin a specific seed (0–4) to get the same fictional patient each time
STRIX_DEMO_SEED=0 npx @strixgov/healthcare-demo

# Disable terminal colors
NO_COLOR=1 npx @strixgov/healthcare-demo
```

Runtime: ~3 ms for the workflow itself, ~1–2 s total for `npx` to download the package.

## Programmatic API

```js
import {
  buildSyntheticSubmission,
  classifyAndRedact,
  runWorkflow,
} from "@strixgov/healthcare-demo";

const submission = buildSyntheticSubmission(0);
const result = await runWorkflow(submission, { classifyAndRedact });

console.log(result.verify.verificationStatus);
// → "VERIFIED"

console.log(result.verify.compliance.hipaa.hipaa_audit_log_present);
// → true
```

Useful for: integration tests, training material, demos in slides, building healthcare-specific governance dashboards on top of the same primitives.

## Privacy & data warnings

**All names, dates, MRNs, conditions, and clinical notes in this package are fictional.** They were generated with deliberately implausible-as-real combinations (uncommon first-name + last-name pairs, year ranges chosen to be obviously synthetic). The package contains no real PHI and never reads any.

**The signing key in `assets/test-private-key.json` is a throwaway test key.** It is published publicly on `Strixgov/strix` and has zero production trust value. Do not use it for signing anything that needs to be trusted by anyone.

## How this relates to real production Strix

| Demo behavior | Production behavior |
|---|---|
| Signs with `strix-test-2026-05` (published in this package) | Signs with `strix-prod-YYYY-MM` (held in HSM/KMS) |
| Records live only in the runner's memory | Records persist in the `decision_evidence` table |
| Verifies against the bundled test JWKS | Verifies against `https://www.strixgov.com/.well-known/strix-jwks.json` |
| `complianceMode: "multi:eu_ai_act_2026+hipaa_2026"` | Same — drives the same flag derivations |
| No tenant authentication | Tenant context bound via `withPublicVerifier()` RLS pattern |
| Synthetic patient data | Real PHI passes through the same redaction + signing flow |

If you want to verify a real production Strix record, switch tools:

```bash
npx @strixgov/verifier@latest 12537
```

## License

MIT. See [LICENSE](./LICENSE).
