/**
 * 360-review regression pins (2026-09-03). Each test here encodes a gap the
 * review found by PROBING the built package rather than reading it, and each
 * was red-proven: the probe demonstrated the failure against the pre-fix
 * code before the fix landed (see docs/reviews/governed-egress-360-2026-09-03.md
 * for the probe record).
 *
 *  A. Mid-flight policy mutation — a caller-injected async dep mutated the
 *     live policy object between validation and enforcement, laundering a
 *     validated `phi.action: 'deny'` into `'sanitize'`. The boundary now
 *     enforces a deep-frozen snapshot taken at validation.
 *  B. Unicode-obfuscated identifiers — a full-width-digit SSN
 *     (ＳＳＮ：１２３-４５-６７８９) walked past the ASCII-shape detector and
 *     released on the ALLOW path. The boundary now scans the NFKC form too
 *     and refuses by name when normalization REVEALS findings.
 *  C. Decompression bombs — a ~200KB DOCX legally inflated to ~400MB
 *     in-process and ingested "successfully". Inflation is now budgeted
 *     (zlib maxOutputLength) and exceeding the bound is a named
 *     ARTIFACT_TOO_LARGE refusal, never a truncation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { governDocumentEgress } from '../src/pipeline.mjs';
import { createPatternDetector, scanText } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../src/authorization/authorize.mjs';
import { createInMemoryEvidenceLog, verifyEvidenceChain } from '../src/evidence/log.mjs';
import { decideDestination } from '../src/policy/policy.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { ingestArtifact, MAX_ARTIFACT_BYTES } from '../src/artifact/ingest.mjs';
import { MAX_INFLATED_BYTES } from '../src/artifact/limits.mjs';
import { buildRecordText } from '../fixtures/synthetic-patient-record.mjs';

const DEST = { provider: 'anthropic', service: 'messages' };
const PROMPT = 'Summarize the encounter for the treating physician.';
const PURPOSE = 'clinical summarization pilot';

function deps(overrides = {}) {
  return {
    detector: createPatternDetector(),
    transformer: createTokenizingTransformer(),
    store: createInMemoryAuthorizationStore(),
    evidence: createInMemoryEvidenceLog(),
    ...overrides,
  };
}

// ── A. The boundary enforces the policy it validated ────────────────────────

test('A: a dep that mutates the live policy mid-flight cannot launder deny into sanitize', async () => {
  const denyPolicy = structuredClone(HEALTHCARE_REFERENCE_POLICY);
  denyPolicy.dataEgress.externalAI.phi.action = 'deny';
  denyPolicy.dataEgress.externalAI.phi.requirePostTransformVerification = false;

  const real = createPatternDetector();
  const mutatingDetector = {
    async scan(text) {
      // The attack: rewrite the already-validated live policy object while
      // the pipeline awaits the scan the policy read comes after.
      denyPolicy.dataEgress.externalAI.phi.action = 'sanitize';
      denyPolicy.dataEgress.externalAI.phi.requirePostTransformVerification = true;
      return real.scan(text);
    },
  };

  const result = await governDocumentEgress({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    destination: DEST,
    purpose: PURPOSE,
    policy: denyPolicy,
    deps: deps({ detector: mutatingDetector, verifierDetector: real }),
  });
  assert.equal(result.outcome, 'DENY');
  assert.equal(result.reasonCode, 'PHI_EGRESS_DENIED_BY_POLICY');
});

test('A: destination policy is likewise read from the snapshot — a mid-flight destination enable does not take', async () => {
  const policy = structuredClone(HEALTHCARE_REFERENCE_POLICY);
  policy.dataEgress.externalAI.destinations.anthropic.enabled = false;

  const real = createPatternDetector();
  const mutatingDetector = {
    async scan(text) {
      policy.dataEgress.externalAI.destinations.anthropic.enabled = true;
      return real.scan(text);
    },
  };

  const result = await governDocumentEgress({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    destination: DEST,
    purpose: PURPOSE,
    policy,
    deps: deps({ detector: mutatingDetector, verifierDetector: real }),
  });
  assert.equal(result.outcome, 'DENY');
  assert.equal(result.reasonCode, 'DESTINATION_NOT_ENABLED');
});

test("A: a destination provider named 'constructor' resolves to no policy entry, never an inherited object", () => {
  for (const provider of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const decision = decideDestination({
      classification: 'deidentified',
      destination: { provider, service: 'messages' },
      policy: HEALTHCARE_REFERENCE_POLICY,
    });
    assert.equal(decision.eligible, false, `provider ${provider} must not be eligible`);
    assert.equal(decision.reasonCode, 'DESTINATION_NOT_ENABLED');
  }
});

// ── B. NFKC-obfuscated identifiers refuse by name ───────────────────────────

const FULLWIDTH_SSN_DOC = [
  'Quarterly wellness summary.',
  'The panel results were unremarkable and follow-up is routine.',
  'Reference code ＳＳＮ： １２３-４５-６７８９ retained for records.',
].join('\n');

test('B precondition: the raw detector genuinely misses the full-width SSN (this is the evasion, not an assumption)', () => {
  const raw = scanText(FULLWIDTH_SSN_DOC);
  assert.equal(raw.detected, false);
  const normalized = scanText(FULLWIDTH_SSN_DOC.normalize('NFKC'));
  assert.equal(normalized.detected, true);
  assert.ok(normalized.categories.includes('SSN'));
});

test('B: a document whose only identifiers are full-width refuses OBFUSCATED_SENSITIVE_DATA — never released on the ALLOW path', async () => {
  const result = await governDocumentEgress({
    source: { text: FULLWIDTH_SSN_DOC },
    prompt: PROMPT,
    destination: DEST,
    purpose: PURPOSE,
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps: deps(),
  });
  assert.equal(result.outcome, 'DENY');
  assert.equal(result.reasonCode, 'OBFUSCATED_SENSITIVE_DATA');
  assert.equal(result.artifact.classification, 'phi_detected');
});

test('B: one ASCII SSN plus a full-width copy of the SAME number still refuses — counts, not sets', async () => {
  // A set comparison over normalized values would read the full-width copy
  // as "already accounted for" and let the transformer rewrite only the
  // ASCII occurrence, releasing the full-width one untouched.
  const doc = `${buildRecordText()}\nDuplicate filing copy: ＳＳＮ １２３-４５-６７８９.`;
  const rawSsn = scanText(buildRecordText()).findings.find((f) => f.category === 'SSN');
  assert.ok(rawSsn, 'fixture must carry an ASCII SSN for this case to mean anything');
  assert.equal(rawSsn.value.normalize('NFKC'), '１２３-４５-６７８９'.normalize('NFKC'));

  const result = await governDocumentEgress({
    source: { text: doc },
    prompt: PROMPT,
    destination: DEST,
    purpose: PURPOSE,
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps: deps(),
  });
  assert.equal(result.outcome, 'DENY');
  assert.equal(result.reasonCode, 'OBFUSCATED_SENSITIVE_DATA');
});

test('B: a full-width identifier in the PROMPT refuses PROMPT_CONTAINS_SENSITIVE_DATA', async () => {
  const result = await governDocumentEgress({
    source: { text: 'Routine visit note with no identifiers.' },
    prompt: 'Cross-check against ＳＳＮ １２３-４５-６７８９ before summarizing.',
    destination: DEST,
    purpose: PURPOSE,
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps: deps(),
  });
  assert.equal(result.outcome, 'DENY');
  assert.equal(result.reasonCode, 'PROMPT_CONTAINS_SENSITIVE_DATA');
});

test('B negative: ordinary ligatures do NOT refuse — only a REVEAL does, so real clinical PDFs stay deliverable', async () => {
  // PDF extraction routinely yields ligatures; NFKC changes them ("ﬁnal" →
  // "final") without revealing any identifier. A blanket refuse-on-
  // normalization rule would deny ordinary sanitizable documents.
  const doc = `${buildRecordText()}\nThe ﬁnal specimen showed no signiﬁcant ﬂuid.`;
  assert.notEqual(doc.normalize('NFKC'), doc, 'the fixture must genuinely be non-NFKC-stable');

  const result = await governDocumentEgress({
    source: { text: doc },
    prompt: PROMPT,
    destination: DEST,
    purpose: PURPOSE,
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps: deps(),
  });
  assert.equal(result.outcome, 'SANITIZE');
  assert.ok(!result.releaseText.includes('123-45-6789'));
  assert.ok(result.releaseText.includes('ﬁnal'), 'benign ligatures survive untouched — the release is the raw text, tokenized');
});

test('B: the verify layer independently fails a release candidate carrying a normalizable identifier (last gate, not only the pipeline)', async () => {
  // Pins verify.mjs's own NFKC half: even if a future transformer emitted a
  // normalizable identifier the pipeline's pre-transform check never saw,
  // the mandatory second scan refuses it at the last gate before release.
  const { verifySanitizedArtifact } = await import('../src/verification/verify.mjs');
  const verification = await verifySanitizedArtifact({
    text: 'Sanitized summary for [PATIENT_001]. Filing ref ＳＳＮ １２３-４５-６７８９.',
    originalFindings: [],
    detector: createPatternDetector(),
  });
  assert.equal(verification.status, 'failed');
  assert.ok(verification.remainingProhibitedFindings >= 1);
  assert.ok(verification.rescan.categories.includes('SSN'));
});

// ── C. Decompression bombs refuse ARTIFACT_TOO_LARGE ────────────────────────

/** A DOCX whose document part inflates past MAX_INFLATED_BYTES. */
function buildBombDocx() {
  const para = `<w:p><w:r><w:t>${'A'.repeat(4096)}</w:t></w:r></w:p>`;
  const body = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${para.repeat(
    Math.ceil((MAX_INFLATED_BYTES + 1024 * 1024) / para.length),
  )}</w:body></w:document>`;
  const xml = Buffer.from(body, 'utf8');
  assert.ok(xml.length > MAX_INFLATED_BYTES, 'bomb payload must inflate past the bound');
  const compressed = deflateRawSync(xml, { level: 9 });
  assert.ok(compressed.length < MAX_ARTIFACT_BYTES, 'bomb must fit under the wire cap — that is the attack');

  const name = Buffer.from('word/document.xml', 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // method: deflate
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(xml.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localHeader = Buffer.concat([local, name]);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(8, 10); // method
  cen.writeUInt32LE(compressed.length, 20);
  cen.writeUInt32LE(xml.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(0, 42); // local header offset
  const central = Buffer.concat([cen, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localHeader.length + compressed.length, 16);

  return Buffer.concat([localHeader, compressed, central, eocd]);
}

/** A PDF whose FlateDecode streams jointly inflate past MAX_INFLATED_BYTES. */
function buildBombPdf() {
  // Text operators inside, so the streams read as content streams; each
  // stream stays under the bound alone — only the TOTAL exceeds it, pinning
  // the budget as a per-artifact total rather than per-stream.
  const chunk = `BT (${'B'.repeat(8192)}) Tj ET\n`;
  const perStream = Math.floor(MAX_INFLATED_BYTES / 4) + 1024 * 1024;
  const streamText = chunk.repeat(Math.ceil(perStream / chunk.length));
  const compressed = deflateSync(Buffer.from(streamText, 'latin1'), { level: 9 });
  const parts = ['%PDF-1.4\n'];
  for (let i = 0; i < 5; i += 1) {
    parts.push(`${i + 1} 0 obj\n<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`);
    parts.push(compressed.toString('latin1'));
    parts.push('\nendstream\nendobj\n');
  }
  parts.push('%%EOF\n');
  const pdf = Buffer.from(parts.join(''), 'latin1');
  assert.ok(pdf.length < MAX_ARTIFACT_BYTES, 'bomb must fit under the wire cap — that is the attack');
  return pdf;
}

test('C: a DOCX decompression bomb refuses ARTIFACT_TOO_LARGE — named refusal, never an ingest', () => {
  const before = process.memoryUsage().heapUsed;
  const result = ingestArtifact({ bytes: buildBombDocx() });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'ARTIFACT_TOO_LARGE');
  // The bound is enforced BY zlib (maxOutputLength) — the bomb's allocation
  // never happens. Generous ceiling: the budget plus working space.
  const grown = process.memoryUsage().heapUsed - before;
  assert.ok(grown < MAX_INFLATED_BYTES * 2, `heap grew ${grown} bytes — the bomb materialized`);
});

test('C: a multi-stream PDF bomb refuses ARTIFACT_TOO_LARGE — the budget is a per-artifact TOTAL', () => {
  const result = ingestArtifact({ bytes: buildBombPdf() });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'ARTIFACT_TOO_LARGE');
});

// ── D. Adjacent seams probed in the same review ─────────────────────────────

test('D: a PHI-bearing FILENAME never reaches evidence, the receipt, or the wire', async () => {
  // The filename is caller metadata; it rides the returned artifact object
  // (back to the caller who supplied it) and nothing else. The no-PHI
  // evidence proof used fixture needles but never a needle-bearing filename,
  // so this was unpinned until the 360 probe traced the flow.
  const { governedAnthropicDocumentRequest } = await import('../src/adapters/anthropic/index.mjs');
  const sent = [];
  const spyTransport = {
    name: 'spy',
    async send(payload) {
      sent.push(payload);
      return { responseText: 'ok', providerMeta: { model: 'spy' } };
    },
  };
  const evidence = createInMemoryEvidenceLog();
  const r = await governedAnthropicDocumentRequest({
    source: { text: buildRecordText(), filename: 'john-doe-ssn-123-45-6789-dob-03-14-1988.txt' },
    prompt: PROMPT,
    purpose: PURPOSE,
    policy: HEALTHCARE_REFERENCE_POLICY,
    transport: spyTransport,
    deps: deps({ evidence }),
  });
  assert.equal(r.released, true);
  const serialized = (JSON.stringify(evidence.list()) + JSON.stringify(r.receipt) + JSON.stringify(sent)).toLowerCase();
  assert.ok(!serialized.includes('john-doe'), 'filename PHI leaked');
  assert.ok(!serialized.includes('123-45-6789'), 'filename SSN leaked');
  assert.ok(!serialized.includes('filename'), 'no surface should carry the filename field at all');
});

test('D: no source file in this package carries a control or NUL byte — grep must never classify a governed source file as binary', async () => {
  // Red-proven the honest way: THIS review introduced a literal \x00 as a
  // multiset-key separator in pipeline.mjs, grep started skipping the file,
  // and the probe caught it. A binary-classified source file silently exits
  // every text-based source-scan lint in the repo (the client-profile 360's
  // store.ts finding). The fix is the same as there: a JSON-tuple key.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.d.ts')) files.push(join(dir, entry.name));
    }
  };
  walk('src');
  walk('demo');
  walk('fixtures');
  assert.ok(files.length >= 15, `scan must not be vacuous — saw ${files.length} files`);
  for (const file of files) {
    const data = readFileSync(join(root, file));
    for (const byte of data) {
      assert.ok(
        byte === 9 || byte === 10 || byte === 13 || byte >= 32,
        `${file} carries control byte 0x${byte.toString(16)} — grep will classify it as binary and skip it`,
      );
    }
  }
});

// ── E. Hash-chained evidence log — tamper-EVIDENT, honestly ceilinged ───────

async function realFlowLog() {
  // Full boundary + gate flow so the chain carries all three real entry
  // types: egress_authorized → egress_attempt → egress_outcome.
  const { releaseThroughGate } = await import('../src/egress/gate.mjs');
  const evidence = createInMemoryEvidenceLog();
  const store = createInMemoryAuthorizationStore();
  const result = await governDocumentEgress({
    source: { text: buildRecordText() },
    prompt: PROMPT,
    destination: DEST,
    purpose: PURPOSE,
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps: deps({ evidence, store }),
  });
  assert.equal(result.outcome, 'SANITIZE');
  const release = await releaseThroughGate({
    store,
    evidence,
    transport: { name: 'spy', async send() { return { responseText: 'ok' }; } },
    authorizationId: result.authorization.authorizationId,
    artifactText: result.releaseText,
    prompt: PROMPT,
    destination: DEST,
    purpose: PURPOSE,
  });
  assert.equal(release.released, true);
  return evidence;
}

test('E: a real flow produces a verifiable chain, and the verdict carries its own claim ceiling', async () => {
  const evidence = await realFlowLog();
  const records = evidence.list();
  assert.ok(records.length >= 1);
  const verdict = verifyEvidenceChain(records);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.length, records.length);
  assert.equal(verdict.headHash, records[records.length - 1].entryHash);
  // The ceiling is a literal FIELD, not prose: a chain proves internal
  // consistency, never authenticity — the log is unsigned and locally held.
  assert.equal(verdict.proves, 'INTERNAL_CONSISTENCY_ONLY');
});

test('E: editing an entry after append is detected by name', async () => {
  const evidence = await realFlowLog();
  const records = evidence.list().map((r) => ({ ...r }));
  records[0].classification = 'clear'; // launder phi_detected into clear
  const verdict = verifyEvidenceChain(records);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reasonCode, 'ENTRY_HASH_MISMATCH');
  assert.equal(verdict.index, 0);
});

test('E: removing an entry is detected — the successor names the broken link', async () => {
  const evidence = await realFlowLog();
  const records = evidence.list();
  assert.ok(records.length >= 2, 'need at least two entries to remove one meaningfully');
  const truncated = [records[0], ...records.slice(2)];
  const verdict = verifyEvidenceChain(truncated);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasonCode === 'CHAIN_LINK_BROKEN' || verdict.reasonCode === 'SEQ_GAP');
});

test('E: a fully RE-CHAINED substitute log verifies clean — which is exactly why the verdict is capped at INTERNAL_CONSISTENCY_ONLY', () => {
  // The NAV-1 lesson as a positive test: anyone can rebuild a self-consistent
  // chain from scratch, so a green chain must never be presented as
  // authenticity. This pin exists so nobody later "fixes" the ceiling away.
  const forged = createInMemoryEvidenceLog();
  forged.append({ type: 'egress_authorized', classification: 'clear' });
  forged.append({ type: 'egress_outcome', execution: 'completed' });
  const verdict = verifyEvidenceChain(forged.list());
  assert.equal(verdict.valid, true);
  assert.equal(verdict.proves, 'INTERNAL_CONSISTENCY_ONLY');
});
