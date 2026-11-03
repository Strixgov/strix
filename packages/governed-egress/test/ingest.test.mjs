import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestArtifact, MAX_ARTIFACT_BYTES } from '../src/artifact/ingest.mjs';
import {
  buildRecordText,
  buildRecordPdf,
  buildImageOnlyPdf,
  buildEncryptedMarkerPdf,
  buildDocx,
} from '../fixtures/synthetic-patient-record.mjs';

const text = buildRecordText();

test('txt bytes ingest to the exact text', () => {
  const r = ingestArtifact({ bytes: Buffer.from(text, 'utf8'), mimeType: 'text/plain' });
  assert.equal(r.ok, true);
  assert.equal(r.text, text);
  assert.match(r.originalHash, /^[0-9a-f]{64}$/);
});

test('pasted text ingests without bytes', () => {
  const r = ingestArtifact({ text });
  assert.equal(r.ok, true);
  assert.equal(r.text, text);
  assert.equal(r.mimeType, 'text/plain');
});

test('PDF with plain text streams extracts every labeled line', () => {
  const r = ingestArtifact({ bytes: buildRecordPdf(text) });
  assert.equal(r.ok, true);
  assert.ok(r.text.includes('MRN: 99218472'));
  assert.ok(r.text.includes('William Sampleton presented'));
});

test('PDF with FlateDecode streams extracts identically', () => {
  const plain = ingestArtifact({ bytes: buildRecordPdf(text) });
  const flate = ingestArtifact({ bytes: buildRecordPdf(text, { compress: true }) });
  assert.equal(flate.ok, true);
  assert.equal(flate.text, plain.text);
});

test('DOCX extracts every labeled line', () => {
  const r = ingestArtifact({ bytes: buildDocx(text) });
  assert.equal(r.ok, true);
  assert.ok(r.text.includes('SSN: 123-45-6789'));
  assert.ok(r.text.includes('Follow-up scheduled for 09/02/2026'));
});

// Superseded expectation kept on the record: this asserted
// `UNSUPPORTED_ARTIFACT` until the production extraction chain landed. That
// name said "we do not support this file type" about a file type we DO
// support — a PDF — whose text simply is not extractable without OCR, so it
// sent an operator to the wrong remedy. `extractProductionPdfText` now
// renames exactly that case to OCR_REQUIRED and `pdf-production-ingestion.test.mjs`
// asserts the new name; these two assertions were left behind and had been
// failing on main since that change merged. The refusal itself did not move:
// still `ok: false`, still before any scan, still nothing released.
test('image-only (scanned-shape) PDF fails closed, naming OCR as the remedy', () => {
  const r = ingestArtifact({ bytes: buildImageOnlyPdf() });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'OCR_REQUIRED');
});

test('PDF declaring /Encrypt fails closed as encrypted', () => {
  const r = ingestArtifact({ bytes: buildEncryptedMarkerPdf() });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'ENCRYPTED_ARTIFACT');
});

test('unknown binary (PNG magic) fails closed', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const r = ingestArtifact({ bytes: png });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'UNSUPPORTED_ARTIFACT');
});

test('declared mimeType that disagrees with the bytes refuses (sniff wins)', () => {
  const r = ingestArtifact({ bytes: buildRecordPdf(text), mimeType: 'text/plain' });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'MIME_MISMATCH');
});

test('declared unsupported mimeType refuses even for text bytes', () => {
  const r = ingestArtifact({ bytes: Buffer.from('hello', 'utf8'), mimeType: 'image/png' });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'UNSUPPORTED_ARTIFACT');
});

test('NUL bytes in claimed text fail closed', () => {
  const r = ingestArtifact({ bytes: Buffer.from([0x61, 0x62, 0x63, 0, 0x64, 0x65, 0x66]) });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'UNSUPPORTED_ARTIFACT');
});

test('empty and oversize artifacts refuse with named reasons', () => {
  assert.equal(ingestArtifact({ bytes: Buffer.alloc(0) }).reasonCode, 'EMPTY_ARTIFACT');
  assert.equal(ingestArtifact({ text: '   ' }).reasonCode, 'EMPTY_ARTIFACT');
  const big = Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x61);
  assert.equal(ingestArtifact({ bytes: big }).reasonCode, 'ARTIFACT_TOO_LARGE');
});

test('a source with neither text nor bytes refuses', () => {
  assert.equal(ingestArtifact({}).reasonCode, 'UNSUPPORTED_ARTIFACT');
  assert.equal(ingestArtifact(null).reasonCode, 'UNSUPPORTED_ARTIFACT');
});
