# Demo Safety Boundary — RCM Governance Proof Kit

**Status:** Binding for everyone who builds, runs, or films this demo.
**One rule:** The demo uses real protocols and real code. It never touches a live production payer, clearinghouse, or EHR — and never uses real patient data.

---

## Why this document exists

The proof kit deliberately makes a prior-authorization agent **misbehave** —
duplicate a submission, exceed its instructed scope, or act on an injected
instruction — and shows Strix stopping it at execution. That is valuable
*only* if every misbehaving action lands inside an environment we are
authorized to break. Pointed at a live system, the same runs would be
deliberately injecting erroneous, duplicate, or out-of-scope transactions
into real healthcare infrastructure. This document draws the line so the
asset stays credible **and** defensible.

## The bright line

> **Real protocols, real code, real API _shapes_ — yes.**
> **Live production payer / clearinghouse / EHR endpoints in any filmed
> scenario — never.**

## Allowed

- Genuine standards and message formats — X12 278/275/837, FHIR R4.
- Real code, real auth flows, real validation logic, production-grade
  architecture that mirrors what a vendor actually runs.
- **Synthetic patients only** (Synthea-generated or equivalent). No real
  names, member IDs, SSNs, DOBs, or clinical records — ever.
- Outbound calls to **sandbox / certification endpoints** that are
  authorized for test traffic (e.g., clearinghouse test environments,
  payer certification endpoints, Epic on FHIR / SMART Health IT / Cerner
  FHIR sandboxes).
- A **mock payer adjudicator we own** for the "consequence" beat (denial,
  duplicate flag, recoupment). The damage in the ungoverned clip is *our*
  endpoint reacting — not a third party's.
- **Real Strix enforcement** on the governed path. This is the one component
  that must be genuine; it is ours to run, so it carries no third-party risk.

## Forbidden

- Submitting any transaction into a **production** payer adjudication system
  or a **production** clearinghouse account.
- Using a **real provider NPI** or **real submitter ID** to transact with a
  real payer (impersonation / misattribution risk).
- Any **real patient data**, even "just for realism." Synthetic only.
- **Naming or targeting** a specific vendor's or payer's live system in the
  footage. Architecture is recognizable and generic; no real logos, no real
  endpoints on screen.
- Reusing **production credentials** of any kind in the demo environment.

## Default-safe configuration

- `RCM_TARGET=mock` is the default and the only target used for filming.
- `RCM_TARGET=sandbox` is permitted **only** against an endpoint explicitly
  cleared for test traffic, and only after the trading-partner / EDI terms
  for that sandbox have been read. It is never the filming default.
- There is **no** `production` target. The codebase must not contain a code
  path that points the "veer" scenarios at a live payer.

## Residual-risk notes (read before any `sandbox` run)

- A sandbox is still a real API. Confirm its terms permit intentionally
  malformed / duplicate / out-of-scope test traffic before running the
  failure scenarios against it.
- Synthetic identifiers can accidentally collide with real ones. Generate
  patient + provider identifiers from reserved/test ranges where the
  standard provides them.
- Legal note: the trading-partner-agreement and EDI-companion-guide angles
  warrant a short review by counsel before *anything* goes near a
  non-mock endpoint. This document is an engineering boundary, not legal
  advice.

## Sign-off

Anyone recording footage confirms, per take, that `RCM_TARGET=mock` (or a
cleared sandbox) and that no real patient or provider identifiers are present.
If either is uncertain, do not run.
