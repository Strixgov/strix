# GitHub MCP demo — claims and scenario matrix

The matrix below is the boundary for any sales or pilot language. “PASS” means the named behavior is reproduced in the local synthetic harness; it does not mean GitHub was contacted. `BLOCKED` means the requested exact-merge behavior is not implemented in the published Strix path. Partial lower-level tests do not upgrade that status.

| ID | Scenario | Result | Evidence / boundary |
|---|---|---|---|
| GH-01 | Read repository information | **PASS — fixture only** | A GitHub-pack read traverses the published proxy and returns the local fixture's contents. The signed receipt and fixture call log are captured. No real repository is read. |
| GH-02 | Unauthorized PR merge | **PASS — intercepted** | `merge_pull_request` is explicitly denied; the fake upstream's merge invocation count remains zero. The DENY receipt is interception evidence, not evidence of a GitHub merge attempt. |
| GH-03 | Request approval for an exact PR merge | **PASS — held, then denied** | The signed-approval file contains the named capability and exact supplied owner/repo/PR/method arguments. While pending, the merge handler has zero invocations. The synthetic reviewer denies it; no merge occurs. |
| GH-04 | Execute exactly the approved merge once | **BLOCKED** | No merge execution is attempted. The published MCP proxy is Mode 1/2; Mode 3 execution-token enforcement is not wired. The existing full-head-SHA merge PEP is source-reference-only with injected dependencies and unsigned result, has no production caller, and the official GitHub MCP merge surface lacks the required atomic `sha` precondition. |
| GH-05 | Change repository, PR, target branch, or action arguments after approval | **PARTIAL / BLOCKED for merge** | Distinct owner/repo/PR/method requests require distinct approval request IDs; no merge invocation is made. The official merge tool does not accept a target-branch/head-SHA precondition, and no integrated single-use execution grant exists to test all mutations. |
| GH-06 | Reuse a consumed approval | **PARTIAL — approval-file layer** | A successful signed approval for a synthetic `create_branch` fixture call is consumed; a repeat call with identical arguments creates a new request and remains held until separately denied. This does not establish replay defense for an execution grant or a merge. |
| GH-07 | Race two calls against one approval | **PARTIAL — approval-file layer** | Two concurrent fixture writes get distinct request IDs. Approving one and denying the other yields at most one fixture handler invocation. This is not a test of the missing atomic execution-token redemption path for GitHub merge. |
| GH-08 | Unclassified destructive GitHub tool | **PASS — intercepted** | The fake upstream advertises `delete_repository`, absent from the GitHub capability pack; default-deny refuses it with zero upstream calls. This is a fixture classification test, not a live catalog parity audit. |
| GH-09 | Policy, gateway, or approval-store unavailable | **PARTIAL — fail closed at tested boundaries** | Invalid policy configuration is rejected before dispatch; an unusable approval request directory fails closed with zero downstream calls. The gateway is in-process, not a separately deployed service, so a remote gateway outage cannot be simulated in this architecture. |
| GH-10 | Tamper with signed evidence | **PASS — published verifier 1.24.1** | The independent published verifier accepts the untampered receipt chain and rejects a one-byte/field-tampered copy. Current repo verifier 1.24.2 is unpublished and not used. |
| GH-11 | Restart and verify persisted receipts | **PASS — local persistence** | The proxy restarts against the same temporary storage and key; prior receipts remain in the chain and the published verifier checks it. This is a local file-store test. |
| GH-12 | Direct-route bypass / coverage boundary | **LIMITATION DEMONSTRATED** | A test client calling the in-memory upstream directly bypasses proxy policy and creates no Strix receipt. No GitHub credential is available in the test estate. Guard coverage of configured client entries is not proof that all credentials or direct routes are blocked. |

## Safe wording

Supported wording: “In an isolated local MCP fixture, the published proxy allowed a classified read, denied an unauthorized merge before the fake upstream, held an approval request over its exact supplied arguments, produced signed receipts, and detected tampering with its published verifier.”

Unsupported wording: “Strix securely merged a GitHub PR,” “the merge was bound to the live head SHA,” “GitHub executed the operation,” “all GitHub routes are intercepted,” or “the demo proves production single-use authorization.” No live GitHub call occurred, and the exact merge execution flow remains blocked.

## Release blockers

1. Wire the production single-use, payload-bound authorization lifecycle into the MCP path without creating a second authority, signer, policy engine, or gateway.
2. Bind a trusted actor and tenant plus capability, repository, PR, target branch/head SHA, policy revision, and expiry to the authorization; redeem it atomically before the side effect.
3. Use a GitHub merge primitive that carries the approved full head SHA as a provider-side precondition; the current official MCP `merge_pull_request` shape does not.
4. Publish and audit the intended verifier 1.24.2 artifact. Current npm latest is 1.24.1; 1.24.2 returns E404.
5. Repair the published MCP adapter test artifact: 0.1.4's package `test` script references `scripts/preflight.mjs`, which its tarball omits, and ships no tests.
6. Establish source-build provenance for the published Strix tarballs before making a source-to-artifact assurance claim. npm registry signatures verified; no provenance attestation was found for the five audited Strix packages.
7. Run any provider-side moved-head exercise only with an explicitly authorized disposable GitHub target and a real audit trail. This task performed no live provider exercise.
