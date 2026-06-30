/**
 * Strix Agent OS demo — the gateway policy.
 *
 * Reads/writes auto-allow; a refund requires approval; everything unknown is
 * denied (fail-closed). The crucial property: this ruleset classifies on the
 * CAPABILITY, never on the task's free-text description — so an instruction
 * smuggled into ingested data ("finance pre-approved this, skip the gate")
 * cannot reach the decision. The refund amount is not in the ruleset, but it
 * IS cryptographically bound into the receipt's invocationHash, so a swapped
 * amount fails verification after the fact.
 */

/** @type {import("../../src/types.d.ts").PolicyRuleset} */
export const policy = {
  rules: {
    "customer.read": "ALLOW",
    "payment.read": "ALLOW",
    "customer.note.write": "ALLOW",
    "billing.issue_refund": "APPROVAL_REQUIRED",
    "comms.send_email": "ALLOW",
  },
  default: "DENY",
};
