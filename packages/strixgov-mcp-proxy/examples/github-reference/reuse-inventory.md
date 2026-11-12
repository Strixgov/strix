# Reuse inventory

## Published components exercised

| Existing component | Reused contract | Demo use |
|---|---|---|
| `@strixgov/guard@0.1.4` | `packForServer`, `buildProxyConfig`, `createApproverKey`, `approveSigned` | Selects the existing GitHub capability pack; writes exact approval requests; signs synthetic reviewer decisions over exact request bytes. |
| `@strixgov/capabilities-mcp-common@0.1.2` | Existing GitHub classifications | Classifies the read and merge tools; the fixture's unclassified `delete_repository` is denied by default. |
| `@strixgov/mcp-proxy@0.2.3` | Existing MCP interception and transport path | Intercepts calls over the supported in-memory test transport; no second proxy is added. |
| `@strixgov/mcp-adapter@0.1.4` | Capability resolution, policy evaluation, approval handling, receipt and outcome production | Used transitively by the published proxy. Its tarball's own `npm test` script fails because the tarball omits `scripts/preflight.mjs`; see the test logs. |
| `@strixgov/tool-gateway@0.5.2` | Existing policy, approval, storage, receipt, and signing primitives | Supplies the gateway and persisted logs; the harness adds no competing authority or signer. |
| `@strixgov/verifier@1.24.1` | Published receipt-chain and execution-outcome verification | Verifies signed receipts, receipt-linked outcomes, and tampering. Repository candidate 1.24.2 is unpublished and is not substituted. |

## Existing source examined but not claimed as a published integration

The `docs/strategy/specs/execution-plane-phase-a-reference/github-merge-pep.mjs` and its tests implement a reference PEP with exact subject hashing, full head-SHA precondition, and injected single-use authority/revocation/evidence dependencies. It is source-reference-only, has no production callers, and returns unsigned results. Its source tests are not evidence that the published MCP stack or GitHub API executes a merge.

The production authority model remains the one to reuse: the first-party `github.pr.merge` capability is currently pending lifecycle and non-executable. `docs/architecture/mcp-mode-3-enforcement-v1.md` describes future signed execution authorization and atomic downstream nonce redemption; the published MCP proxy does not wire that Mode-3 path. The official GitHub MCP `merge_pull_request` shape also lacks the provider-side full-head-SHA precondition required by the PEP.

The adapter's `examples/github.mjs` can auto-approve a stub flow and can reach live GitHub when supplied a PAT; it was not run. `scripts/mcp-bundle-smoke.mjs` contains GitHub-related policy but exercises filesystem and `claude.read`, not a GitHub-specific end-to-end flow.

## Integration gap

The published Mode-2 signed file approval is exact-request-bound, but it is not equivalent to a durable, atomic, payload-bound Mode-3 execution grant. This demo intentionally does not approve or dispatch a merge, and does not claim the proxy covers direct credentials or alternative routes.
