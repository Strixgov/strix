# Redaction comparison on the committed synthetic corpora — 2026-10-06

**Measured, not generated.** Unlike `REPORT.md`, this file is not
byte-locked: two of the three tools need large local models that CI does not
install. Rerun with `accuracy/benchmark.mjs`. All corpora are synthetic and
written by this package's author, two of them with knowledge of the
detector's rules, so read this as a comparison harness, not an independent
benchmark.

**Scoring** (`accuracy/benchmark.mjs`): an identifier *survived* if its text
still appears (case-insensitive) in what the tool would release; a refused
document releases nothing and is counted apart; a *preserved value* (billing
code, payer, facility, specimen type) should still be there afterwards.

| Tool | main corpus | held-out | lab dev | lab held-out |
|---|---|---|---|---|
| Identifiers survived (lower is better) | | | | |
| Strix pattern detector 0.6.0 | 0 / 43 | 0 / 10 | 12 / 26 | 5 / 14 (5 in refused docs) |
| Strix pattern + signal worker | 0 / 43 | 0 / 10 | 11 / 26 | 3 / 14 (5 in refused docs) |
| Strix pattern + lab packs 0.1.0 | 0 / 43 | 0 / 10 | 3 / 26 (tuned on this split) | 3 / 14 (5 in refused docs) |
| Presidio 2.2.364 defaults, en_core_web_lg | 5 / 43 | 2 / 10 | 4 / 26 | 3 / 14 |
| Preserved values kept (higher is better) | | | | |
| Strix pattern detector 0.6.0 | 17 / 17 | 10 / 10 | 28 / 28 | 8 / 11 |
| Strix pattern + signal worker | 17 / 17 | 10 / 10 | 28 / 28 | 8 / 11 |
| Strix pattern + lab packs 0.1.0 | 17 / 17 | 10 / 10 | 28 / 28 | 8 / 11 |
| Presidio 2.2.364 defaults | 9 / 17 | 7 / 10 | 21 / 28 | 7 / 11 |

On the recall experiment's adversarial corpora (`experiments/jev-recall`,
46 identifiers), the signal worker run (`apps/egress-signal-worker/conformance.mjs`,
weights verified as `a68c3be1…`) let **0** survive, against **25** for the
pattern detector alone, and gave identical output on a second run. It also
redacted two decoy words that were not identifiers (`Allegra`, `Frank`).

## What this says

- **On the main corpora the comparison flatters us.** Those documents were
  written alongside the detector. Do not quote 0/43 against Presidio.
- **On lab documents the detector is behind on identifiers.** Lab-specific
  IDs (accession, specimen, barcode, claim control, patient account) survive
  8 of 9 times; the signal worker does not help there, because it proposes
  names and bank accounts only. Presidio removes more of them, at the cost of
  destroying billing codes and payer names. That gap is what the
  `lab-requisition` and `eob-835` packs are for. With them on, held-out
  survival drops from 5 to 3 of 14 and every code is kept; dev drops from 12
  to 3 but the rules were tuned there, so quote held-out (`lab-packs/HASHES.md`).
- **The signal worker closes the name gap on the adversarial set.** It is
  built and measured, not deployed; registering it in a Strix deployment is
  still step 6 of the approved build order.

## Phase 2 held-out split (denial letters, provider ids, date-times)

`lab-packs/corpus-heldout-p2.mjs`, 16 identifiers, 16 preserved values,
5 provider ids. Committed before the Phase 2 rules; see `lab-packs/HASHES.md`.

| Tool | survived | preserved kept | provider ids kept |
|---|---|---|---|
| Strix detector 0.6.0 | 8 / 16 | 16 / 16 | 2 / 5 |
| Strix detector 0.7.0 | 5 / 16 | 16 / 16 | 2 / 5 |
| Strix 0.7.0 + all four packs | 4 / 16 | 16 / 16 | 0 / 5 (pack replaces them by design) |
| Strix detector 0.8.0 (provider ids kept) | 5 / 16 | 16 / 16 | 5 / 5 |
| Presidio 2.2.364 defaults | 2 / 16 | 8 / 16 | 0 / 5 |

Presidio removes more identifiers and destroys half the billing codes and
payer names. Neither number is an independent benchmark.

Rows above the 0.8.0 row were measured before the base detector began
keeping provider ids. On the main corpus 0.8.0 moves one label (a practice
TIN) from identifier to preserved value; the earlier rows were not re-run.

## How each run was made

- Strix: `node accuracy/benchmark.mjs --strix` (healthcare reference policy).
- Strix + worker: same pipeline with the pinned worker as a signal
  (gliner_multi_pii-v1 @ 1fcf13e8, threshold 0.5), on CPU.
- Presidio: `AnalyzerEngine()` + `AnonymizerEngine()` defaults, English,
  replace operator, run as `--cmd` (`python -I redact.py`). No custom
  recognizers; a tuned Presidio would score differently.
