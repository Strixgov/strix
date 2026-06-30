#!/usr/bin/env node
// @strixgov/healthcare-demo — 30-second clinical AI agent governance demo.
//
// What this does (offline, no Strix backend):
//   1. Generates a synthetic clinical submission (NO real PHI)
//   2. Classifies + applies HIPAA minimum-necessary redaction
//   3. Evaluates the action against demo policy
//   4. Signs an SE v1 canonical receipt with a throwaway TEST key
//   5. Verifies the receipt cryptographically
//   6. Derives + prints the HIPAA Technical Safeguards + EU AI Act
//      compliance flags from the verification outcome
//
// Runtime: ~3 seconds end-to-end. No network. No Strix account.

import {
  buildSyntheticSubmission,
  classifyAndRedact,
} from "../src/synthetic-records.mjs";
import { runWorkflow } from "../src/clinical-workflow.mjs";

// ── Terminal styling (no deps; just ANSI escapes) ───────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (color, s) => (useColor ? `${ANSI[color]}${s}${ANSI.reset}` : s);
const bold = (s) => c("bold", s);
const dim = (s) => c("dim", s);

function hr() {
  console.log(dim("─".repeat(70)));
}

function header(title) {
  console.log("");
  console.log(bold(c("cyan", title)));
  hr();
}

function flagLine(name, value) {
  const marker = value ? c("green", "✓") : c("red", "✗");
  const labelColor = value ? "green" : "dim";
  console.log(`  ${marker} ${c(labelColor, name)}`);
}

function field(label, value, color = null) {
  const v = color ? c(color, String(value)) : String(value);
  console.log(`  ${dim(label.padEnd(18))} ${v}`);
}

// ── Banner ──────────────────────────────────────────────────────────

console.log("");
console.log(bold(c("cyan", "  STRIX · Clinical AI Agent Governance Demo")));
console.log(c("dim", "  Synthetic patient data. No real PHI. No Strix backend."));
console.log("");

// ── Phase 0: generate the synthetic submission ──────────────────────

const seed = parseInt(process.env.STRIX_DEMO_SEED || `${Date.now() % 5}`, 10);
const submission = buildSyntheticSubmission(seed);

header("Step 1 of 4 · INTAKE — clinician submits patient note");
field("Clinician", submission.actor.id, "cyan");
field("Role", submission.actor.role);
field("Capability", submission.capability, "cyan");
console.log("");
console.log(dim("  Submitted note (raw):"));
field("Patient name", submission.payload.patientName, "yellow");
field("DOB", submission.payload.dob, "yellow");
field("MRN", submission.payload.mrn, "yellow");
field("Note", submission.payload.note);
console.log("");
console.log(dim(`  ${submission.metadata.fictionalDataWarning}`));

// ── Run the workflow ────────────────────────────────────────────────

const result = await runWorkflow(submission, { classifyAndRedact });

// ── Step 2: classify + redact ───────────────────────────────────────

header("Step 2 of 4 · CLASSIFY — kernel applies minimum-necessary");
const classify = result.classify;
field("PHI present", classify.classification.phiPresent, "yellow");
field("Fields redacted", classify.classification.fieldsRedacted.join(", "), "red");
field("Fields retained", classify.classification.fieldsRetained.join(", "), "green");
console.log("");
console.log(dim("  Redacted payload (what the AI model actually sees):"));
field("Patient name", classify.redacted.patientName, "green");
field("Age bracket", classify.redacted.ageBracket, "green");
field("MRN token", classify.redacted.mrnToken, "green");
field("Note", classify.redacted.note);

// ── Step 3: evaluate + sign ─────────────────────────────────────────

header("Step 3 of 4 · EVALUATE + SIGN — policy + Ed25519");
const ev = result.evaluate;
const sign = result.sign;
const decisionColor = ev.decision === "ALLOW" ? "green" : ev.decision === "DENY" ? "red" : "yellow";
field("Decision", ev.decision, decisionColor);
field("Policy version", ev.policy_version);
field("Reason", ev.reason);
console.log("");
field("Evidence ID", sign.record.evidenceId, "cyan");
field("Signing key", sign.record.signingKeyId, "cyan");
field("Environment", sign.record.environment);
field("Tenant", sign.record.tenantId);
field("Signature", `${sign.record.signature.slice(0, 24)}…${sign.record.signature.slice(-8)}`, "dim");
field("Canonical SHA-256", `${sign.canonicalBytesSha256.slice(0, 16)}…`, "dim");

// ── Step 4: verify + derive compliance ──────────────────────────────

header("Step 4 of 4 · VERIFY — cryptographic + regulatory derivation");
const v = result.verify;
const statusColor = v.verificationStatus === "VERIFIED" ? "green" : "red";
field("Status", v.verificationStatus, statusColor);
field("Signature valid", v.signatureValid, v.signatureValid ? "green" : "red");
field("Resolved key", v.resolvedKey?.kid ?? "—", "cyan");

console.log("");
console.log(dim("  EU AI Act compliance (derived, never asserted):"));
if (v.compliance.euAiAct) {
  flagLine("Article 12 · Traceability", v.compliance.euAiAct.article12_traceable);
  flagLine("Article 12 · Tamper-Resistance", v.compliance.euAiAct.article12_tamper_resistant);
  flagLine("Article 14 · Human Oversight Supported", v.compliance.euAiAct.article14_oversight_supported);
  flagLine("Article 28 · Audit Ready", v.compliance.euAiAct.article28_audit_ready);
} else {
  console.log(dim("  (not requested by this record)"));
}

console.log("");
console.log(dim("  HIPAA Technical Safeguards (45 CFR §164.312, derived):"));
if (v.compliance.hipaa) {
  flagLine("§164.312(b) · Audit Log Present", v.compliance.hipaa.hipaa_audit_log_present);
  flagLine("§164.312(c)(1) · Integrity Assured", v.compliance.hipaa.hipaa_integrity_assured);
  flagLine("§164.312(d) · Access Authenticated", v.compliance.hipaa.hipaa_access_authenticated);
} else {
  console.log(dim("  (not requested by this record)"));
}

// ── Summary ─────────────────────────────────────────────────────────

header("Summary");
field("Total time", `${result.totalMs} ms`, "green");
field("PHI protection", classify.classification.minNecessaryApplied ? "minimum-necessary applied" : "NOT APPLIED", classify.classification.minNecessaryApplied ? "green" : "red");
field("Cryptographic proof", v.signatureValid ? "Ed25519 verified" : "verification failed", v.signatureValid ? "green" : "red");
field("Independently verifiable?", "yes (no Strix backend in trust path)", "green");

console.log("");
console.log(bold("  What you just saw, in production:"));
console.log("");
console.log("    • Every clinical AI tool call passes through this same flow");
console.log("    • PHI gets redacted " + bold("before") + " the model ever sees it");
console.log("    • The decision is " + bold("cryptographically signed") + " at the moment it happens");
console.log("    • Any auditor, regulator, or partner can verify the receipt with");
console.log("      no Strix infrastructure: " + c("cyan", "npx @strixgov/verifier@latest <id>"));
console.log("");
console.log(dim("  Run again with different fictional data:"));
console.log(c("dim", `    STRIX_DEMO_SEED=${(seed + 1) % 5} npx @strixgov/healthcare-demo`));
console.log("");
console.log(dim("  Learn more: ") + c("cyan", "https://verify.strixgov.com/healthcare"));
console.log("");
