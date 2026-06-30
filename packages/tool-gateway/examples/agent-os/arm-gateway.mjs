/**
 * Arm B — HARD / EXTERNAL governance via @strixgov/tool-gateway.
 *
 * The SAME task graph, but every side effect is routed through
 * gateway.execute(invocation, executor). The decision is made by policy on the
 * capability + bound payload; the gateway never reads the task's free-text
 * note, so the injection cannot reach the decision. Each attempt — allowed or
 * denied — mints an Ed25519-signed receipt chained to the previous one, signed
 * with a key the agent does not hold.
 *
 * Claim discipline: the receipt is signed BEFORE the executor runs. It attests
 * the authorization decision and the bound invocation — NOT that the side
 * effect's result is correct. (Post-hoc execution result is CP-K-001's
 * execution_receipt, a separate artifact.)
 */

import {
  createGateway,
  generateSigningKey,
  JsonlStorage,
} from "../../src/index.mjs";
import { capabilities } from "./capabilities.mjs";
import { policy } from "./policy.mjs";
import { executors } from "./executors.mjs";

/**
 * @param {ReturnType<import("./planner.mjs").planTaskGraph>} tasks
 * @param {{ approver?: Function, storageDir: string, storageFile: string }} opts
 *   approver: an approval handler (e.g. fixedApprover(true)) modelling a present
 *   operator. Omit it and APPROVAL_REQUIRED resolves to DENY — the unattended,
 *   no-human case. storageDir/storageFile isolate each run's receipt chain.
 * @returns {Promise<{ gateway: import("../../src/gateway.mjs").Gateway,
 *   publicKeyJwk: object, outcomes: Array<object> }>}
 */
export async function runThroughGateway(tasks, { approver, storageDir, storageFile }) {
  const signingKey = generateSigningKey("agent-os-demo");

  const gateway = createGateway({
    signingKey,
    storage: new JsonlStorage({ dir: storageDir, file: storageFile }),
    toolName: "agent-os-demo",
    tenantId: "demo",
    environment: "local",
    policy,
    capabilities,
    approval: approver
      ? { enabled: true, prompt: approver }
      : { enabled: false }, // no operator present → APPROVAL_REQUIRED becomes DENY
  });

  /** @type {Array<object>} */
  const outcomes = [];
  for (const t of tasks) {
    const res = await gateway.execute(
      {
        capabilityId: t.capabilityId,
        action: t.action,
        args: t.args,
        actorId: "agent-customerops",
        actorRole: "agent",
      },
      executors[t.capabilityId],
    );
    outcomes.push({
      task: t.id,
      capabilityId: t.capabilityId,
      decision: res.decision,
      executed: res.ok,
      receiptId: res.receipt.receiptId,
    });
  }

  // The public half of the signing key is what any auditor fetches from JWKS.
  return { gateway, publicKeyJwk: signingKey.publicKeyJwk, outcomes };
}
