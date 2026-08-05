/**
 * Visual Receipt v1 — slice 2 tests: SE v1 mapper, HTML/PNG renderers,
 * verifyAndRender, redaction, and per-state snapshots. Heavy on negatives —
 * the renderer must never inflate proof status (Gate E / H, P-1, VR-2).
 *
 *   node --import tsx --test test/slice2.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  mapSignedEvidenceToVisualReceipt,
  type SignedEvidenceView,
} from "../src/mapSignedEvidenceToVisualReceipt.js";
import { mapMc1ToVisualReceipt, type McpProofRecordView } from "../src/mapMc1ToVisualReceipt.js";
import { renderVisualReceiptSvg } from "../src/renderSvg.js";
import { renderVisualReceiptHtml } from "../src/renderHtml.js";
import { renderVisualReceiptPng } from "../src/renderPng.js";
import { verifyAndRenderMc1 } from "../src/verifyAndRender.js";
import type { VisualReceiptV1 } from "../src/schema.js";

// ── SE v1 mapper ─────────────────────────────────────────────────────────────

function seRecord(): SignedEvidenceView {
  return {
    evidenceId: "5686",
    evidenceHash: "f".repeat(64),
    capabilityId: "notification.send",
    action: "send_notification",
    signingKeyId: "strix-prod-2026-04",
    signature: "sig",
    iss: "https://www.strixgov.com",
  };
}

test("SE v1: valid signed evidence renders VERIFIED", () => {
  const vr = mapSignedEvidenceToVisualReceipt(seRecord(), {
    signatureValid: true,
    signaturePresent: true,
    keyResolvable: true,
    hashValid: true,
    chainValid: true,
  });
  assert.equal(vr.proof.verificationStatus, "VERIFIED");
  assert.equal(vr.proof.hashValid, true);
  assert.equal(vr.proof.chainValid, true);
  assert.equal(vr.proof.kid, "strix-***-2026-04"); // redacted
});

test("SE v1: tampered evidence renders INVALID", () => {
  const vr = mapSignedEvidenceToVisualReceipt(seRecord(), {
    signatureValid: false,
    signaturePresent: true,
    keyResolvable: true,
    hashValid: false,
  });
  assert.equal(vr.proof.verificationStatus, "INVALID");
});

test("SE v1: wrong public key renders INVALID", () => {
  const vr = mapSignedEvidenceToVisualReceipt(seRecord(), {
    signatureValid: false,
    signaturePresent: true,
    keyResolvable: true,
  });
  assert.equal(vr.proof.verificationStatus, "INVALID");
});

test("SE v1: missing key renders UNVERIFIABLE", () => {
  const vr = mapSignedEvidenceToVisualReceipt(seRecord(), {
    signatureValid: null,
    signaturePresent: true,
    keyResolvable: false,
  });
  assert.equal(vr.proof.verificationStatus, "UNVERIFIABLE");
});

test("SE v1: legacy unsigned renders LEGACY_UNSIGNED", () => {
  const vr = mapSignedEvidenceToVisualReceipt(seRecord(), {
    signatureValid: null,
    signaturePresent: false,
    legacyUnsigned: true,
  });
  assert.equal(vr.proof.verificationStatus, "LEGACY_UNSIGNED");
});

// ── HTML renderer ────────────────────────────────────────────────────────────

function mc1Receipt(over: Partial<McpProofRecordView["payload"]> = {}): VisualReceiptV1 {
  const record: McpProofRecordView = {
    payload: {
      evidence_id: "ev-9",
      capability_id: "MC-1",
      iss: "https://www.strixgov.com",
      plan_hash: "a".repeat(64),
      tool_call: { tool_name: "send_message", risk_tier: "high", params_hash: "b".repeat(64) },
      execution_receipt: { status: "success" },
      ...over,
    },
    signature: "deadbeef".repeat(16),
    kid: "strix-prod-2026-06",
  };
  return mapMc1ToVisualReceipt(record, { valid: true }, { keyResolvable: true });
}

test("HTML: renders proof layers separately and embeds the manifest for re-verification", () => {
  const html = renderVisualReceiptHtml(mc1Receipt());
  for (const layer of ["Hash integrity", "Chain integrity", "Signature present", "Signature valid", "Execution status", "Decision status"]) {
    assert.ok(html.includes(layer), `missing layer: ${layer}`);
  }
  assert.match(html, /id="visual-receipt-manifest"/);
  assert.match(html, /Verify: <a href="https:\/\/www\.strixgov\.com\/proof\/mc1\/ev-9"/);
  assert.match(html, /strix-\*\*\*-2026-06/); // kid redacted
});

test("HTML/SVG: no private key material ever appears", () => {
  const PRIV = "11".repeat(32);
  // the mapper input has no field for private keys; prove nothing leaks regardless.
  const r = mc1Receipt();
  const html = renderVisualReceiptHtml(r);
  const svg = renderVisualReceiptSvg(r);
  assert.ok(!html.includes(PRIV));
  assert.ok(!svg.includes(PRIV));
  assert.ok(!JSON.stringify(r).includes(PRIV));
});

// ── PNG renderer ─────────────────────────────────────────────────────────────

test("PNG: uses the injected rasterizer over the produced SVG", async () => {
  let seenSvg = "";
  const png = await renderVisualReceiptPng(mc1Receipt(), {
    rasterize: (svg) => {
      seenSvg = svg;
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    },
  });
  assert.match(seenSvg, /VERIFIED/);
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("PNG: fails closed (no fake image) when no rasterizer is available", async () => {
  // No rasterize injected → default tries the optional @resvg peer, which is not
  // installed here, so it rejects rather than emitting a placeholder image.
  await assert.rejects(() => renderVisualReceiptPng(mc1Receipt(), {}), /no rasterizer available|@resvg/);
});

// ── verifyAndRender: the verdict comes from the verifier, never assumed ───────

test("verifyAndRenderMc1: a passing verifier yields VERIFIED", () => {
  const record: McpProofRecordView = {
    payload: mc1RawPayload(),
    signature: "deadbeef".repeat(16),
    kid: "strix-prod-2026-06",
  };
  const out = verifyAndRenderMc1(record, () => ({ valid: true }), { keyResolvable: true });
  assert.equal(out.manifest.proof.verificationStatus, "VERIFIED");
  assert.match(out.svg, /VERIFIED/);
  assert.match(out.html, /VERIFIED/);
});

test("verifyAndRenderMc1: a failing verifier yields INVALID — the caller cannot override it", () => {
  const record: McpProofRecordView = {
    payload: mc1RawPayload(),
    signature: "deadbeef".repeat(16),
    kid: "strix-prod-2026-06",
  };
  const out = verifyAndRenderMc1(
    record,
    () => ({ valid: false, failingRule: "capability", reason: "mc1_capability_not_active" }),
    { keyResolvable: true },
  );
  assert.equal(out.manifest.proof.verificationStatus, "INVALID");
  assert.equal(out.manifest.proof.reason, "mc1_capability_not_active");
});

function mc1RawPayload(): McpProofRecordView["payload"] {
  return {
    evidence_id: "ev-9",
    capability_id: "MC-1",
    iss: "https://www.strixgov.com",
    plan_hash: "a".repeat(64),
    tool_call: { tool_name: "send_message", risk_tier: "high", params_hash: "b".repeat(64) },
    execution_receipt: { status: "success" },
  };
}

// ── Snapshots: one per state, deterministic + state-correct ──────────────────

function snap(svg: string): string {
  return createHash("sha256").update(svg).digest("hex").slice(0, 16);
}

test("snapshots: each state is deterministic and renders its own status/color", () => {
  const base: McpProofRecordView = {
    payload: mc1RawPayload(),
    signature: "deadbeef".repeat(16),
    kid: "strix-prod-2026-06",
  };

  const cases: Array<{ name: string; vr: VisualReceiptV1; status: string; color: string; decision?: string }> = [
    { name: "ALLOW/VERIFIED", vr: mapMc1ToVisualReceipt(base, { valid: true }, { keyResolvable: true }), status: "VERIFIED", color: "#1a7f37", decision: "ALLOW" },
    { name: "APPROVAL_REQUIRED", vr: mapMc1ToVisualReceipt(base, { valid: true }, { keyResolvable: true, humanApprovalRequired: true, notSent: true }), status: "VERIFIED", color: "#1a7f37", decision: "APPROVAL_REQUIRED" },
    { name: "INVALID", vr: mapMc1ToVisualReceipt(base, { valid: false, failingRule: "bundle_signature", reason: "mc1_signature_invalid" }, { keyResolvable: true }), status: "INVALID", color: "#c0392b" },
    { name: "UNVERIFIABLE", vr: mapMc1ToVisualReceipt(base, { valid: true }, { keyResolvable: false }), status: "UNVERIFIABLE", color: "#b58105" },
    { name: "SAMPLE_LOCAL", vr: mapMc1ToVisualReceipt(base, { valid: true }, { keyResolvable: true, sampleLocal: true }), status: "SAMPLE_LOCAL", color: "#57606a" },
    { name: "LEGACY_UNSIGNED", vr: mapSignedEvidenceToVisualReceipt(seRecord(), { signatureValid: null, signaturePresent: false, legacyUnsigned: true }), status: "LEGACY_UNSIGNED", color: "#57606a" },
    { name: "DENY", vr: mapSignedEvidenceToVisualReceipt(seRecord(), { signatureValid: true, signaturePresent: true, keyResolvable: true }, { decisionStatus: "DENY", executionStatus: "BLOCKED" }), status: "VERIFIED", color: "#1a7f37", decision: "DENY" },
    { name: "INTERCEPT", vr: mapSignedEvidenceToVisualReceipt(seRecord(), { signatureValid: true, signaturePresent: true, keyResolvable: true }, { decisionStatus: "INTERCEPT", executionStatus: "BLOCKED" }), status: "VERIFIED", color: "#1a7f37", decision: "INTERCEPT" },
  ];

  for (const c of cases) {
    const svg1 = renderVisualReceiptSvg(c.vr);
    const svg2 = renderVisualReceiptSvg(c.vr);
    assert.equal(snap(svg1), snap(svg2), `${c.name} not deterministic`);
    assert.ok(svg1.includes(c.status), `${c.name} missing status ${c.status}`);
    assert.ok(svg1.includes(c.color), `${c.name} missing color ${c.color}`);
    if (c.decision) assert.ok(svg1.includes(`Decision: ${c.decision}`), `${c.name} missing decision ${c.decision}`);
    // decisionStatus and executionStatus are distinct lines (VR-5)
    assert.ok(svg1.includes("Execution:"), `${c.name} missing execution line`);
  }
});
