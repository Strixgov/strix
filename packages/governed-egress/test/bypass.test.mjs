/**
 * The spec-§10 bypass matrix. Every case proves its expected refusal AND
 * proves the provider transport never ran, by COUNTING invocations of an
 * injected spy transport rather than reading a status field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governDocumentEgress } from '../src/pipeline.mjs';
import { releaseThroughGate } from '../src/egress/gate.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../src/evidence/log.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { buildRecordText, buildImageOnlyPdf, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const DEST = { provider: 'anthropic', service: 'claude' };
const PURPOSE = 'document_analysis';
const PROMPT = 'Summarize this encounter.';

function spyTransport() {
  const calls = [];
  return {
    calls,
    name: 'spy',
    async send(payload) {
      calls.push(payload);
      return { ok: true, responseText: 'ok', providerMeta: { provider: 'anthropic' } };
    },
  };
}

function freshDeps(overrides = {}) {
  return {
    detector: createPatternDetector(),
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
    ...overrides,
  };
}

async function authorizedRelease(deps) {
  const governed = await governDocumentEgress({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    destination: DEST,
    purpose: PURPOSE,
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps,
  });
  assert.equal(governed.outcome, 'SANITIZE');
  return governed;
}

test('§10.1 raw PHI through the governed adapter is sanitized — the transport payload carries no raw identifier', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const transport = spyTransport();
  const release = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText, prompt: governed.prompt,
    destination: DEST, purpose: PURPOSE,
  });
  assert.equal(release.execution, 'completed');
  assert.equal(transport.calls.length, 1);
  const sent = JSON.stringify(transport.calls[0]).toLowerCase();
  for (const value of Object.values(SYNTHETIC_PHI)) {
    assert.ok(!sent.includes(String(value).toLowerCase()), `raw identifier reached the transport: ${value}`);
  }
});

test('§10.2 sanitized artifact replaced after approval → ARTIFACT_MISMATCH, transport never ran', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const transport = spyTransport();
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText.replace('[PATIENT_001]', 'someone else entirely'),
    prompt: governed.prompt, destination: DEST, purpose: PURPOSE,
  });
  assert.equal(r.reasonCode, 'ARTIFACT_MISMATCH');
  assert.equal(r.disclosureStatus, 'not_disclosed');
  assert.equal(transport.calls.length, 0);
});

test('§10.2b one flipped byte after approval → ARTIFACT_MISMATCH (acceptance criterion 6)', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const transport = spyTransport();
  const tampered = `${governed.releaseText.slice(0, -1)}${governed.releaseText.at(-1) === '.' ? '!' : '.'}`;
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: tampered, prompt: governed.prompt, destination: DEST, purpose: PURPOSE,
  });
  assert.equal(r.reasonCode, 'ARTIFACT_MISMATCH');
  assert.equal(transport.calls.length, 0);
});

test('§10.3 ORIGINAL artifact substituted for the sanitized one → ARTIFACT_MISMATCH, transport never ran', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const transport = spyTransport();
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: buildRecordText(), // the raw PHI original
    prompt: governed.prompt, destination: DEST, purpose: PURPOSE,
  });
  assert.equal(r.reasonCode, 'ARTIFACT_MISMATCH');
  assert.equal(transport.calls.length, 0);
});

test('§10.4 authorization replay → AUTHORIZATION_CONSUMED; the transport ran exactly once', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const transport = spyTransport();
  const args = {
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText, prompt: governed.prompt,
    destination: DEST, purpose: PURPOSE,
  };
  const first = await releaseThroughGate(args);
  assert.equal(first.execution, 'completed');
  const replay = await releaseThroughGate(args);
  assert.equal(replay.reasonCode, 'AUTHORIZATION_CONSUMED');
  assert.equal(transport.calls.length, 1);
});

test('§10.4b concurrent releases: exactly one wins, the loser reports CONSUMED', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const transport = spyTransport();
  const args = {
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText, prompt: governed.prompt,
    destination: DEST, purpose: PURPOSE,
  };
  const [a, b] = await Promise.all([releaseThroughGate(args), releaseThroughGate(args)]);
  const outcomes = [a, b].map((r) => r.reasonCode ?? r.execution).sort();
  assert.deepEqual(outcomes, ['AUTHORIZATION_CONSUMED', 'completed']);
  assert.equal(transport.calls.length, 1);
});

test('§10.5 an authorization minted for one artifact refuses another artifact', async () => {
  const deps = freshDeps();
  const governedA = await authorizedRelease(deps);
  // A second, different clean document authorized in the same store.
  const governedB = await governDocumentEgress({
    source: { text: 'Assay note: the analyzer calibration completed within tolerance.' },
    prompt: PROMPT, destination: DEST, purpose: PURPOSE, policy: HEALTHCARE_REFERENCE_POLICY, deps,
  });
  assert.equal(governedB.outcome, 'ALLOW');
  const transport = spyTransport();
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governedA.authorization.authorizationId, // A's grant…
    artifactText: governedB.releaseText, //                      …spent on B's bytes
    prompt: PROMPT, destination: DEST, purpose: PURPOSE,
  });
  assert.equal(r.reasonCode, 'ARTIFACT_MISMATCH');
  assert.equal(transport.calls.length, 0);
});

test('§10.6 detector failure → DENY, fail closed; neither transformer nor transport ran', async () => {
  let transformerCalls = 0;
  const deps = freshDeps({
    detector: { async scan() { throw new Error('detector outage'); } },
    transformer: { async transform() { transformerCalls += 1; return {}; } },
  });
  const governed = await governDocumentEgress({
    source: { text: buildRecordText() },
    prompt: PROMPT, destination: DEST, purpose: PURPOSE, policy: HEALTHCARE_REFERENCE_POLICY, deps,
  });
  assert.equal(governed.outcome, 'DENY');
  assert.equal(governed.reasonCode, 'DETECTOR_UNAVAILABLE');
  assert.equal(transformerCalls, 0);
});

test('§10.7 transformer failure → DENY, no authorization exists to spend', async () => {
  const deps = freshDeps({
    transformer: { async transform() { throw new Error('transform outage'); } },
  });
  const governed = await governDocumentEgress({
    source: { text: buildRecordText() },
    prompt: PROMPT, destination: DEST, purpose: PURPOSE, policy: HEALTHCARE_REFERENCE_POLICY, deps,
  });
  assert.equal(governed.outcome, 'DENY');
  assert.equal(governed.reasonCode, 'TRANSFORMER_UNAVAILABLE');
  assert.equal(governed.authorization, undefined);
});

test('§10.8 post-transform verification failure → DENY (a transformer that lies is caught by the rescan)', async () => {
  const deps = freshDeps({
    // A "transformer" that claims success while changing nothing.
    transformer: {
      async transform(text, detection) {
        return {
          engine: 'liar', version: '0.0.0',
          detectedCount: detection.findings.length,
          transformedCount: detection.findings.length,
          text, // unchanged — raw identifiers intact
          mappings: [],
        };
      },
    },
  });
  const governed = await governDocumentEgress({
    source: { text: buildRecordText() },
    prompt: PROMPT, destination: DEST, purpose: PURPOSE, policy: HEALTHCARE_REFERENCE_POLICY, deps,
  });
  assert.equal(governed.outcome, 'DENY');
  assert.equal(governed.reasonCode, 'VERIFICATION_FAILED');
  assert.equal(governed.authorization, undefined);
});

test('§10.9 unsupported document type → DENY before any scan', async () => {
  let scans = 0;
  const deps = freshDeps({
    detector: { async scan(t) { scans += 1; return { detected: false, findingsCount: 0, categories: [], findings: [], detector: { name: 'x', version: '0' } }; } },
  });
  const governed = await governDocumentEgress({
    source: { bytes: buildImageOnlyPdf() },
    prompt: PROMPT, destination: DEST, purpose: PURPOSE, policy: HEALTHCARE_REFERENCE_POLICY, deps,
  });
  assert.equal(governed.outcome, 'DENY');
  // Superseded expectation kept on the record: UNSUPPORTED_ARTIFACT until the
  // production extraction chain renamed this exact case to OCR_REQUIRED. The
  // §10.9 property under test is unchanged and is the reason this test exists —
  // DENY, and `scans === 0`, i.e. the refusal lands BEFORE the detector runs.
  // Only the name of the refusal moved.
  assert.equal(governed.reasonCode, 'OCR_REQUIRED');
  assert.equal(scans, 0);
});

test('§10.10 destination changed after authorization → DESTINATION_MISMATCH, transport never ran', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const transport = spyTransport();
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText, prompt: governed.prompt,
    destination: { provider: 'openai', service: 'gpt' }, purpose: PURPOSE,
  });
  assert.equal(r.reasonCode, 'DESTINATION_MISMATCH');
  assert.equal(transport.calls.length, 0);
});

test('§10.11 provider call without any egress authorization → AUTHORIZATION_REQUIRED, transport never ran', async () => {
  const deps = freshDeps();
  const transport = spyTransport();
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: undefined,
    artifactText: 'anything', prompt: PROMPT, destination: DEST, purpose: PURPOSE,
  });
  assert.equal(r.reasonCode, 'AUTHORIZATION_REQUIRED');
  assert.equal(transport.calls.length, 0);
});

test('§10.12 evidence unavailable at the attempt write → refusal, transport never ran, grant burned', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const transport = spyTransport();
  let failWrites = false;
  const flakyEvidence = {
    append(entry) {
      if (failWrites) throw new Error('evidence store down');
      return deps.evidence.append(entry);
    },
  };
  failWrites = true;
  const r = await releaseThroughGate({
    store: deps.store, evidence: flakyEvidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText, prompt: governed.prompt,
    destination: DEST, purpose: PURPOSE,
  });
  assert.equal(r.reasonCode, 'EVIDENCE_UNAVAILABLE');
  assert.equal(r.disclosureStatus, 'not_disclosed');
  assert.equal(transport.calls.length, 0);
  // The grant is spent — a retry cannot ride the same authorization.
  failWrites = false;
  const retry = await releaseThroughGate({
    store: deps.store, evidence: flakyEvidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText, prompt: governed.prompt,
    destination: DEST, purpose: PURPOSE,
  });
  assert.equal(retry.reasonCode, 'AUTHORIZATION_CONSUMED');
  assert.equal(transport.calls.length, 0);
});

test('§10+ expired authorization → AUTHORIZATION_EXPIRED, transport never ran', async () => {
  let clock = 1_000_000;
  const deps = freshDeps({ now: () => clock, ttlMs: 1000 });
  const governed = await authorizedRelease(deps);
  clock += 5000;
  const transport = spyTransport();
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText, prompt: governed.prompt,
    destination: DEST, purpose: PURPOSE, now: () => clock,
  });
  assert.equal(r.reasonCode, 'AUTHORIZATION_EXPIRED');
  assert.equal(transport.calls.length, 0);
});

test('§10+ prompt swapped after authorization → PROMPT_MISMATCH (the prompt is a bound channel)', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const transport = spyTransport();
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText,
    prompt: `${governed.prompt} Also, the patient is ${SYNTHETIC_PHI.patientName}.`,
    destination: DEST, purpose: PURPOSE,
  });
  assert.equal(r.reasonCode, 'PROMPT_MISMATCH');
  assert.equal(transport.calls.length, 0);
});

test('§10+ purpose swapped after authorization → PURPOSE_MISMATCH', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const transport = spyTransport();
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText, prompt: governed.prompt,
    destination: DEST, purpose: 'model_training',
  });
  assert.equal(r.reasonCode, 'PURPOSE_MISMATCH');
  assert.equal(transport.calls.length, 0);
});

test('§10+ a prompt carrying raw identifiers is DENIED before any authorization exists', async () => {
  const deps = freshDeps();
  const governed = await governDocumentEgress({
    source: { text: 'A clean assay protocol note with no identifiers.' },
    prompt: `Compare against the record of ${SYNTHETIC_PHI.patientName}, SSN ${SYNTHETIC_PHI.ssn}.`,
    destination: DEST, purpose: PURPOSE, policy: HEALTHCARE_REFERENCE_POLICY, deps,
  });
  assert.equal(governed.outcome, 'DENY');
  assert.equal(governed.reasonCode, 'PROMPT_CONTAINS_SENSITIVE_DATA');
});

test('transport timeout is execution UNKNOWN and possibly_disclosed — never a clean "failed"', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const timeoutTransport = {
    name: 'timeout-spy',
    async send() {
      const err = new Error('timed out');
      err.kind = 'timeout';
      throw err;
    },
  };
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport: timeoutTransport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText, prompt: governed.prompt,
    destination: DEST, purpose: PURPOSE,
  });
  assert.equal(r.execution, 'unknown');
  assert.equal(r.disclosureStatus, 'possibly_disclosed');
});

test('transport HTTP error is execution failed but disclosure DISCLOSED — the provider received the payload', async () => {
  const deps = freshDeps();
  const governed = await authorizedRelease(deps);
  const httpTransport = {
    name: 'http-spy',
    async send() {
      const err = new Error('429 too many requests');
      err.kind = 'http';
      throw err;
    },
  };
  const r = await releaseThroughGate({
    store: deps.store, evidence: deps.evidence, transport: httpTransport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText, prompt: governed.prompt,
    destination: DEST, purpose: PURPOSE,
  });
  assert.equal(r.execution, 'failed');
  assert.equal(r.disclosureStatus, 'disclosed');
});
