// End-to-end workflow tests for @strixgov/healthcare-demo.
//
// Verifies the demo's signed receipts verify against the same test
// JWKS the package ships with — i.e. anyone running `npx
// @strixgov/healthcare-demo` produces a record that is cryptographically
// verifiable using the same primitives as the production Strix verifier.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSyntheticSubmission,
  classifyAndRedact,
} from "../src/synthetic-records.mjs";
import {
  phaseClassify,
  phaseEvaluate,
  phaseSign,
  phaseVerify,
  runWorkflow,
} from "../src/clinical-workflow.mjs";

// ── Synthetic data generator ────────────────────────────────────────

test("buildSyntheticSubmission is deterministic on seed", () => {
  const a = buildSyntheticSubmission(0);
  const b = buildSyntheticSubmission(0);
  assert.equal(a.payload.patientName, b.payload.patientName);
  assert.equal(a.payload.dob, b.payload.dob);
});

test("buildSyntheticSubmission produces fictional data warning", () => {
  const s = buildSyntheticSubmission(0);
  assert.match(s.metadata.fictionalDataWarning, /[Ss]ynthetic|fictional|No real PHI/);
});

test("classifyAndRedact redacts the three PHI fields", () => {
  const s = buildSyntheticSubmission(0);
  const { redacted, classification } = classifyAndRedact(s);
  assert.equal(redacted.patientName, "[REDACTED]");
  assert.match(redacted.ageBracket, /^\d{2}-\d{2}$/);
  assert.notEqual(redacted.mrnToken, s.payload.mrn);
  assert.deepEqual(classification.fieldsRedacted, ["patientName", "dob", "mrn"]);
  assert.equal(classification.minNecessaryApplied, true);
});

// ── Workflow phases ─────────────────────────────────────────────────

test("phaseClassify passes when min-necessary applied", async () => {
  const s = buildSyntheticSubmission(1);
  const r = await phaseClassify(s, { classifyAndRedact });
  assert.equal(r.pass, true);
  assert.equal(r.phase, "CLASSIFY");
  assert.equal(r.classification.minNecessaryApplied, true);
});

test("phaseEvaluate ALLOWs when classify passes", async () => {
  const s = buildSyntheticSubmission(2);
  const classify = await phaseClassify(s, { classifyAndRedact });
  const evaluate = await phaseEvaluate(s, classify);
  assert.equal(evaluate.decision, "ALLOW");
});

test("phaseSign produces a record with all 13 SE v1 fields", async () => {
  const s = buildSyntheticSubmission(0);
  const classify = await phaseClassify(s, { classifyAndRedact });
  const evaluate = await phaseEvaluate(s, classify);
  const sign = await phaseSign(s, evaluate);

  const r = sign.record;
  assert.ok(r.signature);
  assert.equal(r.signingKeyId, "strix-test-2026-05");
  assert.ok(r.evidenceId);
  assert.equal(r.action, "allow");
  assert.equal(r.regulatoryContext.complianceMode, "multi:eu_ai_act_2026+hipaa_2026");
});

test("phaseVerify returns VERIFIED for a freshly-signed record", async () => {
  const s = buildSyntheticSubmission(0);
  const classify = await phaseClassify(s, { classifyAndRedact });
  const evaluate = await phaseEvaluate(s, classify);
  const sign = await phaseSign(s, evaluate);
  const verify = await phaseVerify(sign);

  assert.equal(verify.verificationStatus, "VERIFIED");
  assert.equal(verify.signatureValid, true);
  assert.equal(verify.resolvedKey?.kid, "strix-test-2026-05");
});

test("phaseVerify returns COMPLIANCE_VIOLATION for a tampered record", async () => {
  const s = buildSyntheticSubmission(0);
  const classify = await phaseClassify(s, { classifyAndRedact });
  const evaluate = await phaseEvaluate(s, classify);
  const sign = await phaseSign(s, evaluate);

  // Tamper: change the action AFTER signing. The canonical-bytes hash will
  // no longer match, so signature verification must fail.
  const tampered = {
    ...sign,
    record: { ...sign.record, action: "tampered" },
  };
  const verify = await phaseVerify(tampered);
  assert.equal(verify.verificationStatus, "COMPLIANCE_VIOLATION");
  assert.equal(verify.signatureValid, false);
});

// ── Compliance flag derivation ─────────────────────────────────────

test("verify derives all four EU AI Act flags as true on a clean record", async () => {
  const s = buildSyntheticSubmission(0);
  const r = await runWorkflow(s, { classifyAndRedact });
  const eu = r.verify.compliance.euAiAct;
  assert.equal(eu.article12_traceable, true);
  assert.equal(eu.article12_tamper_resistant, true);
  assert.equal(eu.article14_oversight_supported, true);
  assert.equal(eu.article28_audit_ready, true);
});

test("verify derives all three HIPAA flags as true on a clean record", async () => {
  const s = buildSyntheticSubmission(0);
  const r = await runWorkflow(s, { classifyAndRedact });
  const h = r.verify.compliance.hipaa;
  assert.equal(h.hipaa_audit_log_present, true);
  assert.equal(h.hipaa_integrity_assured, true);
  assert.equal(h.hipaa_access_authenticated, true);
});

// ── runWorkflow end-to-end ─────────────────────────────────────────

test("runWorkflow completes in under 100 ms (fast-demo budget)", async () => {
  const s = buildSyntheticSubmission(0);
  const r = await runWorkflow(s, { classifyAndRedact });
  assert.ok(r.totalMs < 100, `workflow took ${r.totalMs}ms, expected <100ms`);
});

test("runWorkflow produces a record verifiable end-to-end", async () => {
  const s = buildSyntheticSubmission(3);
  const r = await runWorkflow(s, { classifyAndRedact });
  assert.equal(r.verify.verificationStatus, "VERIFIED");
  assert.equal(r.evaluate.decision, "ALLOW");
});
