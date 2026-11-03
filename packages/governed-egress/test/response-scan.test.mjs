/**
 * Scanning what comes back. The provider only saw tokens, so identifiers in
 * the answer were introduced by the model. The scan reports categories and
 * counts; `withhold` drops such an answer, and a scan that could not run
 * withholds too. Nothing here records a value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governedAnthropicDocumentRequest } from '../src/adapters/anthropic/index.mjs';
import { scanModelResponse, responseScanMode, ResponseScanError, RESPONSE_SCAN_PROVES } from '../src/response/scan-response.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../src/evidence/log.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { buildRecordText, SYNTHETIC_PHI } from '../fixtures/synthetic-patient-record.mjs';

const PROMPT = 'Summarize the encounter for the requesting physician.';
const INVENTED_PHONE = '615-555-0142';
const INVENTED_SSN = '123-45-6789';

function makeDeps(detector = createPatternDetector()) {
  return {
    detector,
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
  };
}

const answering = (text) => ({ name: 'spy', calls: 0, async send() { this.calls += 1; return { responseText: text }; } });

async function run({ answer, scanResponse, reidentify, deps = makeDeps() }) {
  const transport = answering(answer);
  const result = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps,
    transport,
    scanResponse,
    reidentify,
  });
  return { result, deps, transport };
}

const scanEntries = (deps) => deps.evidence.list().filter((e) => (e.entry ?? e).type === 'egress_response_scanned');

test('scanModelResponse: a token-only answer is clean', async () => {
  const r = await scanModelResponse({ responseText: 'Patient: [PATIENT_001] is stable. Recheck [DATE_001].', detector: createPatternDetector() });
  assert.equal(r.status, 'clean');
  assert.equal(r.findingsCount, 0);
  assert.equal(r.proves, RESPONSE_SCAN_PROVES);
  assert.match(r.responseHash, /^sha256:[0-9a-f]{64}$/);
});

test('scanModelResponse: an introduced identifier is found, and only its category is reported', async () => {
  const r = await scanModelResponse({ responseText: `Call ${INVENTED_PHONE}; SSN ${INVENTED_SSN}.`, detector: createPatternDetector() });
  assert.equal(r.status, 'findings');
  assert.equal(r.findingsCount, 2);
  assert.deepEqual([...r.categories], ['PHONE', 'SSN']);
  const s = JSON.stringify(r);
  assert.ok(!s.includes(INVENTED_PHONE) && !s.includes(INVENTED_SSN), 'no value in the report');
});

test('scanModelResponse: the NFKC form is scanned too, and the worse count governs', async () => {
  const wide = `ＳＳＮ ${INVENTED_SSN}`.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d)));
  const r = await scanModelResponse({ responseText: wide, detector: createPatternDetector() });
  assert.equal(r.status, 'findings');
});

test('responseScanMode: off, flag, withhold, and a malformed option refuses by name', () => {
  assert.equal(responseScanMode(undefined), null);
  assert.equal(responseScanMode(false), null);
  assert.equal(responseScanMode(true), 'flag');
  assert.equal(responseScanMode({}), 'flag');
  assert.equal(responseScanMode({ onFindings: 'withhold' }), 'withhold');
  assert.throws(() => responseScanMode({ onFindings: 'redact' }), (e) => e instanceof ResponseScanError && e.reasonCode === 'SCAN_OPTION_MALFORMED');
});

test('adapter: a malformed option refuses BEFORE anything is sent', async () => {
  const transport = answering('ok');
  await assert.rejects(
    governedAnthropicDocumentRequest({
      source: { text: buildRecordText() }, prompt: PROMPT, policy: HEALTHCARE_REFERENCE_POLICY, deps: makeDeps(), transport,
      scanResponse: { onFindings: 'redact' },
    }),
    (e) => e.reasonCode === 'SCAN_OPTION_MALFORMED',
  );
  assert.equal(transport.calls, 0);
});

test('adapter flag mode: the answer returns with the report; evidence carries categories only', async () => {
  const answer = `[PATIENT_001] can be reached at ${INVENTED_PHONE}.`;
  const { result, deps } = await run({ answer, scanResponse: true });
  assert.equal(result.response, answer);
  assert.equal(result.responseScan.mode, 'flag');
  assert.equal(result.responseScan.status, 'findings');
  assert.equal(result.responseScan.withheld, false);
  assert.deepEqual([...result.responseScan.categories], ['PHONE']);
  const entries = scanEntries(deps);
  assert.equal(entries.length, 1);
  const s = JSON.stringify(deps.evidence.list()).toLowerCase();
  for (const v of [INVENTED_PHONE, ...Object.values(SYNTHETIC_PHI).map((x) => String(x).toLowerCase())]) {
    assert.ok(!s.includes(v), `value in evidence: ${v}`);
  }
});

test('adapter withhold mode: an answer with findings is not returned, and is not re-identified', async () => {
  const { result } = await run({ answer: `[PATIENT_001]: ${INVENTED_SSN}`, scanResponse: { onFindings: 'withhold' }, reidentify: true });
  assert.equal(result.released, true, 'the release still happened');
  assert.equal(result.response, null);
  assert.equal(result.responseScan.withheld, true);
  assert.equal(result.reidentifiedResponse, null);
  assert.equal(result.reidentification.error, 'RESPONSE_WITHHELD');
});

test('adapter withhold mode: a clean answer is returned and re-identified', async () => {
  const { result } = await run({ answer: 'Summary for [PATIENT_001].', scanResponse: { onFindings: 'withhold' }, reidentify: true });
  assert.equal(result.response, 'Summary for [PATIENT_001].');
  assert.equal(result.responseScan.status, 'clean');
  assert.equal(result.reidentifiedResponse, `Summary for ${SYNTHETIC_PHI.patientName}.`);
});

test('adapter withhold mode: a scan that cannot run withholds (unknown is not clean)', async () => {
  const real = createPatternDetector();
  let calls = 0;
  // The release path's scans succeed; the response scan (the last call) throws.
  const flaky = { info: real.info, acceptsSeeds: true, async scan(t, o) { calls += 1; if (t.startsWith('ANSWER')) throw new Error('boom'); return real.scan(t, o); } };
  const { result } = await run({ answer: 'ANSWER [PATIENT_001]', scanResponse: { onFindings: 'withhold' }, deps: makeDeps(flaky) });
  assert.ok(calls > 0);
  assert.equal(result.responseScan.status, 'unavailable');
  assert.equal(result.responseScan.withheld, true);
  assert.equal(result.response, null);
});

test('adapter flag mode: a scan that cannot run is reported unavailable and the answer returns', async () => {
  const real = createPatternDetector();
  const flaky = { info: real.info, acceptsSeeds: true, async scan(t, o) { if (t.startsWith('ANSWER')) throw new Error('boom'); return real.scan(t, o); } };
  const { result } = await run({ answer: 'ANSWER ok', scanResponse: true, deps: makeDeps(flaky) });
  assert.equal(result.responseScan.status, 'unavailable');
  assert.equal(result.response, 'ANSWER ok');
});

test('without the option there is no scan field and no entry', async () => {
  const { result, deps } = await run({ answer: `call ${INVENTED_PHONE}` });
  assert.equal('responseScan' in result, false);
  assert.equal(scanEntries(deps).length, 0);
});
