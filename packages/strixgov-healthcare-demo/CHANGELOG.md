# Changelog

## 0.1.0 (2026-05-31)

Initial release.

- Four-phase clinical AI agent workflow: CLASSIFY → EVALUATE → SIGN → VERIFY.
- Synthetic patient data generator (zero real PHI, deliberately implausible-as-real).
- HIPAA minimum-necessary redaction (Safe Harbor 10-year age bucketing per §164.514(b)(2)(B)).
- Ed25519 signature path using Node's native `crypto` (same primitives as production).
- Multi-framework compliance flag derivation: EU AI Act (Articles 12 / 14 / 28) + HIPAA Technical Safeguards (45 CFR §164.312 b / c / d).
- Flags are DERIVED from verification outcome, never asserted (CI-5 / SE-18 invariant).
- Tamper-detection: re-derives canonical bytes from the record during verification, not from producer-supplied bytes.
- 12-test suite, all passing in ~130 ms.
- Throwaway test key bundled in `assets/` — zero production trust value, published publicly.
- Self-contained: no network, no Strix backend, no account required.
