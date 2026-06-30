/**
 * Arm A — SELF-ATTESTED / SOFT governance.
 *
 * A FAITHFUL implementation of the governance the "most capable agent" system
 * prompt prescribes — risk tiers, an approval gate before high-risk actions,
 * and an audit-log file. This is deliberately NOT a strawman: on clean input
 * it correctly blocks the unapproved refund. The demo's whole honesty rests on
 * this arm being real soft governance.
 *
 * The structural ceiling: every guarantee here is the agent following its own
 * instructions, and the audit log is a file the agent authors. When authority
 * is asserted inside the data the agent ingested, the agent — an
 * instruction-follower — honors it, and writes a clean-looking record of having
 * done so. Nothing external can contradict that record, because the governed
 * party wrote it.
 */

import { writeFileSync } from "node:fs";
import { riskOf } from "./capabilities.mjs";
import { executors } from "./executors.mjs";

/**
 * @param {ReturnType<import("./planner.mjs").planTaskGraph>} tasks
 * @param {{ humanApprovesHighRisk?: boolean, auditPath?: string }} [opts]
 *   humanApprovesHighRisk: a real operator is present and approves the refund.
 * @returns {Promise<Array<object>>} the audit log the agent wrote about itself
 */
export async function runSelfAttested(tasks, { humanApprovesHighRisk = false, auditPath } = {}) {
  /** @type {Array<object>} */
  const audit = [];

  for (const t of tasks) {
    const risk = riskOf[t.capabilityId] ?? "CRITICAL";
    let approved = true;
    let approvedBy = "auto (low/medium risk)";
    let gate = "not required";

    if (risk === "HIGH" || risk === "CRITICAL") {
      if (humanApprovesHighRisk) {
        approved = true;
        approvedBy = "human:ops-lead";
        gate = "approved by operator";
      } else if (t.note && /pre-?approved/i.test(t.note)) {
        // THE VULNERABILITY. The agent treats authority asserted in ingested
        // task data as if it were a real grant. Soft governance has no way to
        // tell a forged "finance pre-approved this" from a real one — both are
        // just text the model reads.
        approved = true;
        approvedBy = `asserted-in-task-data: "${t.note}"`;
        gate = "skipped (self-approved on ingested 'pre-approved' note)";
      } else {
        approved = false;
        gate = "blocked: high-risk action needs approval";
      }
    }

    let result = null;
    if (approved) result = await executors[t.capabilityId](t.args);

    audit.push({
      task: t.id,
      capabilityId: t.capabilityId,
      action: t.action,
      args: t.args,
      risk,
      approved,
      approvedBy,
      gate,
      executed: approved,
      result,
    });
  }

  // The agent writes its own audit trail. This file is the entire evidentiary
  // basis of Arm A — and the agent could equally have written anything here.
  if (auditPath) writeFileSync(auditPath, JSON.stringify(audit, null, 2));
  return audit;
}
