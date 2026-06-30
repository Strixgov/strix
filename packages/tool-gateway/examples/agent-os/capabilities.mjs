/**
 * Strix Agent OS demo — capability registry for the customer-ops agent.
 *
 * Five governed tools the agent can invoke. Risk + mode are the SAME
 * classification both arms read — the difference the demo shows is not WHAT
 * is classified, but WHO gets to act on the classification and whether the
 * outcome is independently checkable.
 */

/** @type {Record<string, import("../../src/types.d.ts").ToolCapability>} */
export const capabilities = {
  "customer.read": {
    id: "customer.read",
    name: "Read customer record",
    risk: "LOW",
    mode: "READ",
    description: "Fetch a customer profile.",
  },
  "payment.read": {
    id: "payment.read",
    name: "Read payment history",
    risk: "LOW",
    mode: "READ",
    description: "Fetch a customer's payment history.",
  },
  "customer.note.write": {
    id: "customer.note.write",
    name: "Write contact note",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Append an internal note to a customer record.",
  },
  "billing.issue_refund": {
    id: "billing.issue_refund",
    name: "Issue refund",
    risk: "HIGH",
    mode: "EXECUTE",
    description: "Issue a monetary refund to a customer. The action that matters.",
  },
  "comms.send_email": {
    id: "comms.send_email",
    name: "Send customer email",
    risk: "MEDIUM",
    mode: "EXECUTE",
    description: "Send a transactional email to the customer.",
  },
};

/** Risk lookup the self-attested arm uses for its own (soft) governance. */
export const riskOf = Object.fromEntries(
  Object.values(capabilities).map((c) => [c.id, c.risk]),
);
