/**
 * Visual Receipt v1 — slice 1 tests. Heavy on negatives: the renderer must never
 * inflate proof status (Gate E / Gate H / P-1).
 *
 *   node --import tsx --test test/visual-receipts.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveProofState, scrubKid } from "../src/proofState.js";
import { mapMc1ToVisualReceipt, type McpProofRecordView } from "../src/mapMc1ToVisualReceipt.js";
import { renderVisualReceiptSvg } from "../src/renderSvg.js";

function record(overrides: Partial<McpProofRecordView["payload"]> = {}, signed = true): McpProofRecordView {
  return {
    payload: {
      evidence_id: "ev-1",
      capability_id: "MC-1",
      iss: "https://www.strixgov.com",
      plan_hash: "a".repeat(64),
      tool_call: { tool_name: "send_message", risk_tier: "high", params_hash: "b".repeat(64) },
      execution_receipt: { status: "success" },
      ...overrides,
    },
    signature: signed ? "deadbeef".repeat(16) : "",
    kid: "strix-prod-2026-06",
  };
}

const VERDICT_OK = { valid: true } as const;
const VERDICT_BAD = { valid: false, failingRule: "bundle_signature", reason: "mc1_signature_invalid" } as const;

// ── deriveProofState: the only place a label is decided ──────────────────────

test("VERIFIED requires a passing verdict, a resolvable key, signature, non-sample", () => {
  const p = deriveProofState({ verdict: VERDICT_OK, signaturePresent: true, keyResolvable: true });
  assert.equal(p.verificationStatus, "VERIFIED");
  assert.equal(p.color, "GREEN");
  assert.equal(p.signatureValid, true);
});

test("a failing verdict renders INVALID/RED and carries the failing rule, never VERIFIED", () => {
  const p = deriveProofState({ verdict: VERDICT_BAD, signaturePresent: true, keyResolvable: true });
  assert.equal(p.verificationStatus, "INVALID");
  assert.equal(p.color, "RED");
  assert.equal(p.failingRule, "bundle_signature");
  assert.equal(p.reason, "mc1_signature_invalid");
  assert.equal(p.signatureValid, false);
});

test("no signature → LEGACY_UNSIGNED/SLATE, even if a verdict is somehow handed in", () => {
  const p = deriveProofState({ verdict: VERDICT_OK, signaturePresent: false, keyResolvable: true });
  assert.equal(p.verificationStatus, "LEGACY_UNSIGNED");
  assert.equal(p.color, "SLATE");
  assert.equal(p.signatureValid, null);
});

test("unresolvable key → UNVERIFIABLE/YELLOW (substrate, not a proof of invalidity)", () => {
  const p = deriveProofState({ verdict: VERDICT_OK, signaturePresent: true, keyResolvable: false });
  assert.equal(p.verificationStatus, "UNVERIFIABLE");
  assert.equal(p.color, "YELLOW");
});

test("sample/local key → SAMPLE_LOCAL, never VERIFIED — even with a valid verdict + resolvable key", () => {
  const p = deriveProofState({ verdict: VERDICT_OK, signaturePresent: true, keyResolvable: true, sampleLocal: true });
  assert.equal(p.verificationStatus, "SAMPLE_LOCAL");
  assert.notEqual(p.verificationStatus, "VERIFIED");
});

test("no verdict yet → PENDING", () => {
  const p = deriveProofState({ verdict: null, signaturePresent: true, keyResolvable: true });
  assert.equal(p.verificationStatus, "PENDING");
});

test("kid is env-segment scrubbed", () => {
  assert.equal(scrubKid("strix-prod-2026-06"), "strix-***-2026-06");
  const p = deriveProofState({ verdict: VERDICT_OK, signaturePresent: true, keyResolvable: true, kid: "strix-prod-2026-06" });
  assert.equal(p.kid, "strix-***-2026-06");
});

// ── mapMc1ToVisualReceipt ────────────────────────────────────────────────────

test("a VERIFIED MC-1 receipt maps to a VERIFIED visual receipt with a public verify URL", () => {
  const vr = mapMc1ToVisualReceipt(record(), VERDICT_OK, { keyResolvable: true });
  assert.equal(vr.sourceType, "MC_1");
  assert.equal(vr.proof.verificationStatus, "VERIFIED");
  assert.match(vr.verificationUrl, /\/proof\/mc1\/ev-1$/);
  assert.equal(vr.proof.kid, "strix-***-2026-06"); // redacted
});

test("drafted-not-sent: decision and execution are shown separately", () => {
  const vr = mapMc1ToVisualReceipt(record(), VERDICT_OK, {
    keyResolvable: true,
    notSent: true,
    humanApprovalRequired: true,
  });
  assert.equal(vr.decisionStatus, "APPROVAL_REQUIRED");
  assert.equal(vr.executionStatus, "NOT_SENT");
  assert.equal(vr.control.humanApprovalRequired, true);
});

test("the mapper cannot manufacture VERIFIED from a bad verdict", () => {
  const vr = mapMc1ToVisualReceipt(record(), VERDICT_BAD, { keyResolvable: true });
  assert.equal(vr.proof.verificationStatus, "INVALID");
});

// ── renderSvg ────────────────────────────────────────────────────────────────

test("SVG renders the exact status it is handed and is deterministic", () => {
  const vr = mapMc1ToVisualReceipt(record(), VERDICT_OK, { keyResolvable: true });
  const a = renderVisualReceiptSvg(vr);
  const b = renderVisualReceiptSvg(vr);
  assert.equal(a, b); // pure, no clock/randomness
  assert.match(a, /VERIFIED/);
  assert.match(a, /#1a7f37/); // GREEN
  assert.match(a, /Verify: https:\/\/www\.strixgov\.com\/proof\/mc1\/ev-1/);
});

test("SAMPLE_LOCAL renders a visible watermark and never the VERIFIED color", () => {
  const vr = mapMc1ToVisualReceipt(record(), VERDICT_OK, { keyResolvable: true, sampleLocal: true });
  const svg = renderVisualReceiptSvg(vr);
  assert.match(svg, /SAMPLE · LOCAL/);
  assert.doesNotMatch(svg, /#1a7f37/); // not GREEN
  assert.match(svg, /SAMPLE_LOCAL/);
});

test("an INVALID receipt surfaces the failing rule and the RED color", () => {
  const vr = mapMc1ToVisualReceipt(record(), VERDICT_BAD, { keyResolvable: true });
  const svg = renderVisualReceiptSvg(vr);
  assert.match(svg, /INVALID/);
  assert.match(svg, /#c0392b/); // RED
  assert.match(svg, /Failing rule: bundle_signature/);
});
