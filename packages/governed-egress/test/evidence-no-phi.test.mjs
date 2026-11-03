/**
 * The privacy constraint (spec §4): the evidence system must not become a
 * second PHI store. Proven the only way a negative can be proven honestly —
 * with real needles: every raw SYNTHETIC_PHI value is first shown PRESENT in
 * the source document (so the needle set is real, not vacuous), then shown
 * ABSENT from every evidence entry, every receipt, and the released bytes,
 * across the SANITIZE path, the DENY paths, and the gate-refusal paths.
 *
 * The positive half guards against the empty-set green: the scan also
 * asserts the evidence DOES carry the expected hashes, categories and
 * counts, so a flow that wrote no evidence at all cannot pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governedAnthropicDocumentRequest } from '../src/adapters/anthropic/index.mjs';
import { governDocumentEgress } from '../src/pipeline.mjs';
import { releaseThroughGate } from '../src/egress/gate.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../src/evidence/log.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { buildRecordText, buildRecordPdf, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const PROMPT = 'Summarize the encounter for the requesting physician.';
const NEEDLES = Object.values(SYNTHETIC_PHI).map((v) => String(v).toLowerCase());

function makeDeps() {
  return {
    detector: createPatternDetector(),
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
  };
}

function assertNoNeedles(value, label) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const needle of NEEDLES) {
    assert.ok(!serialized.includes(needle), `raw identifier "${needle}" leaked into ${label}`);
  }
}

test('precondition: every needle is genuinely present in the source document', () => {
  const source = buildRecordText().toLowerCase();
  for (const needle of NEEDLES) {
    assert.ok(source.includes(needle), `needle "${needle}" is not in the fixture — the negative proof would be vacuous`);
  }
  assert.ok(NEEDLES.length >= 10, 'the needle set covers the whole SYNTHETIC_PHI fixture');
});

test('SANITIZE flow: no raw identifier in any evidence entry, the receipt, or the released bytes', async () => {
  const deps = makeDeps();
  const sent = [];
  const result = await governedAnthropicDocumentRequest({
    source: { bytes: buildRecordPdf(), mimeType: 'application/pdf', filename: 'encounter.pdf' },
    prompt: PROMPT,
    actor: 'analyst@healthcare.example',
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps,
    transport: {
      name: 'spy',
      async send(payload) {
        sent.push(payload);
        return { responseText: 'summary' };
      },
    },
  });

  assert.equal(result.released, true);
  const entries = deps.evidence.list();

  // Positive half first — the scan must be over something real.
  assert.ok(entries.length >= 3, 'authorized + attempt + outcome entries exist');
  const authorized = entries.find((e) => e.type === 'egress_authorized');
  assert.equal(authorized.initialClassification, 'phi_detected');
  assert.ok(authorized.detectedCount >= 12);
  for (const cat of ['PATIENT_NAME', 'MRN', 'SSN', 'PHONE', 'EMAIL', 'ADDRESS', 'INSURANCE_ID']) {
    assert.ok(authorized.detectedCategories.includes(cat), `category ${cat} recorded`);
  }
  assert.match(authorized.originalArtifactHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(authorized.releasedArtifactHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.receipt.releasedArtifactHash, /^sha256:[0-9a-f]{64}$/);

  // The negative — evidence, receipt, result envelope (minus the released
  // text, checked separately as TOKENIZED rather than merely needle-free),
  // and the outbound payload.
  assertNoNeedles(entries, 'the evidence log');
  assertNoNeedles(result.receipt, 'the receipt');
  assert.equal(sent.length, 1);
  for (const needle of NEEDLES) {
    assert.ok(!sent[0].documentText.toLowerCase().includes(needle), `released bytes carry "${needle}"`);
  }
  assert.match(sent[0].documentText, /\[SSN_\d{3}\]/, 'the released document is the tokenized form');
});

test('DENY flows leave needle-free evidence too (policy deny + prompt-borne identifiers)', async () => {
  // Policy denies PHI outright.
  const deps1 = makeDeps();
  const denyPolicy = structuredClone(HEALTHCARE_REFERENCE_POLICY);
  denyPolicy.dataEgress.externalAI.phi.action = 'deny';
  const denied = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    policy: denyPolicy,
    deps: deps1,
    transport: { name: 'spy', async send() { throw new Error('must not run'); } },
  });
  assert.equal(denied.decision, 'DENY');
  assertNoNeedles(deps1.evidence.list(), 'deny-path evidence');
  assertNoNeedles(denied.receipt, 'deny-path receipt');

  // The prompt itself carries identifiers — refused, and the refusal
  // artifacts must not echo them back.
  const deps2 = makeDeps();
  const promptDenied = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText() },
    prompt: `What is the prognosis for ${SYNTHETIC_PHI.patientName}, SSN ${SYNTHETIC_PHI.ssn}?`,
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps: deps2,
    transport: { name: 'spy', async send() { throw new Error('must not run'); } },
  });
  assert.equal(promptDenied.decision, 'DENY');
  assert.equal(promptDenied.reasonCode, 'PROMPT_CONTAINS_SENSITIVE_DATA');
  assertNoNeedles(deps2.evidence.list(), 'prompt-deny evidence');
  assertNoNeedles(promptDenied.receipt, 'prompt-deny receipt');
  // The refusal detail names categories and counts, never the values.
  assertNoNeedles({ detail: promptDenied.detail }, 'the prompt-deny detail message');
});

test('gate-refusal denial evidence carries hashes of the presented bytes, never the bytes', async () => {
  const deps = makeDeps();
  const governed = await governDocumentEgress({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    destination: { provider: 'anthropic', service: 'claude' },
    purpose: 'document_analysis',
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps,
  });
  assert.equal(governed.outcome, 'SANITIZE');

  // Present the RAW record at the gate under the sanitized authorization —
  // the §10 substitution attack. Refused, and the denial entry must carry
  // only the presented hash.
  const refused = await releaseThroughGate({
    store: deps.store,
    evidence: deps.evidence,
    transport: { name: 'spy', async send() { throw new Error('must not run'); } },
    authorizationId: governed.authorization.authorizationId,
    artifactText: buildRecordText(),
    prompt: PROMPT,
    destination: { provider: 'anthropic', service: 'claude' },
    purpose: 'document_analysis',
  });
  assert.equal(refused.reasonCode, 'ARTIFACT_MISMATCH');
  const denial = deps.evidence.list().find((e) => e.type === 'egress_denied');
  assert.ok(denial, 'the gate refusal was recorded');
  assert.match(denial.presentedArtifactHash, /^[0-9a-f]{64}$/);
  assertNoNeedles(deps.evidence.list(), 'gate-refusal evidence');
});

test('the transformation mapping detail on the ARTIFACT stays out of evidence and receipts by construction', async () => {
  // artifact.transformation.mappings is a working detail the caller may
  // inspect (category + token only — proven in detection-transform tests);
  // this pins that neither the evidence writer nor the receipt builder
  // copies the mappings array at all, so the constraint cannot regress by
  // a mapping later gaining a raw-value field.
  const deps = makeDeps();
  const result = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps,
    transport: { name: 'spy', async send() { return { responseText: 'ok' }; } },
  });
  assert.ok(Array.isArray(result.artifact.transformation.mappings));
  const serializedEvidence = JSON.stringify(deps.evidence.list());
  const serializedReceipt = JSON.stringify(result.receipt);
  assert.ok(!serializedEvidence.includes('"mappings"'), 'evidence carries transformation counts, never mappings');
  assert.ok(!serializedReceipt.includes('"mappings"'), 'the receipt carries transformation counts, never mappings');
});
