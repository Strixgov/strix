/**
 * Email pack — risk classification invariants.
 *
 * Email is the wrap with the broadest blast-radius asymmetry: every
 * `send_*` reaches external third parties and is irreversible once
 * delivered. This test pins the risk model in `src/email.mjs` against
 * accidental escalation OR de-escalation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { emailCapabilities } from "../src/email.mjs";

const byName = new Map(emailCapabilities.map((c) => [c.name, c]));

test("every classification has the canonical shape", () => {
  for (const cap of emailCapabilities) {
    assert.match(cap.id, /^mcp\.email\./);
    assert.equal(typeof cap.name, "string");
    assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(cap.risk));
    assert.ok(["READ", "WRITE", "EXECUTE"].includes(cap.mode));
    assert.equal(typeof cap.description, "string");
    assert.ok(cap.description.length > 0);
  }
});

test("mailbox reads (read/list/search/get_thread/list_labels) are LOW READ", () => {
  const lowReads = ["read_email", "list_emails", "list_messages", "search_emails", "get_thread", "list_labels"];
  for (const name of lowReads) {
    const cap = byName.get(name);
    assert.ok(cap, `expected pack to classify '${name}'`);
    assert.equal(cap.mode, "READ", `${name} mode`);
    assert.equal(cap.risk, "LOW", `${name} risk`);
  }
});

test("mark_read / mark_unread / add_label / archive / draft are MEDIUM WRITE (reversible mutations)", () => {
  for (const name of ["mark_read", "mark_unread", "add_label", "archive_email", "draft_email"]) {
    const cap = byName.get(name);
    assert.ok(cap, `expected pack to classify '${name}'`);
    assert.equal(cap.mode, "WRITE", `${name} mode`);
    assert.equal(cap.risk, "MEDIUM", `${name} risk`);
  }
});

test("send_email / send_message / reply / reply_all / forward are HIGH WRITE (irreversible once delivered)", () => {
  // Rationale: once an email is delivered to a recipient SMTP server,
  // it cannot be unsent. The signed receipt records intent + outcome;
  // it does not retract the email. Pinning HIGH protects against
  // accidental de-escalation to MEDIUM that would silently weaken
  // the default deployment posture.
  for (const name of ["send_email", "send_message", "reply", "reply_all", "forward"]) {
    const cap = byName.get(name);
    assert.ok(cap, `expected pack to classify '${name}'`);
    assert.equal(cap.mode, "WRITE", `${name} mode`);
    assert.equal(cap.risk, "HIGH", `${name} risk`);
  }
});

test("delete_email is HIGH (provider-dependent reversibility)", () => {
  const cap = byName.get("delete_email");
  assert.ok(cap);
  assert.equal(cap.risk, "HIGH");
  assert.equal(cap.mode, "WRITE");
});

test("recipient-domain restrictions are intentionally absent — that's policy-engine territory, not pack territory", () => {
  // Discipline: this pack does NOT classify per-recipient. An agent
  // emailing one teammate produces the same capability id as an
  // agent emailing #all-staff. If recipient-domain restrictions
  // matter (they usually do), they belong at the application layer
  // OR as a higher-tier policy rule. Pinning absence here so a
  // future PR doesn't try to encode "send_to_external" / "send_to_all"
  // as a separate capability — that's not a Strix-pack concern.
  const recipientGated = emailCapabilities.filter((c) =>
    /(external|all_employees|all_staff|broadcast|mass|bulk)/i.test(c.name),
  );
  assert.equal(
    recipientGated.length,
    0,
    "email pack must not classify per-recipient — that's policy-engine territory",
  );
});

test("purge / wipe / admin-destructive ops are intentionally absent — heuristic CRITICAL handles them", () => {
  const destructive = emailCapabilities.filter((c) =>
    /(purge|wipe|destroy|nuke)/i.test(c.name),
  );
  assert.equal(
    destructive.length,
    0,
    "email pack must not classify admin-destructive ops — they belong at CRITICAL via heuristic",
  );
});
