# @strixgov/governed-egress — Strix Governed AI Egress v0.1

> **STRIX MUST GOVERN THE RELEASE, NOT CLAIM TO BE THE PHI DETECTOR.**
> Detection and transformation are replaceable inputs to the policy decision.
> The security property Strix owns is that prohibited data cannot cross the
> governed boundary and that **the exact artifact authorized is the exact
> artifact released.**

A data-release control placed immediately before external AI execution.
Reference scope: clinical laboratories — prevent PHI from being disclosed to Claude while keeping
documents useful, by de-identifying **before** egress under a payload-bound,
single-use authorization that the egress gate re-verifies byte-for-byte.

**Self-hosted, publish-ready, not yet published.** `"private": true` was
lifted on 2026-09-27 (Elastic-2.0 — free to self-host for your own use;
see `COMMERCIAL.md`). No production callers in the Strix Console and not
registered in the Console kernel; kernel registration is Phase B (below).
Everything here runs air-gapped except the one optional live provider
transport. Publishing is an operator step:
`docs/runbooks/governed-egress-proxy-publish.md`.

## The invariant

```
H(original) ──transform──► H(sanitized) ──verify──► authorize(H(sanitized))
                                                          │
                    gate re-derives H(actual outbound) ───┤ mismatch → DENY
                                                          ▼
                                              transport (provider)
```

- The authorization binds `sha256(JSON tuple)` over **artifact hash, prompt
  hash, provider, service, purpose**. No API path accepts an authorization id
  plus arbitrary content: `releaseThroughGate` re-hashes the actual outbound
  bytes and compares — the substitution attack refuses with the grant
  unspent (possessing the exact authorized bytes *is* the authorized
  release).
- The authorization is **single-use** (atomic claim; a replay or a lost race
  reads `AUTHORIZATION_CONSUMED`), **expiring** (default TTL 5 minutes,
  matching the Strix token model), and consumed **before** the transport
  runs (redeem-before-side-effect).
- For PDF/DOCX/CSV/XLSX/PPTX sources the **released artifact is the extracted
  text** — the scan target and the release target are the same string, so
  content the extractor could not read can never be released unscanned. Tables
  (CSV, XLSX, slide and Word tables) are rewritten as `Header: value` lines
  first, and a value under a name column must be recognized as a name or the
  file is refused. Unreadable, encrypted, image-only, oversized, mistyped,
  hidden or macro-bearing inputs are named refusals; delimited text submitted
  as plain text is refused (`TABULAR_TEXT_UNDECLARED`) until declared
  `text/csv`.
- The **prompt is governed too**: scanned with the same detector (findings
  refuse — a caller can rephrase its own prompt) and hash-bound into the
  authorization, so a post-authorization prompt swap refuses at the gate.

## Three outcomes (spec §2)

| Outcome | When | v0.1 behavior |
|---|---|---|
| `DENY` | policy denies, detection/transform/verify unavailable or failed, destination ineligible, unsupported artifact, identifiers in the prompt | named refusal, provider never contacted |
| `SANITIZE` | sensitive data found and policy allows de-identified release | tokenize → **mandatory independent rescan** → release the sanitized text |
| `ALLOW` | no findings | release byte-identical |

There is deliberately **no** "allow raw PHI to an approved HIPAA AI
environment" in v0.1. The policy shape leaves room for it; the validator
**refuses** `'phi'` in any destination's `allowedData`
(`ALLOWED_DATA_PHI_UNSUPPORTED`) until that compliance surface is actually
designed. Raw PHI never reaches Claude under any configuration this version
can express.

## Module map

```
src/
  artifact/        ingest (txt · pasted text/CSV · PDF · DOCX · CSV · XLSX · PPTX),
                   the shared OOXML container/XML readers, the table linearizer,
                   sha256 forms
  detection/       SensitiveDataDetector seam + the pattern detector (0.8.0) + the stricter-only signal seam (signals.mjs)
                   + the HTTP client for the self-hosted worker (http-signal.mjs; apps/egress-signal-worker/)
                   and its given-name lexicon
  transformation/  ArtifactTransformer seam + entity-consistent tokenizer
  verification/    the mandatory second scan (rescan + original-value check)
  policy/          config-as-code egress policy + the healthcare reference policy
  authorization/   payload-bound, single-use, expiring egress authorizations
  evidence/        evidence log + the egress receipt (no PHI, ever)
  egress/gate.mjs  THE boundary — re-verify bytes, consume, evidence, transmit
  pipeline.mjs     ingest → detect → transform → verify → policy → authorize
  adapters/anthropic/  governedAnthropicDocumentRequest + the Messages transport
demo/              reference walkthrough (air-gap-safe; --check; --html demo UI)
fixtures/          the synthetic patient record (every identifier fictional)
test/              69 tests incl. the spec-§10 bypass matrix + no-PHI proof
```

Detector and transformer are **seams** (spec §5–6): `scan(text)` and
`transform(text, findings)` are injected everywhere, so a stronger detector
(an NER model, a cloud DLP API) replaces the v0.1 pattern detector without
touching the boundary. The verifier takes its own `verifierDetector`
injection so the second scan can run a *different* implementation than the
first — the transformer never grades itself either way.

## Usage

```js
import {
  governedAnthropicDocumentRequest,
  createPatternDetector,
  createTokenizingTransformer,
  createInMemoryAuthorizationStore,
  createInMemoryEvidenceLog,
  HEALTHCARE_REFERENCE_POLICY,
} from '@strixgov/governed-egress';

const result = await governedAnthropicDocumentRequest({
  source: { bytes: pdfBuffer, mimeType: 'application/pdf', filename: 'encounter.pdf' },
  prompt: 'Summarize this encounter.',
  actor: 'analyst@healthcare.example',
  policy: HEALTHCARE_REFERENCE_POLICY,
  deps: {
    detector: createPatternDetector(),
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
  },
  // transport omitted → the real Anthropic Messages API (ANTHROPIC_API_KEY);
  // unset key throws kind 'unconfigured' BEFORE any pipeline I/O.
});

result.decision;         // 'ALLOW' | 'SANITIZE' | 'DENY'
result.disclosureStatus; // 'disclosed' | 'possibly_disclosed' | 'not_disclosed'
result.receipt;          // the §11 receipt — hashes, counts, verdicts; no content
```

The caller never receives the provider client: the transport is invoked only
from inside the gate, on gate-verified bytes.

```
npm test          # node:test, no dependencies (count deliberately not pinned here)
npm run demo      # narrated reference walkthrough, simulated transport, no network
npm run demo:check
npm run demo:ui   # + writes demo/out/demo.html (generated, not committed)
node demo/run-demo.mjs --live   # real Claude call; requires ANTHROPIC_API_KEY
```

The walkthrough shows the whole boundary on one synthetic record: the PHI
document sanitized and released, the four bypass attempts refused at the gate
(tamper, replay, prompt-borne identifiers, a deny-PHI policy), an SSN hidden
from the scanner by full-width Unicode refused `OBFUSCATED_SENSITIVE_DATA`
with the detector's own miss shown beside it, a clean note released
byte-identical, and the run's own evidence log verified, then re-verified with
one entry edited and with one entry deleted. `--check` asserts every one of
those outcomes and exits 1 on any surprise, which is what CI runs.

## Disclosure accounting (a separate axis from execution)

An HTTP-refused provider call still **delivered the payload** — execution
`failed`, disclosure `disclosed`. A timeout may have delivered it —
execution `unknown`, disclosure `possibly_disclosed`, which downstream
accounting must treat as disclosure until shown otherwise. Only a refusal
that provably preceded any I/O reads `not_disclosed`. Collapsing these axes
is how a data-release log understates what left the building.

## Response re-identification (2026-09-26)

The model answers in tokens: `[PATIENT_001] is stable`. The caller who
uploaded the document already knows who `[PATIENT_001]` is, and can now get
that answer back in plain language.

- **The key is caller-held, and nothing stores it.** A sanitized result
  carries `reidentification`: token → original value, plus the hash of the
  exact text that was released. It sits beside the release, **outside**
  `artifact`. It is never written to the evidence log, a receipt, or the
  kernel, and the provider never sees it. A clear document gets `null`. This
  is not a redaction vault: the values leave this package only toward the
  person who supplied them.
- **The key only fits its own release.** `reidentifyResponse` refuses
  `KEY_RELEASE_MISMATCH` when the answer came from a different release, and
  `KEY_MALFORMED` for an unknown version, a duplicate token, a token that is
  not the tokenizer's own grammar, or an empty value.
- **Only exact tokens are restored.** A token the key does not contain (a
  model inventing `[PATIENT_009]`) and a mangled one (`PATIENT_001`,
  `[patient_001]`, `[Patient 001]`) are left as written and **counted**, so
  the reader can see what could not be restored. Guessing a near miss could
  put one person's name where the model meant another.
- **Adapters: opt in with `reidentify: true`.** `response` stays exactly what
  the provider sent; `reidentifiedResponse` has the values restored. The
  release has already happened, so a re-identification problem never becomes
  a refusal: the tokenized answer still returns, with
  `reidentification.error` naming why. One evidence entry,
  `egress_reidentified`, records counts and the release hash only.
- **The console does not use it yet, on purpose.** In the kernel flow the
  person who executes a release may not be the person who uploaded the
  document. `tests/ai-egress-product/reidentification-key-containment.test.ts`
  pins that no console file reads the key until that decision is made.

Proven by `test/reidentification.test.mjs` with the synthetic needles; three
planted defects (dropping the release binding, case-insensitive restore, the
key leaking into `artifact`) each fail it.

## Response scanning (2026-09-26)

The provider only saw tokens, so a clean release should come back as a clean
answer. When it does not, the model introduced something that looks like an
identifier (a guessed name, an invented phone number, a plausible SSN), and
the caller should know before acting on it or passing it on.

- **Opt in with `scanResponse`.** `true` means `flag`: the answer returns
  with `responseScan` beside it (status, categories, count, the answer's
  hash). `{ onFindings: 'withhold' }` drops an answer that has findings.
- **Unknown is not clean.** In `withhold` mode, a scan that could not run
  withholds too. In `flag` mode it is reported `unavailable`.
- **The scan runs before re-identification**, over the answer as the
  provider sent it; the NFKC form is scanned too and the worse count
  governs. A withheld answer is never re-identified.
- **A malformed option refuses before anything is sent.** After release,
  nothing here becomes a refusal: the release has already happened.
- **Evidence:** one `egress_response_scanned` entry with categories, counts,
  hashes, mode and whether the answer was withheld. Never a value.
- **What it proves:** `FINDINGS_BY_DETECTOR_ONLY`. A clean scan means this
  detector found nothing, the same ceiling as the release verification.

Proven by `test/response-scan.test.mjs`; making withhold ignore an
unavailable scan, and dropping the NFKC rescan, each fail it.

## Per-category actions (2026-09-26)

A policy may set an action per detected category under
`dataEgress.externalAI.phi.categories`:

| action | effect |
|---|---|
| `tokenize` (default for any category not listed) | replaced by a consistent token, as before |
| `flag` | tokenized the same way (the released bytes are identical), and the release is marked for review: `flaggedCategories` on the artifact and on the `egress_authorized` evidence entry |
| `block` | any finding of this category refuses the whole document with `CATEGORY_BLOCKED_BY_POLICY`, before anything is transformed; the refusal names the category, never a value |

Every action is at least as strict as the default. **There is no `allow`**: a
value that leaves untransformed would fail the release verification by
construction, and a policy setting that switches the verification off is the
thing this package exists to refuse. The validator rejects `allow` (and any
other action) by name, rejects an unknown category, and reads the map
own-property only. Proven by `test/category-actions.test.mjs`; admitting
`allow`, disabling the block, and reading inherited keys each fail it.

## Synthetic same-type replacement (2026-09-26, local mode only)

`phi.replacement: 'synthetic'` gives the model "Avery Quillfeather,
555-555-0100" instead of "[PATIENT_001], [PHONE_001]". Some answers read
better that way. The release guarantee does not change.

- **Only values that are fictional by definition.** Names come from a fixed
  list of invented names (100 distinct). Phones use 555-555-0100…0199, the
  range reserved for fiction. Emails use `@example.invalid` (RFC 2606). Every
  other category (SSN, MRN, dates, addresses, cards, IDs) keeps its token,
  because a realistic-looking identifier could be somebody's. Past capacity,
  the entity keeps its token too.
- **A generated value that already appears in the source is never used**
  (any case; for names, any name part). That entity keeps its token.
- **Verification (0.4.0) masks exactly the spans the replacer reports it
  generated, for the rescan only.** The original-value containment check
  reads the unmasked release text, so a replacer that misreports a span still
  cannot hide a real value from it (pinned by a test with a lying replacer).
- **Local mode only.** The kernel execute route re-runs the rescan over
  caller-supplied material with no mask, because it cannot trust a caller to
  report generated spans. A synthetic release would be refused there after
  its approvals were spent, so `prepareDocumentForEgress` refuses a synthetic
  policy up front with `SYNTHETIC_REPLACEMENT_LOCAL_ONLY`. The mode is chosen
  by entry point, never by an input field.
- **Deterministic:** the same document releases the same bytes.
- **Re-identification** uses a version 2 key: generated values are restored
  where they appear as whole words, case-sensitively; tokens as before. **The
  response scan** blanks the release's own generated values, so a model
  repeating them is not a finding, while an identifier it invented still is.

Changing verification to 0.4.0 changes the healthcare pack's content address:
the approved pack reads `APPROVED_STALE` until a named person re-approves it.
Proven by `test/synthetic-replacement.test.mjs`; four planted defects
(containment over masked text, no kernel guard, no collision guard, no
response mask) each fail it.

## Drop-in proxy (2026-09-26)

`strix-egress-proxy` speaks the OpenAI Chat Completions
(`POST /v1/chat/completions`) and Anthropic Messages (`POST /v1/messages`)
wire formats, whatever the upstream provider. Point an existing client at it
with the proxy's token as the API key, and every request runs through the
local-mode release: detect, tokenize, verify, authorize once, release, scan
the answer, restore values for the caller.

```bash
STRIX_EGRESS_PROXY_TOKEN="$(openssl rand -hex 24)" ANTHROPIC_API_KEY=... \
  npx strix-egress-proxy --policy policy.json --provider anthropic \
    --evidence-file evidence.jsonl
# then: base URL http://127.0.0.1:8787/v1, API key = the proxy token
```

`strix-egress-proxy init-policy [file]` writes a starter policy
(`examples/policy-starter.json`, shipped in the package): default deny,
de-identify then rescan before release, Anthropic and OpenAI enabled for
de-identified data only. It never overwrites a file. `--help` lists every
option and pack; `--version` prints the proxy and package versions.

- **No pass-through path.** Anything the pipeline cannot govern is refused by
  name with HTTP 400: tools and tool calls (`TOOLS_UNSUPPORTED`), non-text
  content in any turn — images, files, audio, thinking blocks
  (`CONTENT_UNSUPPORTED`), an assistant turn last (`ASSISTANT_PREFILL_UNSUPPORTED`),
  the transcript turn marker inside content (`TRANSCRIPT_MARKER_IN_CONTENT`),
  multiple choices, a model the operator did not allow. Nothing is forwarded
  as-is, and one bad turn refuses the whole conversation.
- **Mapping:** a single user message is the governed document, byte for byte.
  A conversation (v0.2) is rendered as ONE transcript — every user, assistant
  and later system turn — and that transcript is the document: detected,
  tokenized and rescanned in one pass, so one value keeps one token in every
  turn and one key restores the answer. A turn the client already
  re-identified carries raw values again and is governed again; nothing is
  trusted as already governed. A token literal carried in from an earlier
  request (`[PATIENT_001]` that the client kept) is opaque: the proxy holds no
  key between requests, so it is left as written, never restored, counted in
  `strix.conversation.foreignTokens`, and its number is never re-used for a
  new value. The leading system message is the prompt, which is scanned and
  refuses on any identifier. Sampling parameters the governed transport does
  not forward are named in `strix.ignoredParameters`, never silently honoured.
- **Streaming (v0.2):** `stream: true` is accepted in both shapes and returns
  server-sent events the SDKs expect (OpenAI `chat.completion.chunk` + `[DONE]`;
  Anthropic `message_start` … `message_stop`). The provider call itself is
  **not** streamed: the whole answer is received, scanned, withheld or
  re-identified, and only then framed as events. So nothing reaches the client
  before the scan clears it, and a token is never split before it is
  restored. **The cost is latency:** the first event arrives when the whole
  answer is ready, so a long answer shows no progress. A refusal on a stream
  request is a plain JSON error, as the providers do. `streamChunkChars`
  (default 64) sets the text per event.
- **Answers:** 200 with the answer (values restored by default,
  `--no-reidentify` to keep tokens) and a `strix` block (decision, receipt
  id, flagged categories, response-scan and re-identification counts — no
  values). A refusal is 422 with the pipeline's code; a provider failure is
  502 with the disclosure status; `--withhold-on-findings` turns an answer
  containing invented identifiers into 422 `RESPONSE_WITHHELD`.
- **Operation:** the token (32+ characters) and the provider key come from the
  environment only; `--token` on the command line is refused. It binds
  loopback unless `--tls-cert`/`--tls-key` are given. A missing provider key
  refuses the start. The log is one line per request (method, path, status),
  never a body. `--evidence-file` appends the hash-chained evidence records
  as JSONL; they carry hashes, categories and counts only. Add
  `--signing-key-file` to sign them (see "Signed evidence").

Proven by `test/proxy.test.mjs` and `test/proxy-conversation.test.mjs` over
real HTTP with a fake provider. Accepting any token and dropping the
ignored-parameter report each fail the first; re-minting a carried-in token,
governing only the last turn, splitting a token across stream events, and
streaming before the refusal check each fail the second.

## Signed evidence (2026-09-28)

The hash chain alone proves internal consistency only: whoever can edit the
evidence file can rebuild a self-consistent chain. With a signing key, every
record is also signed (Ed25519) with a key **the customer generates and
holds**. Strix never sees it, and signing and verification make no network
call.

```bash
npx strix-egress-proxy keygen --private-key-out egress-key.pem --public-key-out egress-key.pub.pem
STRIX_EGRESS_PROXY_TOKEN=... ANTHROPIC_API_KEY=... \
  npx strix-egress-proxy --policy policy.json --provider anthropic \
    --evidence-file evidence.jsonl --signing-key-file egress-key.pem
# or pass the PEM in STRIX_EGRESS_SIGNING_KEY (containers)

npx strix-egress-verify-evidence evidence.jsonl --public-key egress-key.pub.pem
# exit 0 VERIFIED · 1 INVALID · 3 UNVERIFIABLE (key not supplied) · 2 usage
```

- **Format (scheme `strix-egress-evidence-ed25519-v1`).** Each record gains
  `signingKeyId` (inside the hashed content) and `signature` (beside it):
  base64url Ed25519 over the UTF-8 string
  `strix-egress-evidence-ed25519-v1\n<signingKeyId>\n<entryHash>`. The key id
  is `egress-` plus the first 32 hex characters of sha256 of the raw 32-byte
  public key, so it is derived, never chosen. The input is a plain string so
  a reader can check a signature with OpenSSL alone (`openssl pkeyutl -verify
  -pubin -inkey key.pub.pem -rawin -in input -sigfile sig`); a test does
  exactly that.
- **What VERIFIED means.** Every record was recorded by the holder of a key
  the reader trusts and none was changed, reordered or removed from the
  middle since. Result fields: `proves: 'SIGNED_BY_KEY_HOLDER'`,
  `completeness`.
- **What it does not mean.** It does not prove the key holder was honest,
  that the detector found every identifier, or that no record was cut off
  the **end** of the file: a truncated log still verifies
  (`completeness: 'NOT_PROVEN'`). Pass `--expect-head <entryHash>` with a
  head obtained separately (for example sent to your SIEM or your auditor)
  to catch that (`HEAD_MATCHED`).
- **Where the key lives decides what it proves.** Keep the private key where
  the people who can edit the evidence file cannot read it (a secret store
  mounted only into the proxy). A key readable by the same people proves
  little more than the chain.
- **Refusals over guesses.** Unsigned records inside a signed log, a malformed
  signature, a key the reader did not supply (`UNVERIFIABLE`, never
  `INVALID`), and an empty log are all refused, never passed. The proxy
  refuses to start with a signing key but no `--evidence-file`, and refuses
  to append to an existing file that does not verify.
- **Restarts and rotation.** A restarted proxy continues the existing file's
  chain rather than starting a second `genesis` inside it (which made the
  whole file fail verification before this change). A new key simply
  continues the chain; verify a rotated file with every public key it was
  signed under.

Proven by `test/signed-evidence.test.mjs`, including the attack the chain
alone cannot see: a record edited and the whole file re-chained without the
key passes `verifyEvidenceChain` and fails `verifySignedEvidence`. Disabling
the signature check, ignoring `--expect-head`, accepting unsigned records,
and skipping signature checks on restart each fail that suite.

## Claude Code prompt hook (2026-09-27)

`strix-egress-prompt-hook` is a Claude Code `UserPromptSubmit` hook. It runs
this package's detector over each prompt **locally**, before Claude Code sends
it, and blocks a prompt with detected identifiers (exit 2). It reports
categories and counts only — never a matched value, never the prompt.

```bash
npm install -g @strixgov/governed-egress
strix-egress-prompt-hook init          # this project's .claude/settings.json
strix-egress-prompt-hook init --user   # ~/.claude/settings.json
strix-egress-prompt-hook init --print  # print the merged JSON, write nothing
```

`init` merges one entry and is idempotent. The equivalent settings snippet:

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [
  { "type": "command", "command": "node \"/path/to/bin/strix-egress-prompt-hook.mjs\"" }
] } ] } }
```

- `STRIX_EGRESS_HOOK_MODE=warn` lets the prompt through and shows the user a
  `systemMessage` (nothing is added to the model's context). Any other value
  than `block` or `warn` blocks — a typo never turns enforcement off.
- Unreadable hook input, a detector failure, or a broken install **block**
  (exit 2). A hook that cannot read the prompt cannot say it is clean.
- Ceiling: a pass means **no findings by this detector**
  (`NO_FINDINGS_BY_DETECTOR`). A name with no label and no marker word can
  pass. The hook does not govern what Claude Code reads from files or tools.

## Per-entity accuracy (2026-09-26)

[`accuracy/REPORT.md`](accuracy/REPORT.md) is generated by
`node accuracy/run.mjs` over a labelled corpus covering all twelve categories
(`accuracy/corpus.mjs`), plus the recall experiment's adversarial corpora.
For each category it reports detection, how many values **survived into
released text**, and decoys flagged. `test/accuracy-report.test.mjs` fails if
the committed report differs from a regeneration, so a number cannot be
edited by hand or go stale.

The first run (detector 0.5.0) named real gaps: ISO dates (`2025-11-03`),
two-digit-year dates, PO boxes, and unlabelled names, MRNs, dashless SSNs and
member IDs survived release, 8 of 43. Detector 0.6.0 closes those forms; the
report now shows 0 of 43. Because the rules were written against that corpus,
a second, **held-out** corpus (`accuracy/corpus-heldout.mjs`) was committed
before the 0.6.0 rules existed, and its 0.5.0 baseline (9 of 10 surviving) is
in git history beside the 0.6.0 result (0 of 10). Both corpora are invented
and written by the detector's author, so they are regression instruments and
maps of known gaps, not an independent benchmark. The adversarial hard cases
(names and accounts with no marker at all) are unchanged by 0.6.0 and still
survive.

## 360-review hardenings (2026-09-03)

A post-build adversarial review probed the running package and closed four
gaps, each red-proven (`test/hardening-360.test.mjs`; probe record:
`../../docs/reviews/governed-egress-360-2026-09-03.md`):

- **The boundary enforces the policy it validated.** `validateEgressPolicy`
  now returns a deep-frozen snapshot and the pipeline reads decisions only
  from it — a caller-injected async dep that mutated the live policy object
  mid-flight could previously launder a validated `deny` into `sanitize`.
  (API change: the function returns the snapshot, not `true`.)
- **Unicode-obfuscated identifiers refuse by name.** The boundary scans the
  NFKC-normalized text with the same configured detector; findings that
  normalization REVEALS are `OBFUSCATED_SENSITIVE_DATA` — never a sanitize,
  because normalized offsets cannot be safely mapped back onto the raw text
  the transformer rewrites. Benign ligatures (`ﬁnal`, `ﬂuid` — routine in
  PDF extraction) do not refuse; only a reveal does. The verifier applies
  the same rule at the last gate before release.
- **Decompression bombs refuse `ARTIFACT_TOO_LARGE`.** The 10 MiB wire cap
  was insufficient alone: a 204KB DOCX legally inflated to ~400MB in-process.
  A 64 MiB TOTAL inflated-content budget is now enforced at every inflate
  call via zlib's own `maxOutputLength` (the allocation never happens), and
  exceeding it is a named refusal, never a truncation.
- **The evidence log is hash-chained.** Each record carries
  `prevHash`/`entryHash`; `verifyEvidenceChain` re-derives every link, so an
  edited, removed, or reordered entry is detectable from the log alone. The
  verdict carries `proves: 'INTERNAL_CONSISTENCY_ONLY'` as a literal field —
  the log is unsigned and locally held, so a re-chained substitute verifies
  clean by construction (pinned by test so the ceiling cannot be "fixed"
  away). Signing is Phase B. *Updated 2026-09-28:* self-hosted signing now
  ships; see "Signed evidence". This function's ceiling is unchanged; the
  signed check is `verifySignedEvidence`.

## Claim ceilings — read before quoting anything above

- **The pattern detector (0.8.0) is a deterministic baseline, not a PHI
  guarantee.** 0.7.0 adds times tied to a patient date or a collection label,
  and `Patient:`-style labels that start mid-line. 0.8.0 KEEPS provider
  identifiers by default (doctors' names, provider-labelled names, provider
  TINs in EIN form); a deployment that must remove them turns on the
  `provider-ids` pack. That default rests on HIPAA Safe Harbor not requiring
  provider names; counsel should confirm it for each customer. 0.5.0 added no rule: it lets an optional detection signal (a
  local model) propose spans as seeds, which only ever add findings; no signal
  is configured in any production deployment. 0.6.0 adds ISO and
  two-digit-year dates, PO boxes, and bare SSNs, chart numbers, member IDs and
  names that a word in the same sentence marks as one ("gave social …",
  "chart #…", "payer rejected …", "spoke with …"). It finds labeled fields (on the label's line, or below it with
  up to three blank lines between), SSN/phone/email/address/date shapes,
  check-digit-valid payment cards and IBANs, EIN-shaped tax IDs, unlabelled
  names that start with a common given name (`src/detection/given-names.mjs`),
  and names and accounts a nearby word marks as one: a title ("Dr. Varga"), an
  initial ("J. Okafor"), a sign-off line, "the X family", and a digit run after
  a money-movement phrase ("wire the refund to …"). Every found name is
  propagated, including onto other uses of the same word ("Lincoln Medical
  Center" after "Dr. Lincoln"), which over-redacts by design. Free-text
  identifiers outside those shapes can still pass it: an unlabelled name with
  no marker whose given name is not on the list or is an ordinary word
  (Grace, Will), a possessive surname ("Varga's bill"), an unlabelled
  non-Latin name, an account number with no label and no money-movement
  phrase, and anything that needs judgement of meaning. That is exactly why detection is a replaceable seam
  and why the property Strix claims is release governance, not detection
  completeness. `VERIFICATION_PROVES = 'NO_FINDINGS_BY_DETECTOR'` is a
  literal field on every verification result so no surface can round it up.
- **The receipt is a LOCAL UNSIGNED RECORD** (`proves:
  'LOCAL_UNSIGNED_RECORD'`, a literal field): produced by the same process
  that performed the release, it identifies the artifact, policy, decision,
  destination and outcome — it does not prove them to a third party.
- **Signed evidence proves who recorded it, not that it was right**
  (`proves: 'SIGNED_BY_KEY_HOLDER'`, `completeness: 'NOT_PROVEN'` unless an
  independently obtained head matched). The key is the customer's own; a
  third party trusts it only as far as they trust the customer's key custody.
- **The in-memory authorization store asserts single-process semantics
  only.** The atomic claim holds under JS run-to-completion; multi-process
  deployment needs a durable claim-by-INSERT store (the CN-7 construction) —
  Phase B.
- **Tokenization is not reversible by anyone**: no token→value map is
  persisted or returned (mappings carry category + token only, proven by
  test). A consumer needing re-identification is out of scope for v0.1.

## What is deliberately NOT built (spec §15)

No general DLP platform, no active OCR path (a governed, local-only OCR seam
exists with no engine registered), no audio/video/archives, no legacy
.xls/.ppt/.doc, no ML/NER detection engine, no reversible redaction vault (re-identification
uses a caller-held key; see above), and
no claim wording beyond this README. *Updated 2026-09-24:* spreadsheet and
slide intake (CSV, XLSX, PPTX) now ships; an OpenAI transport ships beside the
Anthropic one; and the kernel binding (`releaseUnderKernelAuthority`) is used
by the console's v1 execute route, whose Ed25519-signed decision receipt
carries this package's evidence-chain head. The per-release evidence entries
themselves are still not persisted or signed. *Updated 2026-09-28:* in
self-hosted mode they can now be signed with a customer-held key and
persisted with `--evidence-file`; see "Signed evidence".

## Evidence privacy (spec §4)

The evidence system stores hashes, classifications, detector name+version,
categories, counts, policy ids, transformation results, destination,
decision, timestamps, actor and receipt ids — **never document content,
finding values, prompts, or token maps**. `test/evidence-no-phi.test.mjs`
proves the negative with real needles: every synthetic identifier is first
shown present in the source, then shown absent from every evidence entry,
receipt, and released byte, across the sanitize, deny, and gate-refusal
paths. The check is red-proven (a planted leak fails it by name).

## Phase B — the kernel is the authority (BUILT, dormant)

v0.1 shipped its own payload-bound single-use grant. That was the right
shape for a package with no kernel and the wrong thing to keep once there
is one: two mechanisms that can each permit an egress is a parallel
authorization system, which the Gate-D scope law forbids. So Phase B does
not add a second path — it moves the authority.

**The canonical egress commitment** (`src/commitment/egress-commitment.mjs`)
is what a decision actually commits to. Signing "Claude send approved"
commits to nothing checkable: it names no bytes, no destination, no
verification outcome, so any later payload satisfies it. The commitment is
17 locked fields content-addressed as a JSON array of `[key, value]` pairs
(an array, because object key order is a property of the writer), with
`canon` as field zero and covered by the hash — an unknown canon FAILS
rather than being re-interpreted under v1 rules.

Where each field comes from is the security property, not the field list.
There are exactly two sources and the caller is neither:

| source | fields |
|---|---|
| **derived at the gate** from the actual outbound material | `releasedArtifactHash`, `promptHash`, `provider`, `service`, `verificationResult`, `verificationProves`, `remainingProhibitedFindings` |
| **authority** — the redeemed decision's frozen `actionParams` | `capability`, `tenantId`, `environment`, `actor`, `policyId`, `policyVersion`, `purpose`, `initialClassification`, `releasedClassification` |

`initialClassification` is the one field honestly NOT re-derivable at the
gate — the gate sees only the released bytes, never the original document —
so it is authority-sourced, recorded here rather than quietly sourced.

**The gate** (`src/egress/kernel-gate.mjs`) is the choke point. It takes
signed authority plus the actual outbound material and reconstructs the
commitment ITSELF. The property is not "it checks a hash", it is what it
refuses to be told:

- `verified: true` — the second scan is RE-RUN over the exact bytes about
  to be transmitted. There is no parameter to put a verification claim in.
- an artifact hash — recomputed here from the bytes themselves.
- a classification — read from the frozen params, never from the call.
- a destination — read from the ADAPTER'S OWN identity. A caller naming a
  destination would be describing a route it does not control.

A structural test asserts those four parameter names are absent from the
gate's input surface. The absence is the control.

**The binding** (`src/kernel/production-binding.mjs`) translates a redeemed
decision into that authority and decides nothing. It refuses to REPRESENT
authority that does not exist — wrong state, unredeemed token, wrong
tenant, wrong capability, unusable frozen params — and it never trusts a
stored `commitmentHash`: it re-derives from the frozen fields and refuses
on disagreement. `capability` is read from the decision's own `actionType`
rather than a params field, so a params field claiming a different
capability cannot survive.

**The chain-head anchor.** The local hash chain proves internal consistency,
not authenticity: a party who can rewrite one entry can re-chain them all.
`receiptResultForSignedEvidence` hands the chain's committed HEAD to
`DecisionService.postReceipt`, so ONE signed anchor gives the whole local
log external authenticity without minting N signed artifacts or widening a
frozen schema. A verifier reads the head out of the signed evidence, runs
`verifyEvidenceChain` over a presented log, and compares. A rewritten log
re-chains cleanly and its head no longer matches — which the chain alone
could never have told anyone. A failed outcome-evidence write yields a
`null` head, which is honest; a fabricated one would be worse than none.

### Verified

`test/phase-b-kernel.test.mjs` — 30 tests. The centrepiece repeats the
substitution attack against the kernel-bound implementation: Strix approves
the sanitized artifact, the original synthetic PHI is put back into the
outbound payload, and the gate refuses `COMMITMENT_MISMATCH` naming
`releasedArtifactHash` while an Anthropic-shaped transport spy proves ZERO
invocation — proven by counting calls, never by reading a status. Removing
the comparison was run as a probe: the substituted PHI then reaches the
provider with an `ALLOW / completed / disclosed` verdict, which is what
makes the passing case evidence rather than assertion. A refused
substitution deliberately does NOT consume the grant — an attacker cannot
succeed without the exact bytes, and possessing them IS the authorized
release.

### Still not done — what registration would take

1. Register `ai.external.document.send` in `GOVERNED_ACTION_TYPES` +
   `policy.ts` with a secret-free param allowlist (tier decision at
   registration; the id is provider-neutral by design — the provider is
   context, per the capability scope law). The policy `VERSION_LABEL` is a
   gated file: a bump needs a matching `approved-hashes.json` approval,
   which is operator-held.
2. Register the egress route in the Console's irreversible-route registry
   behind `requireDecisionToken`, with a closed caller allowlist.
3. Run the first real Anthropic execution against synthetic PHI, and only
   then replace the demo's `LOCAL_UNSIGNED_RECORD` ceiling with whatever
   the signed evidence actually proves.

Until then the kernel binding stays dormant: the capability is registered
nowhere, nothing in the Console imports it, and no request has been made
to a provider through it. (Lifting `"private": true` on 2026-09-27 for
the self-hosted proxy changes none of this.)


## Optional second detector

`strix-egress-proxy --signal-config worker.json` adds the self-hosted signal
worker (`apps/egress-signal-worker`) as a stricter-only second detector: it can
add spans to redact, never remove one the pattern detector found. The config
holds the worker `url` (https, or http to loopback) and the pinned `expected`
identity (name, version, model, revision, weightsSha256, threshold). Set the
bearer token in `STRIX_SIGNAL_TOKEN` (32+ characters), never on the command
line. If the worker's identity differs from the pinned one, the request is
refused. Measured results with and without it, and against Presidio, are in
`accuracy/COMPARISON.md`.

## Latency

`node accuracy/latency.mjs` times pattern detection on this machine. It does
not include the signal worker or a provider call.

## Comparing redaction tools

`node accuracy/benchmark.mjs --cmd "<your redactor>"` scores any tool that
reads text on stdin and writes redacted text on stdout, using the same
corpora and scoring as `--strix`. See `accuracy/COMPARISON.md`.

## Lab detection packs

`--pack lab-requisition` and `--pack eob-835` (or
`createPatternDetector({ packs: [...] })`) add label- and X12-anchored rules
for accession, specimen and requisition numbers, patient account and claim
control numbers, and patient names in `pt` fields and `NM1*QC` segments.
`--pack denial-appeal` adds letter reference and case numbers, claim numbers
in appeal prose, and patient names in salutations, `Re:` lines and patient
signatures. `--pack provider-ids` is a policy choice: provider identifiers
are kept by default, because they identify the provider, not the patient.
Since detector 0.8.0 the base detector keeps a doctor's name ("Dr. Varga"), a
name under a provider label, an NPI, and an EIN-shaped TIN on a line that
names a provider; turning the pack on replaces all of them with
`[PROVIDER_nnn]` tokens. A TIN in SSN format, an EIN with no provider on its
line, and a provider name that also appears as the patient are always
replaced.

Detector 0.7.0 also treats a time tied to a patient date as part of that date
(`09/14/2026 07:42` becomes one token) and a time under a collection label
(`Collection time: 0630`) as a date element. Lab hours and schedules are kept.
Packs only add findings, are bound to the detector so the verification rescan
uses them too, and are named with a rule hash in the detector info. Measured
results, including what still gets through, are in
`accuracy/lab-packs/HASHES.md`.
