/**
 * Stretch — `--parity`: gateway step → console governedProcedure() counterpart.
 *
 * The local-first gateway and the hosted Console enforce the SAME five
 * invariants at the same point (the side-effect boundary). This panel maps each
 * gateway concept to its production counterpart so the demo doubles as the
 * on-ramp from "runs on my laptop" to "runs in the governed kernel". Pure
 * print — no execution, no network.
 */

const ROWS = [
  {
    gateway: "createGateway({ capabilities, policy })",
    console: "PolicyEngine.evaluate() (content-addressed policyVersion)",
    file: "apps/strix-console/src/lib/decisions/policy.ts",
  },
  {
    gateway: "gateway.execute(invocation, executor) boundary",
    console: "governedProcedure() / run-governed-swarm-action.ts",
    file: "apps/strix-console/src/lib/swarm/governed-procedure.ts",
  },
  {
    gateway: "APPROVAL_REQUIRED → approval.prompt()",
    console: "DecisionService: PROPOSED → EVALUATED → APPROVED",
    file: "apps/strix-console/src/lib/decisions/service.ts",
  },
  {
    gateway: "(implicit in execute) — decision gates the side effect",
    console: "execution token: HMAC-bound to payload-hash, single-use, 5m expiry",
    file: "apps/strix-console/src/lib/decisions/tokens.ts",
  },
  {
    gateway: "issueReceipt() — Ed25519 over canonical receipt v2",
    console: "decision_evidence — Ed25519 over SE v1 13-field canonical",
    file: "apps/strix-console/src/lib/signing.ts",
  },
  {
    gateway: "proofChainHash (sha256 prev|evidence)",
    console: "proofChainHash on every signed evidence row (SE-5: no orphans)",
    file: "docs/gates/SIGNED-EVIDENCE-V1-AGENT-PROMPT.md",
  },
  {
    gateway: "verifyReceipt() / npx @strixgov/verifier",
    console: "npx @strixgov/verifier <evidenceId> (zero-shared-code re-derivation)",
    file: "packages/strixgov-verifier/src/index.mjs",
  },
];

export function printParityPanel() {
  console.log("\n  gateway (local-first)                              →  console governedProcedure() (hosted)\n");
  for (const r of ROWS) {
    console.log(`  • ${r.gateway}`);
    console.log(`      → ${r.console}`);
    console.log(`        ${r.file}`);
  }
  console.log("\n  Same five invariants, same boundary: nothing executes without evaluation;");
  console.log("  authority is re-evaluated at point-of-use; the signing key is out of the");
  console.log("  agent's reach; and a third party verifies without trusting the agent.");
  console.log("\n  The gateway is the local embodiment; the Console is the production kernel.");
  console.log("  This demo runs the local seam — flip STRIX_KERNEL_URL/--connected to sync to the kernel.");
}
