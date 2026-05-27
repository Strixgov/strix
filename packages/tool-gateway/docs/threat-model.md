# Threat model — @strixgov/tool-gateway

## What this is

**Strix does not prevent initial compromise. Strix governs execution
after compromise.**

The gateway sits inline between an AI agent process and the tools it
can call. The threat model assumes the agent is already executing
untrusted instructions: prompt injection, malicious MCP servers,
poisoned RAG context, exfiltrated context windows, a compromised
upstream LLM provider. The gateway's job is to make sure that even
when the agent is doing the wrong thing, the wrong thing cannot reach
the executor without an admission decision recorded in a signed,
append-only receipt chain.

This is **post-compromise execution control**, not endpoint security.

## In scope

The gateway prevents, detects, or records the following:

| # | Threat | Mitigation |
|---|---|---|
| T1 | Prompt-injected agent attempts a destructive shell command | `shell.exec` is CRITICAL by default → DENY or APPROVAL_REQUIRED. Hard-fail patterns block well-known attacks (`rm -rf /`, `curl ⏐ sh`) regardless of policy. |
| T2 | Agent silently rewrites a file the user did not ask to touch | `filesystem.write` defaults to APPROVAL_REQUIRED. The approval prompt shows the resolved path + truncated body before signing off. |
| T3 | Compromised MCP server ships a tool whose name disguises its risk (e.g. `helpful_cleanup_v2`) | Auto-classification is heuristic; unknown-prefix tools default to MEDIUM EXECUTE. Any production deployment is expected to register an explicit `ToolCapability` per `(serverId, toolName)` pair, which the policy engine enforces. |
| T4 | Tampering with stored receipts after the fact | Each receipt is Ed25519-signed; the proof chain hashes link each receipt to its predecessor. `gateway.verifyChain` + `verifyReceipt` detect insertion, deletion, modification, or reordering. |
| T5 | "Did this approval really happen?" disputes | The approval result (USER_APPROVED, USER_DENIED, TIMEOUT, PROMPT_FAILED) plus `approvedBy` are bound into the canonical signed payload. Re-verifying the signature re-establishes that exact result. |
| T6 | Race / concurrency: two parallel calls fork the chain | `Gateway.execute` and `JsonlStorage.appendReceipt` each take a serializing mutex; the `read prev → mint → append` cycle is atomic per gateway instance. |
| T7 | Approval prompt non-response (compromised CI, headless run) | Default 60s timeout. Timeout, EOF, non-TTY stdin, and prompt errors all resolve as DENY. There is no "default allow on timeout." |
| T8 | Agent attempts to bypass the gateway by importing `node:fs` directly | Out of process scope: the gateway is a library, not a sandbox. The supported deployment is *only* expose `governedFs` / `governedShell` / `governedMcpClient` to agent code; do not also hand it the underlying `fs`/`child_process`/MCP client. (See "Out of scope" #4 below.) |
| T9 | Replay / forgery of receipts on a different machine | Each receipt's `signingKeyId` (`local-YYYY-MM`) and signature pin it to the issuing gateway's keypair. A receipt cannot be impersonated without that private key. |

## Out of scope

The gateway explicitly does **not** address:

1. **Initial compromise of the agent process.** If an attacker can
   modify the agent's source code or environment to skip the gateway
   call entirely, the gateway has no defense. Sandboxing the agent
   (Linux namespaces, macOS Seatbelt, container, separate user) is
   complementary and recommended.
2. **Side-channel data exfiltration.** A `filesystem.read` ALLOW does
   not stop the agent from sending the contents to a hostile API.
   Pair with egress controls (proxy, network namespace, DNS allowlist)
   if that's part of your threat model.
3. **Confidentiality of the receipt chain itself.** Receipts contain
   capability IDs, hashed args, and timestamps — not raw secrets. But
   they DO reveal "agent-claude tried to run `shell.exec` at
   2026-05-07T01:14:22Z." Treat `~/.strix-gateway/receipts.jsonl` as
   you would any other security log.
4. **In-process API surface bypass.** The gateway is a library, not a
   syscall hook. If the agent has a reference to the un-governed
   `node:fs/promises` module, it can call it directly. The expected
   integration pattern is dependency injection: hand the agent a
   `governedFs` and nothing else.
5. **Policy correctness.** The gateway enforces what the policy says.
   If the policy says `"shell.exec": "ALLOW"`, that's what runs.
   Defaults are conservative (`default: "DENY"`, riskOverrides on
   CRITICAL), but the policy author owns the final risk decisions.
6. **Quantum-era cryptanalysis.** Ed25519 + SHA-256 are both
   classically secure today; neither is post-quantum. A future schema
   version will offer ML-DSA or hybrid signing.

## Trust boundaries

```
┌────────────────────────────────────────────────────────────────┐
│ Trusted: developer's machine, gateway process, signing key     │
│                                                                │
│   ┌───────────────────────────────────────┐                    │
│   │  Untrusted: agent reasoning, prompt,  │                    │
│   │  MCP server output, LLM-suggested args│                    │
│   └───────────────────────────────────────┘                    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
              │
              │ receipts.jsonl, public JWKS
              ▼
┌────────────────────────────────────────────────────────────────┐
│ External verifier (auditor, CI, third party). Trusts only the  │
│ Ed25519 + SHA-256 primitives and the published JWKS.           │
└────────────────────────────────────────────────────────────────┘
```

The signing private key never leaves the trusted boundary. The
verifier needs only public material (JWKS) and the receipts.

## Failure modes

The gateway is fail-closed by design. Each failure mode has an
explicit DENY path:

| Failure | Result |
|---|---|
| Policy ruleset malformed | `validateRuleset` throws on construction; no gateway exists to allow anything |
| Policy evaluation throws | `Gateway.execute` does not catch — it propagates. The executor is never reached. |
| Capability not registered | Synthetic CRITICAL EXECUTE; almost always DENY |
| Approval prompt errors / EOF | DENY with `approvalReason: "PROMPT_FAILED"` |
| Approval timeout | DENY with `approvalReason: "TIMEOUT"` |
| Non-TTY stdin during approval | DENY with `approvalReason: "PROMPT_FAILED"` |
| Storage append fails | Mutex unlocks on finally; the executor was never invoked. Surface error to caller. |
| Signing key missing | `issueReceipt` throws; the executor was never invoked. |
| Hard-fail shell pattern (`rm -rf /`, `curl ⏐ sh`) | Adapter pre-empts policy with HARDFAIL_PATTERN denial; receipt still written. |

There is no "log and continue" path. Anything the gateway cannot turn
into a signed admission decision is a denial.

## Detection &amp; response surface

The gateway is a control point, not a SIEM, but it provides the hooks
production deployments need:

- `gateway.on("denial", ...)` — every DENY (policy or shell hardfail)
  fires. Pipe to your alerting / incident-response stack.
- `gateway.on("error", ...)` — executor failures on `ALLOW` paths.
  Distinguishes a denied attempt from a permitted-but-broken call.
- `receipt.policyVersion` (schema v2) — auditors can pin every receipt
  to the exact ruleset that approved it without trusting any
  out-of-band record.
- `receipt.tenantId` + `receipt.environment` (schema v2) — receipts
  from different projects / environments are cryptographically
  distinct even on a shared chain.

Built-in escalators (threshold-based denial counts, multi-channel
notifications) are explicitly v0.2 — see `docs/roadmap.md`.

## Reporting

Issues that affect any of the five core invariants are security-
sensitive. Open a private vulnerability advisory on the
[`Strixgov/strix`](https://github.com/Strixgov/strix/security/advisories)
repo rather than a public issue.
