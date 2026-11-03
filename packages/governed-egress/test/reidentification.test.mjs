/**
 * Response re-identification: the caller gets the original values back in
 * the answer; nothing else ever does.
 *
 * Every property is proven with real needles from SYNTHETIC_PHI:
 *   - the key exists only when something was tokenized, and lives outside
 *     `artifact`, the evidence log and the receipt;
 *   - the tokenized release carries no value, and the restored answer does;
 *   - a key cannot be applied to a different release;
 *   - only exact tokens are restored; invented and mangled tokens are left
 *     as written and counted;
 *   - the evidence entry carries counts and the release hash only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governDocumentEgress } from '../src/pipeline.mjs';
import { governedAnthropicDocumentRequest } from '../src/adapters/anthropic/index.mjs';
import { governedOpenAiDocumentRequest } from '../src/adapters/openai/index.mjs';
import {
  buildReidentificationKey,
  reidentifyResponse,
  reidentificationEvidenceEntry,
  ReidentificationError,
  REIDENTIFICATION_PROVES,
} from '../src/reidentification/reidentify.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../src/evidence/log.mjs';
import { prefixedHash, sha256Hex } from '../src/artifact/hash.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { deepFreeze } from '../src/policy/policy.mjs';
import { buildRecordText, buildCleanText, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const PROMPT = 'Summarize the encounter for the requesting physician.';
const NEEDLES = Object.values(SYNTHETIC_PHI).map((v) => String(v).toLowerCase());
const NAME = SYNTHETIC_PHI.patientName;

// A separate policy for the OpenAI adapter, never a mutation of the pilot's
// own policy (the adapter-openai test's rule).
const OPENAI_POLICY = deepFreeze({
  policyId: 'reidentification-openai-test-policy',
  policyVersion: '0.1.0',
  dataEgress: {
    externalAI: {
      default: 'deny',
      phi: { action: 'sanitize', requirePostTransformVerification: true, failClosed: true },
      destinations: { openai: { enabled: true, allowedData: ['deidentified', 'non_sensitive'] } },
    },
  },
});

function makeDeps() {
  return {
    detector: createPatternDetector(),
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
  };
}

function leaked(value) {
  const s = JSON.stringify(value).toLowerCase();
  return NEEDLES.filter((n) => s.includes(n));
}

async function govern(text = buildRecordText(), deps = makeDeps()) {
  const governed = await governDocumentEgress({
    source: { text },
    prompt: PROMPT,
    destination: { provider: 'anthropic', service: 'claude' },
    purpose: 'clinical_summary',
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps,
  });
  return { governed, deps };
}

function tokenFor(key, value) {
  const e = key.entries.find((x) => x.value === value);
  assert.ok(e, `no key entry for ${value}`);
  return e.token;
}

test('a sanitized release yields a key bound to the released text; the key sits outside artifact and evidence', async () => {
  const { governed, deps } = await govern();
  assert.equal(governed.outcome, 'SANITIZE');
  const key = governed.reidentification;
  assert.ok(key, 'a key is minted when values were tokenized');
  assert.equal(key.keyVersion, 1);
  assert.equal(key.releaseHash, prefixedHash(sha256Hex(governed.releaseText)));
  assert.ok(key.entries.length > 0);
  assert.ok(Object.isFrozen(key) && Object.isFrozen(key.entries));

  // The key carries the values (that is its job) — and nothing else does.
  assert.ok(leaked(key).length > 0, 'precondition: the key is not vacuous');
  assert.deepEqual(leaked(governed.releaseText), [], 'release text');
  assert.deepEqual(leaked(governed.artifact), [], 'artifact');
  assert.deepEqual(leaked(deps.evidence.list()), [], 'evidence log');
  assert.equal(JSON.stringify(governed.artifact).includes('"restore"'), false);
});

test('a clear document yields no key', async () => {
  const { governed } = await govern(buildCleanText());
  assert.equal(governed.outcome, 'ALLOW');
  assert.equal(governed.reidentification, null);
});

test('round trip: tokens in the answer become the original values', async () => {
  const { governed } = await govern();
  const key = governed.reidentification;
  const nameToken = tokenFor(key, NAME);
  const answer = `${nameToken} is stable. Follow up with ${nameToken} in two weeks.`;
  const { text, report } = reidentifyResponse({
    responseText: answer,
    key,
    releasedArtifactHash: prefixedHash(sha256Hex(governed.releaseText)),
  });
  assert.equal(text, `${NAME} is stable. Follow up with ${NAME} in two weeks.`);
  assert.equal(report.restoredOccurrences, 2);
  assert.equal(report.restoredTokens, 1);
  assert.equal(report.unknownTokens, 0);
  assert.equal(report.nearMissTokens, 0);
  assert.equal(report.proves, REIDENTIFICATION_PROVES);
  assert.deepEqual(leaked(report), [], 'the report carries no value');
});

test('a key minted for one release refuses to restore another release', async () => {
  const { governed } = await govern();
  const other = prefixedHash(sha256Hex(`${governed.releaseText} `));
  assert.throws(
    () => reidentifyResponse({ responseText: '[PATIENT_001]', key: governed.reidentification, releasedArtifactHash: other }),
    (e) => e instanceof ReidentificationError && e.reasonCode === 'KEY_RELEASE_MISMATCH',
  );
});

test('only exact tokens are restored; invented and mangled tokens are counted, not guessed', async () => {
  const { governed } = await govern();
  const key = governed.reidentification;
  const token = tokenFor(key, NAME); // e.g. [PATIENT_001]
  const bare = token.slice(1, -1); // PATIENT_001
  const spaced = bare.replace('_', ' ').toLowerCase(); // patient 001
  const lower = `[${bare.toLowerCase()}]`; // [patient_001]
  const answer = `${token}; also [PATIENT_999]; also ${bare}; also [${spaced}]; also ${lower}.`;
  const { text, report } = reidentifyResponse({ responseText: answer, key, releasedArtifactHash: key.releaseHash });
  assert.equal(text, `${NAME}; also [PATIENT_999]; also ${bare}; also [${spaced}]; also ${lower}.`);
  assert.equal(report.restoredOccurrences, 1);
  assert.equal(report.unknownTokens, 1);
  assert.equal(report.nearMissTokens, 3);
});

test('a malformed key refuses by name', async () => {
  const { governed } = await govern();
  const good = governed.reidentification;
  const bad = [
    null,
    { ...good, keyVersion: 2 },
    { ...good, releaseHash: 'deadbeef' },
    { ...good, entries: [] },
    { ...good, entries: [{ token: 'PATIENT_001', category: 'PERSON_NAME', value: 'x' }] },
    { ...good, entries: [{ token: '[PATIENT_001]', category: 'PERSON_NAME', value: '' }] },
    { ...good, entries: [good.entries[0], good.entries[0]] },
  ];
  for (const key of bad) {
    assert.throws(
      () => reidentifyResponse({ responseText: 'x', key, releasedArtifactHash: good.releaseHash }),
      (e) => e instanceof ReidentificationError && e.reasonCode === 'KEY_MALFORMED',
      JSON.stringify(key)?.slice(0, 80),
    );
  }
});

test('buildReidentificationKey returns null when nothing was tokenized', () => {
  assert.equal(buildReidentificationKey({ restore: [] }, 'text'), null);
  assert.equal(buildReidentificationKey(null, 'text'), null);
});

test('the transformer keeps the longest surface form per token', async () => {
  const transformer = createTokenizingTransformer();
  const text = 'Jane Doe saw Jane.';
  const findings = [
    { category: 'PATIENT_NAME', start: 0, end: 8 },
    { category: 'PATIENT_NAME', start: 13, end: 17 },
  ];
  // Same entity (the detector's entityKey), two surface forms.
  for (const f of findings) f.entityKey = 'jane doe';
  const out = await transformer.transform(text, { findings });
  assert.equal(out.text, '[PATIENT_001] saw [PATIENT_001].');
  assert.deepEqual(out.restore, [{ token: '[PATIENT_001]', category: 'PATIENT_NAME', value: 'Jane Doe' }]);
  assert.equal(JSON.stringify(out.mappings).includes('Jane'), false, 'mappings never carry values');
});

test('evidence entry: counts and release hash only', () => {
  const entry = reidentificationEvidenceEntry(
    { releaseHash: 'sha256:' + 'a'.repeat(64), restoredOccurrences: 3, restoredTokens: 2, unknownTokens: 1, nearMissTokens: 0, proves: REIDENTIFICATION_PROVES },
    { actor: 'clinician@healthcare.example' },
  );
  assert.deepEqual(Object.keys(entry).sort(), [
    'actor', 'nearMissTokens', 'proves', 'releasedArtifactHash', 'restoredOccurrences', 'restoredTokens', 'unknownTokens', 'type',
  ].sort());
  assert.equal(entry.type, 'egress_reidentified');
});

for (const [label, request, policy] of [
  ['anthropic', governedAnthropicDocumentRequest, HEALTHCARE_REFERENCE_POLICY],
  ['openai', governedOpenAiDocumentRequest, OPENAI_POLICY],
]) {
  test(`${label} adapter: opt-in restores values for the caller; response and evidence stay tokenized`, async () => {
    const deps = makeDeps();
    const transport = {
      name: 'spy',
      calls: [],
      async send(payload) {
        this.calls.push(payload);
        const token = payload.documentText.match(/\[PATIENT_\d{3}\]/)[0];
        return { responseText: `Summary for ${token}.` };
      },
    };
    const result = await request({
      source: { text: buildRecordText() },
      prompt: PROMPT,
      actor: 'clinician@healthcare.example',
      policy,
      deps,
      transport,
      reidentify: true,
    });
    assert.equal(result.released, true);
    assert.match(result.response, /\[PATIENT_\d{3}\]/, 'response stays exactly what the provider sent');
    assert.equal(result.reidentifiedResponse, `Summary for ${NAME}.`);
    assert.equal(result.reidentification.error, null);
    assert.equal(result.reidentification.restoredOccurrences, 1);
    assert.deepEqual(leaked(transport.calls), [], 'provider payload');
    assert.deepEqual(leaked(result.receipt), [], 'receipt');
    assert.deepEqual(leaked(result.reidentification), [], 'report');
    const entries = deps.evidence.list();
    assert.deepEqual(leaked(entries), [], 'evidence log');
    const reid = entries.filter((e) => (e.entry ?? e).type === 'egress_reidentified');
    assert.equal(reid.length, 1, 'exactly one re-identification evidence entry');
  });

  test(`${label} adapter: without opt-in there is no re-identified field and no entry`, async () => {
    const deps = makeDeps();
    const transport = { name: 'spy', async send() { return { responseText: 'ok' }; } };
    const result = await request({
      source: { text: buildRecordText() },
      prompt: PROMPT,
      policy,
      deps,
      transport,
    });
    assert.equal('reidentifiedResponse' in result, false);
    assert.equal('reidentification' in result, false);
    assert.equal(deps.evidence.list().some((e) => (e.entry ?? e).type === 'egress_reidentified'), false);
  });
}
