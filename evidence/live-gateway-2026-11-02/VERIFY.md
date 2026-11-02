# Live gateway run, 2026-11-02: how to check it yourself

This folder is a copy of one retained run of `release-gate-live-gateway-check.mjs` against the real Anthropic Messages API
(model `claude-haiku-5-5`): 6 checks passed, 0 failed, 0 inconclusive. Only invented values were used
(a made-up name, member ID and date of birth). No real person or document is involved.

You do not need access to any repository to check it.

## 1. Check the files are the ones recorded

PowerShell (Windows):

    cd path\to\this\folder
    Get-Content SHA256SUMS | ForEach-Object {
      $h,$f = $_ -split '\s+\*?',2
      $a = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
      "{0}  {1}" -f ($(if ($a -eq $h) {'OK    '} else {'FAILED'})), $f }

macOS / Linux:

    sha256sum -c SHA256SUMS      # or: shasum -a 256 -c SHA256SUMS

Every line should read OK.

## 2. Check the report against the captured bytes

`report.json` lists the SHA-256 and byte count of every request and response. Hash `request-1.json` (and the others) the
same way and compare with the report's `requestSha256` / `responseSha256` values.

## 3. See what left the gateway

Open `request-1.json`. It is the exact body sent to the provider. It contains tokens such as `[PERSON_1]`, not the invented
values. `response-1.json` is what came back.

## What this shows, and what it does not

**Checkable from the files in this folder** (checks 1, 2 and 6 in `report.json`):
- the provider accepted the forwarded request (HTTP 200, `response-N.json`);
- what left the gateway held tokens such as `[PERSON_1]`, not the invented values (`request-N.json`);
- the model's answer repeats those tokens (`response-N.json`).

**Recorded in `report.json` only, not checkable from these files** (checks 3, 4 and 5): that the values were restored for the
client, that a blocked category was refused before any call left (HTTP 422, zero upstream calls), and that the run logs
verified and held no value or key. The client-side answer, the refused request and the logs were not retained, so these three
rest on the script's own report.

Scope: one model, the Messages route, non-streaming, text only, three invented values. The two captured requests are
byte-identical (same hash); the two responses differ. The `thinking` blocks in the responses carry opaque provider signatures.

Does not show: behaviour with real documents, other models or routes, streaming, an accuracy rate, or anything about payer or
clinical outcomes. Nothing here lets you confirm the calls reached `api.anthropic.com` rather than a stand-in, beyond the
provider's own message ids. The SHA-256 list proves the files are unchanged since they were recorded; it does not prove who
ran them or when, and hosting this folder publicly does not add that proof. `VERIFY.md` itself is not hash-pinned.
