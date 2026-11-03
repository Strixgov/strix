/**
 * CSV extraction — correctness, fail-closed refusals, and the detector
 * property that justifies linearization.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CSV_MAX_CELL_CHARS,
  CSV_MAX_COLUMNS,
  CSV_MAX_ROWS,
  CsvExtractionError,
  extractCsvText,
  parseCsvRows,
} from '../src/artifact/csv-text.mjs';
import { ingestArtifact, SUPPORTED_MIME_TYPES } from '../src/artifact/ingest.mjs';
import { scanText } from '../src/detection/pattern-detector.mjs';
import { prepareDocumentForEgress } from '../src/robust-prepare.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';

function refusesWith(code, fn) {
  assert.throws(fn, (err) => err instanceof CsvExtractionError && err.reasonCode === code, `expected ${code}`);
}

const csvBytes = (text) => ({ bytes: Buffer.from(text, 'utf8'), mimeType: 'text/csv', filename: 'x.csv' });

// ── The property that justifies the whole extractor ─────────────────────────

test('raw CSV defeats the label-seeded detector; the linearized form does not', () => {
  // A given name outside the lexicon: the premise is about labels, and a
  // lexicon name would be found unlabelled (detector 0.3.0).
  const raw = 'Patient Name,MRN,Note\nOttoline Varga,A12345,follow up\n';
  assert.equal(scanText(raw).findings.length, 0, 'premise: raw CSV hides both identifiers');
  const categories = scanText(extractCsvText(raw)).categories;
  assert.ok(categories.includes('PATIENT_NAME'));
  assert.ok(categories.includes('MRN'));
});

test('linearization puts every value beside its own header', () => {
  const out = extractCsvText('Claim,Status\nC-1,denied\nC-2,paid\n');
  assert.equal(out, 'Row 1\nClaim: C-1\nStatus: denied\n\nRow 2\nClaim: C-2\nStatus: paid\n');
});

// ── RFC 4180 correctness ───────────────────────────────────────────────────

test('quoted fields, escaped quotes, commas and CRLF', () => {
  assert.deepEqual(parseCsvRows('a,b\r\n"x, y","he said ""hi"""\r\n'), [
    ['a', 'b'],
    ['x, y', 'he said "hi"'],
  ]);
});

test('an embedded newline in a quoted value stays on its label line', () => {
  const out = extractCsvText('Note,Code\n"line one\nline two",A1\n');
  assert.match(out, /^Note: line one line two$/m);
});

test('blank lines are ignored; a trailing newline adds no row', () => {
  assert.equal(extractCsvText('A,B\n\n1,2\n\n'), 'Row 1\nA: 1\nB: 2\n');
});

test('empty trailing fields are preserved, not dropped', () => {
  assert.deepEqual(parseCsvRows('a,b,c\n1,,\n'), [['a', 'b', 'c'], ['1', '', '']]);
});

// ── Fail-closed refusals ──────────────────────────────────────────────────

test('an unterminated quote is CSV_MALFORMED', () => {
  refusesWith('CSV_MALFORMED', () => extractCsvText('a,b\n"open,2\n'));
});

test('a quote inside an unquoted field is CSV_MALFORMED', () => {
  refusesWith('CSV_MALFORMED', () => extractCsvText('a,b\nx"y,2\n'));
});

test('characters after a closing quote are CSV_MALFORMED', () => {
  refusesWith('CSV_MALFORMED', () => extractCsvText('a,b\n"x"y,2\n'));
});

test('a ragged row is refused rather than shifted under the wrong labels', () => {
  refusesWith('CSV_RAGGED_ROWS', () => extractCsvText('Name,MRN\nJane Doe\n'));
  refusesWith('CSV_RAGGED_ROWS', () => extractCsvText('A,B\n1,2,3\n'));
});

test('the ragged-row refusal names structure, never a value', () => {
  try {
    extractCsvText('Patient Name,MRN\nJane Doe\n');
    assert.fail('expected refusal');
  } catch (err) {
    assert.doesNotMatch(err.message, /Jane|Doe/);
  }
});

test('empty and duplicate headers are CSV_HEADER_INVALID', () => {
  refusesWith('CSV_HEADER_INVALID', () => extractCsvText('A,,C\n1,2,3\n'));
  refusesWith('CSV_HEADER_INVALID', () => extractCsvText('MRN,mrn\n1,2\n'));
});

test('a name column the detector cannot label refuses the whole file', () => {
  for (const header of ['First Name', 'Last Name', 'Guarantor Name', 'name_of_insured', 'Insured-Name', 'Patient (Last, First)', 'Client']) {
    refusesWith('CSV_UNRECOGNIZED_NAME_COLUMN', () => extractCsvText(`${header},Code\nJane,A1\n`));
  }
});

test('the name columns the detector DOES label are accepted', () => {
  // patient.name / patient_name are the Patient Name label with other separators (2026-09-24).
  for (const header of ['Name', 'Patient', 'Patient Name', 'patient  name', 'patient.name', 'patient_name', 'Guarantor', 'Patient:']) {
    assert.doesNotThrow(() => extractCsvText(`${header},Code\nJane Doe,A1\n`), header);
  }
});

test('header-only and empty CSVs are EMPTY_ARTIFACT', () => {
  refusesWith('EMPTY_ARTIFACT', () => extractCsvText('A,B\n'));
  refusesWith('EMPTY_ARTIFACT', () => extractCsvText('\n\n'));
});

test('bounds are refusals, never truncation', () => {
  refusesWith('ARTIFACT_TOO_LARGE', () => extractCsvText(`A\n${'x'.repeat(CSV_MAX_CELL_CHARS + 1)}\n`));
  const wide = Array.from({ length: CSV_MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join(',');
  refusesWith('ARTIFACT_TOO_LARGE', () => extractCsvText(`${wide}\n`));
  const tall = 'A\n' + '1\n'.repeat(CSV_MAX_ROWS + 1);
  refusesWith('ARTIFACT_TOO_LARGE', () => extractCsvText(tall));
  assert.doesNotThrow(() => extractCsvText('A\n' + '1\n'.repeat(CSV_MAX_ROWS)));
});

test('the tokenizer runs in linear time on a large quoted payload', () => {
  const big = 'A\n"' + 'x""'.repeat(200_000) + '"\n';
  const t0 = process.hrtime.bigint();
  assert.throws(() => extractCsvText(big)); // over the cell bound, refused
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `took ${ms}ms`);
});

// ── Ingestion wiring ──────────────────────────────────────────────────────

test('CSV must be declared: the same bytes as text/plain are NOT linearized', () => {
  const text = 'Claim,Status\nC-1,denied\n';
  const asCsv = ingestArtifact(csvBytes(text));
  const asTxt = ingestArtifact({ bytes: Buffer.from(text), mimeType: 'text/plain' });
  assert.equal(asCsv.ok, true);
  assert.equal(asCsv.mimeType, 'text/csv');
  assert.match(asCsv.text, /^Claim: C-1$/m);
  assert.equal(asTxt.mimeType, 'text/plain');
  assert.equal(asTxt.text, text);
});

test('the original hash is over the exact uploaded bytes, before linearization', async () => {
  const { sha256Hex } = await import('../src/artifact/hash.mjs');
  const text = 'A,B\r\n1,2\r\n';
  const r = ingestArtifact(csvBytes(text));
  assert.equal(r.originalHash, sha256Hex(Buffer.from(text, 'utf8')));
});

test('a CSV refusal keeps its own code and the original hash', () => {
  const r = ingestArtifact(csvBytes('A,B\n1\n'));
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'CSV_RAGGED_ROWS');
  assert.match(r.originalHash, /^[0-9a-f]{64}$/);
});

test('binary bytes declared as CSV are refused before parsing', () => {
  const r = ingestArtifact({ bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1]), mimeType: 'text/csv' });
  assert.equal(r.ok, false);
});

test('a leading BOM is stripped', () => {
  const r = ingestArtifact(csvBytes('﻿A,B\n1,2\n'));
  assert.equal(r.ok, true);
  assert.match(r.text, /^A: 1$/m);
});

test('both CSV MIME types are supported', () => {
  assert.ok(SUPPORTED_MIME_TYPES.includes('text/csv'));
  assert.ok(SUPPORTED_MIME_TYPES.includes('application/csv'));
});

// ── End to end through the real prepare path ─────────────────────────────

test('a PHI-bearing CSV is detected, tokenized, verified — and the release carries no identifier', async () => {
  const prepared = await prepareDocumentForEgress({
    source: csvBytes('Patient Name,MRN,Status\nJane Doe,A12345,denied\n'),
    prompt: 'Summarize the claim status.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'denial_review',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'test',
    deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer() },
  });
  assert.equal(prepared.outcome, 'PREPARED', prepared.reasonCode);
  assert.doesNotMatch(prepared.releaseText, /Jane|Doe|A12345/);
  assert.match(prepared.releaseText, /Patient Name: \[PATIENT_001\]/);
  assert.equal(prepared.artifact.mimeType, 'text/csv');
  assert.equal(prepared.artifact.verification.status, 'passed');
});

test('a CSV with an unlabelable name column never reaches detection', async () => {
  const prepared = await prepareDocumentForEgress({
    source: csvBytes('First Name,Last Name\nJane,Doe\n'),
    prompt: 'Summarize.',
    destination: { provider: 'anthropic', service: 'messages' },
    purpose: 'denial_review',
    policy: HEALTHCARE_REFERENCE_POLICY,
    actor: 'test',
    deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer() },
  });
  assert.equal(prepared.outcome, 'DENY');
  assert.equal(prepared.reasonCode, 'CSV_UNRECOGNIZED_NAME_COLUMN');
  assert.equal(prepared.releaseText, undefined);
});

// ── How browsers actually declare a CSV ───────────────────────────────────

test('a .csv with no MIME type is linearized, not treated as plain text', () => {
  const r = ingestArtifact({ bytes: Buffer.from('Patient Name,MRN\nJane Doe,A12345\n'), filename: 'Export.CSV' });
  assert.equal(r.ok, true);
  assert.equal(r.mimeType, 'text/csv');
  assert.match(r.text, /^Patient Name: Jane Doe$/m);
});

test('a .csv declared text/plain is still linearized — the extension wins in the fail-safe direction', () => {
  const r = ingestArtifact({ bytes: Buffer.from('A,B\n1,2\n'), mimeType: 'text/plain', filename: 'x.csv' });
  assert.equal(r.mimeType, 'text/csv');
});

test('Windows labels .csv as application/vnd.ms-excel: accepted only for text bytes', () => {
  const ok = ingestArtifact({ bytes: Buffer.from('A,B\n1,2\n'), mimeType: 'application/vnd.ms-excel', filename: 'x.csv' });
  assert.equal(ok.ok, true);
  assert.equal(ok.mimeType, 'text/csv');
  // A real XLS (OLE compound file) sniffs as binary and is still refused.
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  const xls = ingestArtifact({ bytes: ole, mimeType: 'application/vnd.ms-excel', filename: 'x.csv' });
  assert.equal(xls.ok, false);
  // And the Excel MIME type without a .csv name is never CSV.
  const noName = ingestArtifact({ bytes: Buffer.from('A,B\n1,2\n'), mimeType: 'application/vnd.ms-excel' });
  assert.equal(noName.ok, false);
  assert.equal(noName.reasonCode, 'UNSUPPORTED_ARTIFACT');
});

test('a CSV declaration never reinterprets a PDF or DOCX', () => {
  const pdf = ingestArtifact({ bytes: Buffer.from('%PDF-1.4\n'), mimeType: 'text/csv', filename: 'x.csv' });
  assert.equal(pdf.ok, false);
  assert.equal(pdf.reasonCode, 'MIME_MISMATCH');
});
