# Lab revenue-cycle detection packs — Phase 0 record

Committed before any pack rule exists (plan:
`docs/strategy/specs/lab-rcm-detection-packs-plan-v1.md`, Phase 0 gate).

| file | version | sha256 |
|---|---|---|
| `corpus-dev.mjs` | 0.1.0 | `2cc3da640a90189863c4c51c6a02c8282decd6e1bbf85bae2f292253af2a0507` |
| `corpus-heldout.mjs` | 0.1.0 | `ba440a30ef0313133c3930105351d920d0519aa3c4eba00b854ce931125c7647` |

A pack rule may be tuned against the dev corpus only. If the held-out file's
hash ever changes, the pack's held-out numbers stop meaning anything until a
new held-out split is committed ahead of the rules again.

## Baseline: base detector `strix-pattern-phi` 0.6.0, no pack

Measured 2026-10-06 with `accuracy/benchmark.mjs` (Strix pipeline, healthcare reference
policy). Survived = still present in the released text.

| corpus | identifiers survived | in refused documents | preserved values kept |
|---|---|---|---|
| lab dev | 12 / 26 | 0 | 28 / 28 |
| lab held-out | 5 / 14 | 5 | 8 / 11 |

Where the misses are (dev): lab-specific IDs (accession, specimen, barcode,
claim control and patient account numbers: 8 of 9 survived) and names in
unlabelled layouts (4 of 8). Dates, member IDs and MRNs were all caught.
That is the gap the `lab-requisition` and `eob-835` packs exist to close.

NPI, TIN and provider names are listed as `policyDependent` and excluded from
both numbers until open question Q1 is answered.

Synthetic and written by the detector's author: a regression instrument, not
an independent benchmark.

## Phase 1: `lab-requisition` 0.1.0 + `eob-835` 0.1.0

Rules in `src/detection/packs.mjs`, tuned on the dev split only. The held-out
split was measured once, after the rules were final, and the rules were not
changed afterwards. Held-out sha256 at measurement: `ba440a30…` (unchanged,
pinned by `test/detection-packs.test.mjs`).

| corpus | no pack: survived | packs: survived | in refused docs | preserved values kept |
|---|---|---|---|---|
| lab dev | 12 / 26 | 3 / 26 | 0 | 28 / 28 |
| lab held-out | 5 / 14 | 3 / 14 | 5 (same documents as without packs) | 8 / 11 |

Still surviving with the packs:
- dev: the three are all in the `denial-appeal` family (a letter reference
  number, an appeal claim number, a name in an appeal sentence). That pack is
  Phase 2.
- held-out: a specimen number labelled only `spec`; a payer reference
  `MPS/7731905/LAB` in a denial letter (Phase 2 family); an unlabelled patient
  name beside a provider block (`provider-ids`, Phase 2).

The held-out gain is smaller than dev's (5 to 3, against 12 to 3). That gap
is the expected cost of tuning on one split and is reported rather than
closed by editing rules against the held-out text. Base corpora: no
regression (0 survive, all decoys kept, `accuracy/run.mjs --check` unchanged).

## Phase 2 corpora (committed before any Phase 2 rule)

Q1 and Q2 answered by the operator on 2026-10-06: provider identifiers are kept
by default and replaced only when a deployment opts in; a time tied to a
patient date is part of that date. The splits below were written and hashed
before the `denial-appeal` and `provider-ids` packs or the date-time fix
existed. They add a `providerIds` key, reported as kept/replaced and never
merged into survival or utility.

| file | version | sha256 |
|---|---|---|
| `corpus-dev-p2.mjs` | 0.1.0 | `b0b26e1daf3bf75910bb57c07cbe0b3a217a1a9c2fa0ad29515f6455a885baf7` |
| `corpus-heldout-p2.mjs` | 0.1.0 | `00282b29c00e520dc284923a6c2e41ee3ff7523cc49fa4046ea1afae71919822` |

Why a new held-out split: the Phase 0 held-out split was measured after Phase
1, and its remaining misses were named in this file. Tuning Phase 2 rules with
those misses in view would make that split a second dev set. Phase 2 numbers
are quoted from `corpus-heldout-p2.mjs`; the Phase 0 held-out split is still
re-measured and reported, labelled as already seen.

Baseline (detector 0.6.0), measured once:

| corpus | packs | identifiers survived | refused | preserved kept | provider ids kept |
|---|---|---|---|---|---|
| p2 dev | none | 15 / 26 | 0 | 17 / 17 | 4 / 6 |
| p2 dev | lab-requisition, eob-835 | 12 / 26 | 0 | 17 / 17 | 4 / 6 |
| p2 held-out | none | 8 / 16 | 0 | 16 / 16 | 2 / 5 |
| p2 held-out | lab-requisition, eob-835 | 8 / 16 | 0 | 16 / 16 | 2 / 5 |

Provider ids are already partly replaced with no pack (the base detector
tokenizes some provider names and labelled TINs). Packs can only add
findings, so the "keep by default" answer is not fully reachable without
changing the base detector; that is reported, not hidden.

## Phase 2: `denial-appeal` 0.1.0 + `provider-ids` 0.1.0 + detector 0.7.0

Rules in `src/detection/packs.mjs` and the date-time fix in
`src/detection/pattern-detector.mjs` (0.7.0), tuned on `corpus-dev.mjs` and
`corpus-dev-p2.mjs` only. `corpus-heldout-p2.mjs` (`00282b29…`, unchanged,
pinned by test) was measured after the rules were final.

**One correction after the held-out run, recorded rather than hidden.** The
first held-out run refused one document: the `provider-ids` name rule ran
under the `i` flag, so `\p{Lu}` matched lower-case letters and
"physician Dr" was read as a name; the rescan then refused the release. The
Phase 1 `pt name` rule had the same flaw (hence `lab-requisition` 0.1.1).
The fix makes those rules case-sensitive on the value; it adds or removes no
label and no value shape. The held-out survivors were the same before and
after, apart from that refused document now releasing. A regression test
pins it.

| corpus | packs | survived | refused | preserved kept | provider ids kept |
|---|---|---|---|---|---|
| p2 dev | none (0.7.0) | 9 / 26 | 0 | 17 / 17 | 4 / 6 |
| p2 dev | all four | 0 / 26 (tuned here) | 0 | 17 / 17 | 0 / 6 |
| **p2 held-out** | none (0.7.0) | **5 / 16** | 0 | 16 / 16 | 2 / 5 |
| **p2 held-out** | lab-requisition, eob-835, denial-appeal | **4 / 16** | 0 | 16 / 16 | 2 / 5 |
| **p2 held-out** | all four | **4 / 16** | 0 | 16 / 16 | 0 / 5 |
| p1 held-out (already seen) | all four | 2 / 14 | 5 | 8 / 11 | — |
| p2 held-out | Presidio 2.2.364 defaults | 2 / 16 | 0 | 8 / 16 | 0 / 5 |

Against the 0.6.0 baseline on the same held-out split (8 / 16), the date-time
fix and the mid-line `Patient:` label take the base detector to 5 / 16; the
packs add one more. Most of the gain is in the base detector, not the packs.

Still surviving on p2 held-out with all four packs:
- a letter reference under a label the pack does not know (`File #:`);
- a lab tracking number (`Tracking SR-…`) and an unlabelled patient name in a
  receiving stamp;
- a patient name after a lower-case `patient` with no colon.

The p1 held-out number (3 → 2) is not clean: its remaining misses were named
in this file before Phase 2 was written, and one of them (`Our ref:`) is now
caught by a label also present in the Phase 2 dev split.

Provider ids: without the pack, 2 of 5 held-out provider ids are still
replaced by the base detector (an EIN-shaped TIN, and a "Dr." name read as a
patient). Packs can only add, so "keep by default" is not fully reached; with
the pack on, every provider id is replaced and labelled `PROVIDER`, not
`PATIENT`. Presidio removes more identifiers on this split (2 / 16) and
destroys half the billing codes and payer names (8 / 16 kept).

## Detector 0.8.0: provider ids kept by default in the base detector

Operator direction 2026-10-06. Rules did not change; the base detector no
longer replaces provider identifiers it used to read as patient data:

- a name after "Dr."/"Doctor" or under a provider label, wherever it recurs;
- an EIN-shaped TIN under a TIN / tax ID label on a line that names a provider.

Always still replaced: a TIN in SSN form, an EIN with no provider on its
line, a provider-looking name that also appears under a patient label or a
patient pack rule, and any signal-proposed span. With `provider-ids` on,
all of them are replaced as `PROVIDER`.

Two pre-existing flaws fixed on the way (both with tests): the "Dr." title
rule absorbed a following field label ("… Adebayo-Klein   NPI"), and its span
was sized by the space-collapsed value, so with repeated spaces the token
ended mid-word. Pack name rules were tightened the same way
(`denial-appeal`, `provider-ids` 0.1.1).

| corpus | packs | survived | preserved kept | provider ids kept |
|---|---|---|---|---|
| p2 held-out | none (0.8.0) | 5 / 16 | 16 / 16 | **5 / 5** (was 2 / 5) |
| p2 held-out | all four | 4 / 16 | 16 / 16 | 0 / 5 (replaced by design) |
| p1 dev | none (0.8.0) | 13 / 26 | 28 / 28 | — |

The p1 dev count rose from 12 to 13 because that split, written before Q1,
labels the ordering provider (`Tomasz Wierzbicki`) as an identifier; it is
now kept by policy. The split is not relabelled, so its hash stands.

Base corpus `accuracy/corpus.mjs` 0.1.0 → 0.2.0: one label changed, no text
("The practice files under TIN 98-7654321" moved from truth to decoys). The
recall experiment's adversarial corpora label four doctors as identifiers;
they now count as survived by design (noted in `REPORT.md`).

Also in 0.8.0 (found while building the lab lead demo): a field label after a
labelled patient name on the same line (`Patient: Name   DOB: …`) was absorbed
into the name token, so the release read `Patient: [PATIENT_001]: …`. The
label is now trimmed off the name. It was over-redaction, not a leak, and was
present since at least 0.6.0. No corpus number moved.
