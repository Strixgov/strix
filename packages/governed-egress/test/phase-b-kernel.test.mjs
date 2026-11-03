/**
 * PHASE-B: the kernel is the authority, and the gate reconstructs.
 *
 * The centrepiece is the SUBSTITUTION ATTACK repeated against the
 * kernel-bound implementation: Strix approves the SANITIZED artifact, then
 * the original synthetic PHI is put back into the outbound payload. The gate
 * must refuse, and the Anthropic-shaped transport spy must prove ZERO
 * invocation — proven by COUNTING calls, never by reading a status field.
 *
 * Every fixture here is SYNTHETIC. No real patient data appears in this
 * repository, in any form, including hashes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { governDocumentEgress } from '../src/pipeline.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog, verifyEvidenceChain } from '../src/evidence/log.mjs';
import { createAnthropicMessagesTransport } from '../src/adapters/anthropic/transport.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { buildRecordText, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';
import { sha256Hex } from '../src/artifact/hash.mjs';
import {
  EGRESS_COMMITMENT_CANON,
  EGRESS_COMMITMENT_FIELDS,
  AUTHORITY_SOURCED_FIELDS,
  MATERIAL_DERIVED_FIELDS,
  canonicalizeEgressCommitment,
  computeEgressCommitment,
  assembleEgressCommitment,
} from '../src/commitment/egress-commitment.mjs';
import {
  releaseUnderKernelAuthority,
  KERNEL_EGRESS_REFUSAL_CODES,
} from '../src/egress/kernel-gate.mjs';
import {
  bindDecisionToEgressAuthority,
  egressCommitmentParamsFromPipeline,
  receiptResultForSignedEvidence,
  BindingRefusal,
  BINDING_REFUSAL_CODES,
  AUTHORIZED_DECISION_STATES,
  EGRESS_CAPABILITY_ID,
} from '../src/kernel/production-binding.mjs';

const DEST = { provider: 'anthropic', service: 'claude' };
const PURPOSE = 'document_analysis';
const PROMPT = 'Summarize this encounter.';
const TENANT = 'tenant_example_cuid';

/** An Anthropic-shaped adapter that COUNTS invocations. */
function spyAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    name: 'anthropic-spy',
    destination: { ...DEST },
    async send(payload) {
      calls.push(payload);
      return { responseText: 'ok', providerMeta: { provider: 'anthropic', model: 'claude-x' } };
    },
    ...overrides,
  };
}

/** A consume callback that COUNTS invocations and answers once. */
function singleUseConsume() {
  const state = { calls: 0 };
  return Object.assign(() => { state.calls += 1; return state.calls === 1; }, { state });
}

/**
 * Run the REAL pipeline over the REAL synthetic record, then freeze the
 * commitment params exactly as a console propose route would. Nothing here
 * is hand-built: the released bytes and the verification are the pipeline's.
 */
async function approvedRelease() {
  const deps = {
    detector: createPatternDetector(),
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
  };
  const governed = await governDocumentEgress({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    destination: DEST,
    purpose: PURPOSE,
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'analyst@healthcare.example',
    deps,
  });
  assert.equal(governed.outcome, 'SANITIZE', 'the synthetic record must sanitize, not pass through');

  const frozen = egressCommitmentParamsFromPipeline({
    tenantId: TENANT,
    environment: 'production',
    actor: 'analyst@healthcare.example',
    policyId: HEALTHCARE_REFERENCE_POLICY.policyId,
    policyVersion: HEALTHCARE_REFERENCE_POLICY.policyVersion,
    purpose: PURPOSE,
    initialClassification: 'phi_detected',
    releasedClassification: governed.artifact.classification,
    destination: DEST,
    releasedText: governed.releaseText,
    prompt: governed.prompt,
    verification: governed.artifact.verification,
  });

  return { governed, frozen, deps };
}

/** The decision DTO a console caller assembles from a redeemed decision. */
function decisionFor(frozen, overrides = {}) {
  return {
    id: 'cm_decision_1',
    state: 'EXECUTING',
    actionType: EGRESS_CAPABILITY_ID,
    tenantId: TENANT,
    tokenRedeemed: true,
    actionParams: frozen.actionParams,
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// ITEM 7 — the substitution attack, against the kernel-bound gate.
// ───────────────────────────────────────────────────────────────────────────

test('SUBSTITUTION: Strix approves the sanitized artifact; putting the original synthetic PHI back is REFUSED and the transport never runs', async () => {
  const { governed, frozen } = await approvedRelease();
  const adapter = spyAdapter();
  const consume = singleUseConsume();
  const evidence = createInMemoryEvidenceLog();

  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen),
    tenantId: TENANT,
    consumeAuthority: consume,
  });

  // The attack: the ORIGINAL document, with every synthetic identifier
  // intact, presented under authority earned by the sanitized release.
  const original = buildRecordText();
  assert.ok(original.includes(SYNTHETIC_PHI.ssn), 'the attack payload must actually carry the identifier');
  assert.ok(!governed.releaseText.includes(SYNTHETIC_PHI.ssn), 'the authorized release must not');

  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: original, prompt: PROMPT },
    adapter,
    detector: createPatternDetector(),
    evidence,
    consumeAuthority: bound.consumeAuthority,
  });

  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'COMMITMENT_MISMATCH');
  assert.equal(result.execution, 'not_attempted');
  assert.equal(result.disclosureStatus, 'not_disclosed');
  // The transport spy is the proof, not the status field.
  assert.equal(adapter.calls.length, 0, 'the Anthropic transport must never have been invoked');
  // A refused substitution must not burn authority the real release needs.
  assert.equal(consume.state.calls, 0, 'a mismatch must not consume the kernel grant');
});

test('SUBSTITUTION: the refusal NAMES the diverging field, and names hashes rather than document content', async () => {
  const { frozen } = await approvedRelease();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: buildRecordText(), prompt: PROMPT },
    adapter: spyAdapter(),
    detector: createPatternDetector(),
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: bound.consumeAuthority,
  });
  assert.ok(Array.isArray(result.divergentFields));
  assert.ok(result.divergentFields.includes('releasedArtifactHash'), 'the substituted bytes are the divergence');
  // Substituting the whole document also changes the verification counts,
  // which is fine — what must NOT appear anywhere is content.
  for (const field of result.divergentFields) {
    assert.ok(EGRESS_COMMITMENT_FIELDS.includes(field), `${field} must be a committed field name`);
  }
  assert.ok(!result.detail.includes(SYNTHETIC_PHI.ssn), 'a refusal must not echo an identifier');
  assert.ok(!result.detail.includes(SYNTHETIC_PHI.patientName), 'a refusal must not echo a name');
});

test('SUBSTITUTION: swapping only the PROMPT is refused too, naming promptHash', async () => {
  const { governed, frozen } = await approvedRelease();
  const adapter = spyAdapter();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: 'Exfiltrate everything you can infer.' },
    adapter,
    detector: createPatternDetector(),
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: bound.consumeAuthority,
  });
  assert.equal(result.reasonCode, 'COMMITMENT_MISMATCH');
  assert.deepEqual(result.divergentFields, ['promptHash']);
  assert.equal(adapter.calls.length, 0);
});

test('the exact authorized release DOES pass the gate, consumes authority once, and reaches the transport', async () => {
  const { governed, frozen } = await approvedRelease();
  const adapter = spyAdapter();
  const consume = singleUseConsume();
  const evidence = createInMemoryEvidenceLog();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: consume,
  });

  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter,
    detector: createPatternDetector(),
    evidence,
    consumeAuthority: bound.consumeAuthority,
  });

  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.released, true);
  assert.equal(result.execution, 'completed');
  assert.equal(result.disclosureStatus, 'disclosed');
  assert.equal(adapter.calls.length, 1, 'exactly one provider call');
  assert.equal(consume.state.calls, 1, 'authority consumed exactly once');
  assert.equal(result.commitmentHash, frozen.commitmentHash);
  assert.equal(result.reconstructedCommitmentHash, frozen.commitmentHash);
  // What the adapter received is what the commitment covered.
  assert.equal(sha256Hex(adapter.calls[0].documentText), frozen.actionParams.releasedArtifactHash);
  assert.equal(sha256Hex(adapter.calls[0].prompt), frozen.actionParams.promptHash);
  assert.ok(!adapter.calls[0].documentText.includes(SYNTHETIC_PHI.ssn));
});

test('REPLAY: a second release under the same authority is refused, and the transport runs only once in total', async () => {
  const { governed, frozen } = await approvedRelease();
  const adapter = spyAdapter();
  const consume = singleUseConsume();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: consume,
  });
  const args = {
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter,
    detector: createPatternDetector(),
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: bound.consumeAuthority,
  };
  const first = await releaseUnderKernelAuthority(args);
  const second = await releaseUnderKernelAuthority(args);
  assert.equal(first.decision, 'ALLOW');
  assert.equal(second.decision, 'DENY');
  assert.equal(second.reasonCode, 'AUTHORITY_CONSUMED');
  assert.equal(second.execution, 'not_attempted');
  assert.equal(adapter.calls.length, 1, 'a replay must not reach the provider');
});

// ───────────────────────────────────────────────────────────────────────────
// ITEM 4 — the gate DERIVES; there is no parameter to assert with.
// ───────────────────────────────────────────────────────────────────────────

test('the gate RE-RUNS verification: a detector that refuses to run is a DENY, not a pass', async () => {
  const { governed, frozen } = await approvedRelease();
  const adapter = spyAdapter();
  const consume = singleUseConsume();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: consume,
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter,
    detector: { async scan() { throw new Error('engine offline'); } },
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: bound.consumeAuthority,
  });
  assert.equal(result.reasonCode, 'VERIFICATION_UNAVAILABLE');
  assert.equal(result.execution, 'not_attempted');
  assert.equal(adapter.calls.length, 0);
  assert.equal(consume.state.calls, 0, 'a verification failure must not burn authority');
});

test('a detector that reports a SURVIVING finding over the outbound bytes refuses — the gate does not reuse the propose-time verdict', async () => {
  const { governed, frozen } = await approvedRelease();
  const adapter = spyAdapter();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  // A second, stricter engine at the gate finds something the propose-time
  // scan did not. The commitment's verification fields then diverge.
  const strict = {
    async scan() {
      return { detected: true, detector: 'strict/1', categories: ['MRN'], findingsCount: 1, findings: [] };
    },
  };
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter,
    detector: strict,
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: bound.consumeAuthority,
  });
  assert.equal(result.reasonCode, 'COMMITMENT_MISMATCH');
  assert.ok(result.divergentFields.includes('verificationResult'));
  assert.ok(result.divergentFields.includes('remainingProhibitedFindings'));
  assert.equal(adapter.calls.length, 0);
});

test("the destination comes from the ADAPTER's own identity: an adapter pointing elsewhere is refused naming provider/service", async () => {
  const { governed, frozen } = await approvedRelease();
  const adapter = spyAdapter({ destination: { provider: 'openai', service: 'gpt' } });
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter,
    detector: createPatternDetector(),
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: bound.consumeAuthority,
  });
  assert.equal(result.reasonCode, 'COMMITMENT_MISMATCH');
  assert.deepEqual(result.divergentFields.sort(), ['provider', 'service']);
  assert.equal(adapter.calls.length, 0);
});

test('an adapter that declares NO destination is a named refusal, never a thrown error', async () => {
  const { governed, frozen } = await approvedRelease();
  const adapter = spyAdapter({ destination: undefined });
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter,
    detector: createPatternDetector(),
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: bound.consumeAuthority,
  });
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'COMMITMENT_UNCONSTRUCTIBLE');
  assert.equal(result.execution, 'not_attempted');
  assert.ok(result.detail.includes('anthropic-spy'), 'the detail must name the adapter');
  assert.equal(adapter.calls.length, 0);
});

test('STRUCTURAL: the gate accepts no caller assertion of verification, hashes, classification, or destination', () => {
  const src = readFileSync(new URL('../src/egress/kernel-gate.mjs', import.meta.url), 'utf8');
  // Strip comments so the file's own explanation of the rule cannot satisfy
  // or violate it (the check-flags-its-own-rationale class).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The ONLY caller-supplied input is `material`, destructured once.
  const destructure = code.match(/const \{([^}]*)\} = input;/);
  assert.ok(destructure, 'the gate must destructure its input in one place');
  const accepted = destructure[1].split(',').map((s) => s.trim().split(/[:=]/)[0].trim()).filter(Boolean);
  assert.deepEqual(
    accepted.sort(),
    ['adapter', 'authority', 'consumeAuthority', 'detector', 'evidence', 'material'].sort(),
    'a new input to this gate is a contract change: it must not become a way to assert a derived field',
  );
  for (const forbidden of ['verified', 'verificationResult', 'artifactHash', 'releasedArtifactHash', 'classification', 'destination']) {
    assert.ok(
      !new RegExp(`input\\.${forbidden}\\b`).test(code) && !new RegExp(`material[?.]*\\.${forbidden}\\b`).test(code),
      `the gate must never read a caller-supplied ${forbidden}`,
    );
  }
  // `material` carries bytes only — text and prompt, nothing else.
  const materialReads = [...code.matchAll(/material\?\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(materialReads)].sort(), ['prompt', 'text']);
});

// ───────────────────────────────────────────────────────────────────────────
// ITEM 3 — the canonical commitment.
// ───────────────────────────────────────────────────────────────────────────

test('the canon is field ZERO and is covered by the hash; an unknown canon THROWS rather than being re-interpreted', () => {
  const fields = sampleFields();
  assert.equal(EGRESS_COMMITMENT_FIELDS[0], 'canon');
  const pairs = JSON.parse(canonicalizeEgressCommitment(fields));
  assert.deepEqual(pairs[0], ['canon', EGRESS_COMMITMENT_CANON]);
  assert.throws(
    () => canonicalizeEgressCommitment({ ...fields, canon: 'strix-egress-commitment-v2' }),
    /unsupported canon/,
  );
});

test('the commitment covers all 17 fields, in a LOCKED order, as an array of pairs (object key order is a property of the writer)', () => {
  assert.equal(EGRESS_COMMITMENT_FIELDS.length, 17);
  const fields = sampleFields();
  const pairs = JSON.parse(canonicalizeEgressCommitment(fields));
  assert.deepEqual(pairs.map(([k]) => k), [...EGRESS_COMMITMENT_FIELDS]);
  // Key insertion order must not change the bytes.
  const reversed = {};
  for (const key of [...EGRESS_COMMITMENT_FIELDS].reverse()) reversed[key] = fields[key];
  assert.equal(canonicalizeEgressCommitment(reversed), canonicalizeEgressCommitment(fields));
});

test('EVERY committed field is hash-sensitive — a commitment cannot be satisfied by a release that differs in any one of them', () => {
  const base = computeEgressCommitment(sampleFields());
  for (const key of EGRESS_COMMITMENT_FIELDS) {
    if (key === 'canon') continue; // covered by its own test (throws)
    const fields = sampleFields();
    fields[key] = key === 'remainingProhibitedFindings' ? 7 : `${fields[key]}-changed`;
    const mutated = computeEgressCommitment(fields);
    assert.notEqual(mutated.commitmentHash, base.commitmentHash, `${key} must change the commitment`);
  }
});

test('fail-closed on every axis a default could hide: missing, unknown, wrong type, empty, or INHERITED', () => {
  const fields = sampleFields();
  // Missing
  const { actor: _drop, ...missing } = fields;
  assert.throws(() => canonicalizeEgressCommitment(missing), /missing required field "actor"/);
  // Unknown
  assert.throws(() => canonicalizeEgressCommitment({ ...fields, extra: 'x' }), /unknown field "extra"/);
  // Wrong type / empty
  assert.throws(() => canonicalizeEgressCommitment({ ...fields, actor: 42 }), /actor must be a non-empty string/);
  assert.throws(() => canonicalizeEgressCommitment({ ...fields, actor: '' }), /actor must be a non-empty string/);
  assert.throws(() => canonicalizeEgressCommitment({ ...fields, remainingProhibitedFindings: '0' }), /non-negative integer/);
  assert.throws(() => canonicalizeEgressCommitment({ ...fields, remainingProhibitedFindings: -1 }), /non-negative integer/);
  // INHERITED — an own-property read is the rule; a prototype value must
  // never satisfy a committed field (the prototype-pollution class this
  // repo has now recorded three times).
  const { actor: _a, ...withoutActor } = fields;
  const crafted = Object.create({ actor: 'attacker@example' });
  Object.assign(crafted, withoutActor);
  assert.equal(crafted.actor, 'attacker@example', 'the inherited value must be readable by member access');
  assert.throws(() => canonicalizeEgressCommitment(crafted), /missing required field "actor"/);
});

test('the two sources are exactly authority and material, and they PARTITION the committed fields', () => {
  const all = new Set(EGRESS_COMMITMENT_FIELDS.filter((f) => f !== 'canon'));
  const sourced = [...AUTHORITY_SOURCED_FIELDS, ...MATERIAL_DERIVED_FIELDS];
  assert.equal(sourced.length, all.size, 'every non-canon field has exactly one source');
  assert.deepEqual([...new Set(sourced)].sort(), [...all].sort());
  // `initialClassification` is honestly authority-sourced: the gate never
  // sees the original document, so it CANNOT re-derive what the artifact was
  // before transformation. Recorded as a test so the asymmetry stays visible.
  assert.ok(AUTHORITY_SOURCED_FIELDS.includes('initialClassification'));
  assert.ok(!MATERIAL_DERIVED_FIELDS.includes('initialClassification'));
});

test('assembleEgressCommitment has NO third parameter — a caller contributes nothing to what the commitment says', () => {
  const src = readFileSync(new URL('../src/commitment/egress-commitment.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sig = code.match(/export function assembleEgressCommitment\(\{([^}]*)\}\)/);
  assert.ok(sig, 'the two-source signature must be a destructured object');
  assert.deepEqual(sig[1].split(',').map((s) => s.trim()).filter(Boolean).sort(), ['authority', 'material']);
  assert.equal(assembleEgressCommitment.length, 1, 'exactly one destructured parameter');
  // And a missing half is a throw, never a defaulted field.
  assert.throws(() => assembleEgressCommitment({ authority: {}, material: {} }), /authority is missing/);
});

// ───────────────────────────────────────────────────────────────────────────
// ITEM 2 — the binding refuses to REPRESENT authority that does not exist.
// ───────────────────────────────────────────────────────────────────────────

test('the binding refuses every way authority can be absent, each by its own code', async () => {
  const { frozen } = await approvedRelease();
  const consume = singleUseConsume();
  const bind = (decision, tenantId = TENANT) =>
    bindDecisionToEgressAuthority({ decision, tenantId, consumeAuthority: consume });

  const cases = [
    ['DECISION_MISSING', () => bind(null)],
    ['DECISION_NOT_EXECUTED', () => bind(decisionFor(frozen, { state: 'APPROVED' }))],
    ['TOKEN_NOT_REDEEMED', () => bind(decisionFor(frozen, { tokenRedeemed: false }))],
    ['TENANT_MISMATCH', () => bind(decisionFor(frozen), 'tenant_other')],
    ['CAPABILITY_MISMATCH', () => bind(decisionFor(frozen, { actionType: 'finance.refund.issue' }))],
    ['COMMITMENT_FIELDS_INVALID', () => bind(decisionFor(frozen, { actionParams: null }))],
  ];
  for (const [code, run] of cases) {
    assert.throws(run, (e) => e instanceof BindingRefusal && e.reasonCode === code, `expected ${code}`);
  }
  assert.equal(consume.state.calls, 0, 'a refused binding must never consume authority');
  // Every declared code is exercised or has its own dedicated test below.
  for (const code of BINDING_REFUSAL_CODES) {
    assert.ok(
      cases.some(([c]) => c === code) || code === 'COMMITMENT_HASH_DISAGREEMENT',
      `declared code ${code} must be covered`,
    );
  }
});

test('a STORED commitmentHash is never trusted: a planted disagreement with the frozen fields is refused', async () => {
  const { frozen } = await approvedRelease();
  const tampered = {
    ...frozen.actionParams,
    commitmentHash: sha256Hex('a hash that agrees with nothing'),
  };
  assert.throws(
    () => bindDecisionToEgressAuthority({
      decision: decisionFor(frozen, { actionParams: tampered }),
      tenantId: TENANT,
      consumeAuthority: singleUseConsume(),
    }),
    (e) => e instanceof BindingRefusal && e.reasonCode === 'COMMITMENT_HASH_DISAGREEMENT',
  );
});

test('a params field claiming a different CAPABILITY cannot survive — capability is read from the decision itself', async () => {
  const { frozen } = await approvedRelease();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen, {
      actionParams: { ...frozen.actionParams, capability: 'dependency.install' },
    }),
    tenantId: TENANT,
    consumeAuthority: singleUseConsume(),
  });
  assert.equal(bound.authority.capability, EGRESS_CAPABILITY_ID);
});

test('EXECUTING is an authorized state alongside EXECUTED (the binding is useful after redemption, before the write)', async () => {
  const { frozen } = await approvedRelease();
  assert.deepEqual([...AUTHORIZED_DECISION_STATES], ['EXECUTING', 'EXECUTED']);
  for (const state of AUTHORIZED_DECISION_STATES) {
    const bound = bindDecisionToEgressAuthority({
      decision: decisionFor(frozen, { state }),
      tenantId: TENANT,
      consumeAuthority: singleUseConsume(),
    });
    assert.equal(bound.authority.commitmentHash, frozen.commitmentHash);
  }
});

test('propose and redeem agree BY CONSTRUCTION: the frozen params re-derive the same commitment the gate reconstructs', async () => {
  const { governed, frozen } = await approvedRelease();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  assert.equal(bound.authority.commitmentHash, frozen.commitmentHash);
  // And the reconstruction from the real material lands on the same value.
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter: spyAdapter(),
    detector: createPatternDetector(),
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: bound.consumeAuthority,
  });
  assert.equal(result.reconstructedCommitmentHash, frozen.commitmentHash);
});

test('a commitment written under an unsupported canon is refused at the gate, never re-derived under v1 rules', async () => {
  const { governed, frozen } = await approvedRelease();
  const adapter = spyAdapter();
  const result = await releaseUnderKernelAuthority({
    authority: { ...frozen, canon: 'strix-egress-commitment-v2', commitmentHash: frozen.commitmentHash },
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter,
    detector: createPatternDetector(),
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: singleUseConsume(),
  });
  assert.equal(result.reasonCode, 'AUTHORITY_CANON_UNSUPPORTED');
  assert.equal(adapter.calls.length, 0);
});

test('no authority at all is refused before anything else', async () => {
  const adapter = spyAdapter();
  for (const authority of [null, undefined, {}, { commitmentHash: 42 }]) {
    const result = await releaseUnderKernelAuthority({
      authority,
      material: { text: 'x', prompt: 'y' },
      adapter,
      detector: createPatternDetector(),
      evidence: createInMemoryEvidenceLog(),
      consumeAuthority: singleUseConsume(),
    });
    assert.equal(result.reasonCode, 'AUTHORITY_REQUIRED');
  }
  assert.equal(adapter.calls.length, 0);
});

test('STRUCTURAL: the kernel path never reaches the demoted local authorization', () => {
  for (const file of ['../src/egress/kernel-gate.mjs', '../src/kernel/production-binding.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/from\s+['"][^'"]*authorization\/authorize/.test(code),
      `${file} must not import the local authorization — two mechanisms that can each permit an egress is a parallel authorization system`,
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// ITEM 5 — the chain head is bound into signed evidence.
// ───────────────────────────────────────────────────────────────────────────

test('the gate reports the chain head AFTER the outcome entry, and it is the real head of a verifying chain', async () => {
  const { governed, frozen } = await approvedRelease();
  const evidence = createInMemoryEvidenceLog();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter: spyAdapter(),
    detector: createPatternDetector(),
    evidence,
    consumeAuthority: bound.consumeAuthority,
  });

  const records = evidence.list();
  const chain = verifyEvidenceChain(records);
  assert.equal(chain.valid, true);
  assert.equal(chain.proves, 'INTERNAL_CONSISTENCY_ONLY');
  assert.equal(records.at(-1).type, 'egress_outcome', 'the head must be the outcome, written last');
  assert.equal(result.evidenceChainHead, records.at(-1).entryHash);

  const receipt = receiptResultForSignedEvidence(result);
  assert.equal(receipt.evidenceChainHead, records.at(-1).entryHash);
  assert.equal(receipt.evidenceChainHeadRecorded, true);
  assert.equal(receipt.capability, EGRESS_CAPABILITY_ID);
  assert.equal(receipt.proves, 'CHAIN_HEAD_ANCHORED_TO_SIGNED_EVIDENCE');
});

test('ANCHOR: a log rewritten after the fact re-chains cleanly but no longer matches the SIGNED head', async () => {
  const { governed, frozen } = await approvedRelease();
  const evidence = createInMemoryEvidenceLog();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter: spyAdapter(),
    detector: createPatternDetector(),
    evidence,
    consumeAuthority: bound.consumeAuthority,
  });
  const signedHead = receiptResultForSignedEvidence(result).evidenceChainHead;

  // The attacker holds the local log and rewrites it END TO END — which the
  // hash chain alone cannot detect, because a party who can edit one entry
  // can re-chain them all. This is exactly why the head is signed.
  const rewritten = createInMemoryEvidenceLog();
  for (const r of evidence.list()) {
    // Strip exactly the fields the log stamps itself (seq/at/prevHash/
    // entryHash) so the forgery is re-chained by the real append path rather
    // than hand-built. The forged log therefore carries fresh timestamps —
    // which does not weaken the point: it is internally consistent, and that
    // is precisely what the chain alone can attest to.
    const { entryHash: _h, prevHash: _p, seq: _s, at: _at, ...body } = r;
    rewritten.append(body.type === 'egress_outcome' ? { ...body, disclosureStatus: 'not_disclosed' } : body);
  }
  const recheck = verifyEvidenceChain(rewritten.list());
  assert.equal(recheck.valid, true, 'a fully re-chained forgery passes the local chain check');
  assert.notEqual(rewritten.list().at(-1).entryHash, signedHead, 'but its head differs from the signed anchor');
});

test('an outcome-evidence write that FAILS yields a null head — honest, never fabricated', async () => {
  const { governed, frozen } = await approvedRelease();
  const inner = createInMemoryEvidenceLog();
  let appends = 0;
  const flaky = {
    append(entry) {
      appends += 1;
      if (entry.type === 'egress_outcome') throw new Error('disk full');
      return inner.append(entry);
    },
    list: () => inner.list(),
  };
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter: spyAdapter(),
    detector: createPatternDetector(),
    evidence: flaky,
    consumeAuthority: bound.consumeAuthority,
  });
  assert.ok(appends >= 2);
  assert.equal(result.execution, 'completed', 'the send already happened — never pretend it did not');
  assert.equal(result.outcomeEvidenceRecorded, false);
  assert.equal(result.evidenceChainHead, null);
  const receipt = receiptResultForSignedEvidence(result);
  assert.equal(receipt.evidenceChainHead, null);
  assert.equal(receipt.evidenceChainHeadRecorded, false, 'the absence is itself recorded');
});

test('ATTEMPT evidence precedes the transport: a failed attempt write refuses with the provider untouched and the authority spent', async () => {
  const { governed, frozen } = await approvedRelease();
  const adapter = spyAdapter();
  const consume = singleUseConsume();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: consume,
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter,
    detector: createPatternDetector(),
    evidence: { append(e) { if (e.type === 'egress_attempt') throw new Error('disk full'); }, list: () => [] },
    consumeAuthority: bound.consumeAuthority,
  });
  assert.equal(result.reasonCode, 'EVIDENCE_UNAVAILABLE');
  assert.equal(result.execution, 'not_attempted');
  assert.equal(adapter.calls.length, 0, 'never a provider call that no record precedes');
  assert.equal(consume.state.calls, 1, 'the grant stays spent — never refunded on a crash path');
});

test('a transport TIMEOUT is UNKNOWN and POSSIBLY DISCLOSED, never FAILED', async () => {
  const { governed, frozen } = await approvedRelease();
  const timeoutAdapter = spyAdapter({
    async send() { const e = new Error('timed out'); e.kind = 'timeout'; throw e; },
  });
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter: timeoutAdapter,
    detector: createPatternDetector(),
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: bound.consumeAuthority,
  });
  assert.equal(result.execution, 'unknown');
  assert.equal(result.disclosureStatus, 'possibly_disclosed');
  assert.equal(result.released, false);
});

test('every declared gate refusal code is reachable by a test in this file', () => {
  const src = readFileSync(new URL('./phase-b-kernel.test.mjs', import.meta.url), 'utf8');
  for (const code of KERNEL_EGRESS_REFUSAL_CODES) {
    assert.ok(
      new RegExp(`reasonCode, '${code}'`).test(src),
      `${code} is declared but no test asserts the gate can return it`,
    );
  }
});

// ── helpers ────────────────────────────────────────────────────────────────

function sampleFields() {
  return {
    canon: EGRESS_COMMITMENT_CANON,
    capability: EGRESS_CAPABILITY_ID,
    tenantId: TENANT,
    environment: 'production',
    actor: 'analyst@healthcare.example',
    policyId: 'healthcare-reference',
    policyVersion: '0.1.0',
    provider: 'anthropic',
    service: 'claude',
    purpose: PURPOSE,
    initialClassification: 'phi_detected',
    releasedClassification: 'deidentified',
    releasedArtifactHash: sha256Hex('released'),
    promptHash: sha256Hex('prompt'),
    verificationResult: 'passed',
    verificationProves: 'NO_FINDINGS_BY_DETECTOR',
    remainingProhibitedFindings: 0,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// WIRE IDENTITY — the invariant this package is named for, closed end to end.
//
// Every other test here proves the gate REFUSES a substitution. This proves
// the positive: on the allowed path, the bytes that reach the provider's HTTP
// request body are BYTE-IDENTICAL to the bytes the commitment was frozen over,
// and hash to the frozen `releasedArtifactHash`.
//
// The distinction matters because a gate can compare hashes correctly and
// still hand a DIFFERENT string to the transport — the comparison and the
// transmission are two separate steps, and only one of them was under test.
// So this composes the REAL kernel gate with the REAL Anthropic transport
// (not the spy adapter) behind a capturing fetchImpl, and re-derives the hash
// from what was actually put on the wire.
// ───────────────────────────────────────────────────────────────────────────

test('WIRE IDENTITY: the bytes on the provider wire hash to the frozen releasedArtifactHash', async () => {
  const { governed, frozen, deps } = await approvedRelease();

  const wire = [];
  const transport = createAnthropicMessagesTransport({
    apiKey: 'test-key-never-logged',
    fetchImpl: async (url, init) => {
      wire.push({ url, init });
      return {
        ok: true,
        headers: { get: () => 'req_wire_1' },
        async json() {
          return {
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: 'text', text: 'ok' }],
          };
        },
      };
    },
  });
  const adapter = { ...transport, destination: { ...DEST } };

  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen),
    tenantId: TENANT,
    consumeAuthority: singleUseConsume(),
  });
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: governed.prompt },
    adapter,
    detector: deps.detector,
    evidence: createInMemoryEvidenceLog(),
    consumeAuthority: bound.consumeAuthority,
  });

  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.execution, 'completed');
  assert.equal(wire.length, 1, 'exactly one outbound request');

  const body = JSON.parse(wire[0].init.body);
  const content = body.messages[0].content;

  // The transport's fixed template is `${prompt}\n\n<document>\n${text}\n</document>`.
  // Extract rather than reconstruct: reconstructing would re-apply the template
  // and could agree with itself while disagreeing with the wire.
  const open = '<document>\n';
  const close = '\n</document>';
  const start = content.indexOf(open);
  const end = content.lastIndexOf(close);
  assert.ok(start >= 0 && end > start, 'the wire body carries a delimited document block');
  const onWire = content.slice(start + open.length, end);

  assert.equal(onWire, governed.releaseText, 'the document on the wire is byte-identical to the released text');
  assert.equal(
    sha256Hex(onWire),
    frozen.actionParams.releasedArtifactHash,
    'the wire bytes hash to the hash Strix froze into the authorization',
  );
  assert.equal(
    sha256Hex(content.slice(0, start).replace(/\n\n$/, '')),
    frozen.actionParams.promptHash,
    'the prompt on the wire hashes to the frozen promptHash',
  );

  // And the negative half, so this cannot pass by the document being empty or
  // by the raw record having survived: no synthetic identifier is on the wire.
  for (const value of Object.values(SYNTHETIC_PHI)) {
    assert.ok(
      !content.toLowerCase().includes(String(value).toLowerCase()),
      `raw identifier reached the wire: ${value}`,
    );
  }
  assert.ok(onWire.length > 0, 'the document on the wire is non-empty');
});


// ───────────────────────────────────────────────────────────────────────────
// THE RESOLVED ENDPOINT RIDES EVIDENCE, NEVER THE COMMITMENT.
//
// `destination.provider`/`service` is a label the adapter composes; nothing
// compares it to `adapter.endpoint.baseUrl`, the host the transport actually
// speaks to. Since the commitment is frozen at EVALUATED (a new field there
// is a canon-version event), the fix is additive evidence: `endpoint` rides
// every entry this gate writes, present only when the adapter offers one,
// so an operator reading the log sees the real destination beside the
// asserted one instead of only the asserted one.
// ───────────────────────────────────────────────────────────────────────────

test('ENDPOINT EVIDENCE: absent when the adapter declares none — absence means unknown, never safe', async () => {
  const { frozen } = await approvedRelease();
  const adapter = spyAdapter(); // no `endpoint` field, matching every pre-existing test's adapter shape
  const consume = singleUseConsume();
  const evidence = createInMemoryEvidenceLog();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen),
    tenantId: TENANT,
    consumeAuthority: consume,
  });

  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: buildRecordText(), prompt: PROMPT }, // wrong (unsanitized) bytes -> guaranteed COMMITMENT_MISMATCH
    adapter,
    detector: createPatternDetector(),
    evidence,
    consumeAuthority: bound.consumeAuthority,
  });

  // The material above is deliberately wrong (unsanitized original bytes) so this run
  // takes the COMMITMENT_MISMATCH refusal path rather than requiring a full
  // second sanitized release just to prove an evidence field's absence.
  assert.equal(result.decision, 'DENY');
  const entries = evidence.list();
  assert.ok(entries.length > 0, 'the refusal path still wrote evidence');
  for (const entry of entries) {
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'endpoint'), false, `entry type ${entry.type} must carry no endpoint key when the adapter offered none`);
  }
});

test('ENDPOINT EVIDENCE: present, verbatim, and off the ADAPTER\'S OWN identity on both the attempt and outcome entries of a real release', async () => {
  const { governed, frozen } = await approvedRelease();
  const realEndpoint = { baseUrl: 'https://api.example.invalid', apiVersion: '2023-06-01' };
  const adapter = spyAdapter({ endpoint: { ...realEndpoint } });
  const consume = singleUseConsume();
  const evidence = createInMemoryEvidenceLog();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen),
    tenantId: TENANT,
    consumeAuthority: consume,
  });

  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: PROMPT },
    adapter,
    detector: createPatternDetector(),
    evidence,
    consumeAuthority: bound.consumeAuthority,
  });

  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.execution, 'completed');
  const entries = evidence.list();
  const attempt = entries.find((e) => e.type === 'egress_attempt');
  const outcome = entries.find((e) => e.type === 'egress_outcome');
  assert.ok(attempt, 'an attempt entry exists');
  assert.ok(outcome, 'an outcome entry exists');
  assert.deepEqual(attempt.endpoint, realEndpoint, 'the attempt entry carries the adapter\'s real endpoint, not the asserted destination label');
  assert.deepEqual(outcome.endpoint, realEndpoint, 'the outcome entry carries the same real endpoint');
  // The asserted label and the real endpoint sit SIDE BY SIDE — neither
  // silently substitutes for the other.
  assert.equal(adapter.destination.provider, 'anthropic');
  assert.notEqual(adapter.destination.provider, realEndpoint.baseUrl, 'the label and the endpoint are genuinely different facts');
});

test('ENDPOINT EVIDENCE: a COMMITMENT_MISMATCH refusal still names the adapter\'s real endpoint next to the asserted label', async () => {
  const { frozen } = await approvedRelease();
  const realEndpoint = { baseUrl: 'https://api.example.invalid', apiVersion: '2023-06-01' };
  const adapter = spyAdapter({ endpoint: { ...realEndpoint } });
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen), tenantId: TENANT, consumeAuthority: singleUseConsume(),
  });
  const evidence = createInMemoryEvidenceLog();
  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: buildRecordText(), prompt: PROMPT }, // the substitution attack: original, unsanitized bytes
    adapter,
    detector: createPatternDetector(),
    evidence,
    consumeAuthority: bound.consumeAuthority,
  });

  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'COMMITMENT_MISMATCH');
  assert.equal(adapter.calls.length, 0, 'the refusal must still prove the transport never ran');
  const denied = evidence.list().find((e) => e.reasonCode === 'COMMITMENT_MISMATCH');
  assert.ok(denied, 'a denial entry was written');
  assert.deepEqual(denied.endpoint, realEndpoint, 'the refusal names the real endpoint the adapter would have spoken to');
});

test('ENDPOINT EVIDENCE: the endpoint entry never carries a credential — the transport contract excludes it by design', async () => {
  const { governed, frozen } = await approvedRelease();
  // A transport built the REAL way: apiKey is closed over, never placed on
  // the returned object, so `endpoint` structurally cannot leak it either.
  // `createAnthropicMessagesTransport` returns the raw transport only —
  // `destination` is composed one layer up, by governedAnthropicDocumentRequest
  // in adapters/anthropic/index.mjs — so this gate-level test supplies it
  // the same way any direct caller of releaseUnderKernelAuthority must.
  const realTransport = createAnthropicMessagesTransport({
    apiKey: 'never-logged-key',
    baseUrl: 'https://api.example.invalid',
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => 'req_1' },
      async json() {
        return { content: [{ type: 'text', text: 'ok' }], model: 'claude-x', stop_reason: 'end_turn', usage: {} };
      },
    }),
  });
  const adapter = { ...realTransport, destination: { ...DEST } };
  const consume = singleUseConsume();
  const evidence = createInMemoryEvidenceLog();
  const bound = bindDecisionToEgressAuthority({
    decision: decisionFor(frozen),
    tenantId: TENANT,
    consumeAuthority: consume,
  });

  const result = await releaseUnderKernelAuthority({
    authority: bound.authority,
    material: { text: governed.releaseText, prompt: PROMPT },
    adapter,
    detector: createPatternDetector(),
    evidence,
    consumeAuthority: bound.consumeAuthority,
  });

  assert.equal(result.execution, 'completed');
  const attempt = evidence.list().find((e) => e.type === 'egress_attempt');
  assert.equal(attempt.endpoint.baseUrl, 'https://api.example.invalid');
  assert.ok(!JSON.stringify(attempt).includes('never-logged-key'), 'the evidence entry never carries the credential');
});
