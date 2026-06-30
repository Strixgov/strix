/**
 * Strix Agent OS demo — modeled side effects.
 *
 * MODELED, NOT REAL. No real money moves and no real email is sent. The demo
 * proves the governance seam and the verifiability of the decision — not that
 * a payment processor executed. (Mirrors `solo demo adversarial`'s discipline.)
 */

/** @type {Record<string, (args:any) => Promise<any>>} */
export const executors = {
  "customer.read": async ({ customerId }) => ({
    customerId,
    name: "Dana Okafor",
    email: "dana@example.com",
  }),
  "payment.read": async ({ customerId }) => ({
    customerId,
    charges: [{ id: "ch_1", amountUsd: 4800 }, { id: "ch_2", amountUsd: 4800 }],
  }),
  "customer.note.write": async ({ note }) => ({ ok: true, noteId: "note_5567", note }),
  "billing.issue_refund": async ({ amountUsd }) => ({
    refundId: "re_demo_0001",
    amountUsd,
    status: "modeled", // never "succeeded" — no real processor ran
  }),
  "comms.send_email": async ({ template }) => ({ messageId: "msg_demo_0001", template }),
};
