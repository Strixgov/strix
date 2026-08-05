/**
 * Odysseus pack — risk classification invariants.
 *
 * Pins the workspace risk model against accidental escalation OR
 * de-escalation. The asymmetric surfaces (shell, email send, skill
 * install, secret access, scheduler) each get an explicit pin with the
 * rationale in the assertion, so a future re-classification has to be
 * deliberate.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { odysseusCapabilityMap } from "../src/index.mjs";

const byId = odysseusCapabilityMap();

test("shell.execute is CRITICAL EXECUTE — the highest-blast-radius primitive", () => {
  const cap = byId["odysseus.shell.execute"];
  assert.ok(cap);
  assert.equal(cap.risk, "CRITICAL");
  assert.equal(cap.mode, "EXECUTE");
});

test("email.send is HIGH WRITE (irreversible once delivered); draft stays LOW", () => {
  // Mirrors the mcp-common email pack: delivery to a recipient SMTP
  // server cannot be unsent — the receipt records intent + outcome,
  // it does not retract the email.
  assert.equal(byId["odysseus.email.send"].risk, "HIGH");
  assert.equal(byId["odysseus.email.send"].mode, "WRITE");
  assert.equal(byId["odysseus.email.draft"].risk, "LOW");
});

test("skill.install is CRITICAL — deferred code execution with workspace authority", () => {
  const cap = byId["odysseus.skill.install"];
  assert.ok(cap);
  assert.equal(cap.risk, "CRITICAL");
});

test("secret.access is HIGH READ — the read is the blast radius, never auto-allowed", () => {
  const cap = byId["odysseus.secret.access"];
  assert.equal(cap.risk, "HIGH");
  assert.equal(cap.mode, "READ");
});

test("web.fetch is a read that can exfiltrate — MEDIUM, not LOW", () => {
  assert.equal(byId["odysseus.web.fetch"].risk, "MEDIUM");
  assert.equal(byId["odysseus.web.fetch"].mode, "READ");
  assert.equal(byId["odysseus.web.search"].risk, "LOW");
});

test("scheduler: create and execute are HIGH; execute carries the re-evaluation contract in its description", () => {
  assert.equal(byId["odysseus.schedule.create"].risk, "HIGH");
  const fire = byId["odysseus.schedule.execute"];
  assert.equal(fire.risk, "HIGH");
  assert.equal(fire.mode, "EXECUTE");
  // Core invariant 2: execution does not inherit authority. The pack
  // carries that contract in prose so a consumer rendering the
  // capability shows it.
  assert.match(fire.description, /re-evaluated/i);
});

test("memory.write documents the injection-persistence rationale", () => {
  const cap = byId["odysseus.memory.write"];
  assert.equal(cap.risk, "MEDIUM");
  assert.match(cap.description, /persistence|future sessions/i);
});

test("mcp.invoke is a fail-closed HIGH floor, never auto-allow", () => {
  const cap = byId["odysseus.mcp.invoke"];
  assert.equal(cap.risk, "HIGH");
  assert.equal(cap.mode, "EXECUTE");
  assert.match(cap.description, /floor/i);
});

test("per-recipient / bulk-send entries are intentionally absent — policy-engine territory", () => {
  // Same discipline as the mcp-common email pack: the pack classifies
  // the action, not the audience. Recipient/domain restrictions belong
  // in the policy ruleset.
  const recipientGated = Object.keys(byId).filter((id) =>
    /(external|all_staff|broadcast|mass|bulk)/i.test(id),
  );
  assert.equal(recipientGated.length, 0);
});

test("secret rotation / write is intentionally absent — operator ceremony, not agent capability", () => {
  const rotation = Object.keys(byId).filter((id) =>
    /secret\.(write|rotate|update|create)/i.test(id),
  );
  assert.equal(rotation.length, 0);
});
