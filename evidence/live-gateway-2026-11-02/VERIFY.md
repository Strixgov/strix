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

Shows: for one model, the Messages route, non-streaming, text only and three invented values, the provider received
tokens rather than values, the values were restored for the client, a blocked category was refused before any call left,
and the run logs verified and held no value or key.

Does not show: behaviour with real documents, other models or routes, streaming, an accuracy rate, or anything about
payer or clinical outcomes. The SHA-256 list proves the files are unchanged since they were recorded; it does not by itself
prove who ran them or when. Hosting this folder somewhere public does not add that proof either.
