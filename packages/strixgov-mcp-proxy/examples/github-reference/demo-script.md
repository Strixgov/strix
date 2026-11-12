# Two-minute demo script — limited synthetic fixture

**State the boundary first:** “This runs against an in-memory GitHub-shaped MCP fixture with no GitHub credential, network access, or repository mutation. It shows the published proxy's current policy/approval behavior; it does not execute or simulate a successful PR merge.”

**0:00–0:20 — Show the published stack.** In a clean external consumer, run `npm ci --ignore-scripts` and `npm test`. Point to the pinned lockfile and `environment-manifest.json`, which record exact published versions and runtime.

**0:20–0:45 — Show interception.** The fixture read is explicitly allowed. The merge request is explicitly denied; the fake upstream invocation log shows zero merge calls. Then a second merge request is held with its exact owner, repository, PR number, merge method, and request hash recorded; a synthetic reviewer denies it, still with zero downstream merge calls. Call the signed receipt what it is: evidence of the intercepted decision, not proof of a GitHub operation.

**0:45–1:15 — Show a harmless approved fixture action.** A separate synthetic `create_branch` request is approved by the encrypted local Guard key and reaches only the in-memory handler. The fixture logs a synthetic write. The published verifier checks the signed execution outcome against the corresponding authorization receipt; that proves the local fixture path, not a GitHub branch.

**1:15–1:35 — Show replay and race controls.** Repeating the same fixture call yields a new approval request and is denied. Two concurrent identical fixture calls produce distinct requests; one synthetic approval and one denial result in exactly one fixture invocation. Label these as approval-file-layer tests, not proof of atomic single-use merge authorization.

**1:35–1:50 — Show independent verification.** `verifier-chain.stdout.txt` reports the persisted receipt chain valid. The altered receipt copy is rejected, and `execution-outcome-verification.json` records signature, hash, and receipt-link verification for the synthetic fixture outcomes.

**1:50–2:00 — State the blocking dependency.** “We are not claiming exact GitHub merge execution yet. The published proxy does not enforce Mode-3 single-use authorization, and the official merge-tool input lacks an atomic full-head-SHA precondition. The buyer-safe claim and the exact next steps are in `claims-matrix.md`.”

This is a reproducible, evidence-backed partial demonstration. It is not the complete commercial merge story requested in the engineering directive, and it does not make the work pilot-ready or production-ready.
