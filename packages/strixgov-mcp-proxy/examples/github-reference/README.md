# GitHub MCP reference demo — local fixture only

This demo composes the published Guard configuration surface, GitHub capability pack, MCP proxy, MCP adapter, tool gateway, and offline verifier against an in-memory MCP server. It never starts the GitHub MCP server, never reads a PAT, and never contacts GitHub. Its fixture data and `create_branch` outcomes are synthetic and must not be presented as GitHub activity.

The run demonstrates safe reads, a denied merge with zero downstream calls, a held/denied merge approval request, exact signed file approvals for harmless fixture writes, default-deny behavior for an unclassified destructive tool, persistence across proxy restart, independent receipt verification, and tamper detection. It also explicitly records that direct calls to an unwrapped upstream are outside the proxy's coverage.

## Run in a fresh consumer outside the repository

From a shell with Node.js 18 or newer and npm:

```sh
REPO=/path/to/strix-platform
CONSUMER="$(mktemp -d)"
cp "$REPO/packages/strixgov-mcp-proxy/examples/github-reference/package.json" \
   "$REPO/packages/strixgov-mcp-proxy/examples/github-reference/acceptance.mjs" \
   "$CONSUMER/"
cp "$REPO/packages/strixgov-mcp-proxy/examples/github-reference/package-lock.json" "$CONSUMER/"
mkdir -p "$REPO/docs/evidence/github-mcp-reference-demo/run"
cd "$CONSUMER"
npm ci --ignore-scripts
STRIX_EVIDENCE_DIR="$REPO/docs/evidence/github-mcp-reference-demo/run" npm test
```

`npm ci` installs the exact versions in the lockfile. The run writes sanitized scenario results, published package versions, policy and capability revisions, exact approval requests and signed responses, consumption status, signed proxy receipts and execution outcomes, the public verification JWK, fixture invocation/outcome logs, independent verifier output/exit codes, and SHA-256 sums under `STRIX_EVIDENCE_DIR`. Private keys and the temporary Guard approver key stay under a temporary OS directory and are deleted after the run. The actual run should be performed from a temporary consumer, not by installing into the repository workspace.

The generated JSONL receipt chain is verified by the installed `@strixgov/verifier@1.24.1` artifact. Its tampered copy must fail verification. The current repository's verifier 1.24.2 is source-only and is not installed or claimed here.

## What this demo does not establish

It is not an end-to-end GitHub integration or a production merge exercise. The published proxy is Mode 1/2: it enforces policy and signed file approvals, but it does not enforce the Mode-3 execution authorization token. The existing `github.pr.merge` PEP is reference-only and has no production caller; the official MCP `merge_pull_request` tool shape lacks a provider-side atomic head-SHA precondition. Therefore this harness intentionally does not approve or execute a merge and marks the exact-merge acceptance path blocked. The PEP's passing source tests are not substituted for a published, signed, integrated execution path.

A proxy receipt is interception evidence for a governed request. A fixture handler log and signed `SUCCEEDED` outcome are evidence only of a synthetic local fixture operation. Neither is evidence that GitHub executed a mutation. A valid signature proves integrity under the included local public key, not independent trust in the key's origin or in the business outcome.

See [the claims matrix](claims-matrix.md), [reuse inventory](reuse-inventory.md), and [limited two-minute talk track](demo-script.md) for safe external wording and the remaining blockers. The external artifact audit is at `docs/evidence/github-mcp-reference-demo/audit-notes.md`.
