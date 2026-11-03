/**
 * SYNTHETIC TEST FIXTURE — every identifier in this file is fictional and
 * was invented for this test corpus. No real person, patient, provider, or
 * record is referenced. The values deliberately use reserved/example ranges
 * where they exist (555 phone prefix, example.com, the canonical fake SSN).
 *
 * The fixture also exports the raw identifier values as SYNTHETIC_PHI so
 * the no-PHI-in-evidence test can prove the negative: none of these strings
 * may appear in any evidence entry, receipt, or released artifact.
 */
import { deflateSync, deflateRawSync, crc32 } from 'node:zlib';

export const SYNTHETIC_PHI = Object.freeze({
  patientName: 'William Sampleton',
  patientLastName: 'Sampleton',
  dob: '04/12/1972',
  mrn: '99218472',
  ssn: '123-45-6789',
  phone: '(615) 555-0147',
  email: 'w.sampleton@example.com',
  street: '4821 Riverbend Court',
  cityStateZip: 'Gallatin, TN 37066',
  memberId: 'BCTN-88231-X',
  encounterDate: '08/14/2026',
  followUpDate: '09/02/2026',
});

export const CLINICAL_CONTENT = Object.freeze([
  'comprehensive metabolic panel',
  'fasting lipid profile',
  'results reviewed with the patient',
]);

export function buildRecordText() {
  const p = SYNTHETIC_PHI;
  return [
    'EXAMPLE LABORATORY - PATIENT ENCOUNTER SUMMARY',
    '(synthetic test record - every identifier below is fictional)',
    '',
    `Patient: ${p.patientName}`,
    `DOB: ${p.dob}`,
    `MRN: ${p.mrn}`,
    `SSN: ${p.ssn}`,
    `Phone: ${p.phone}`,
    `Email: ${p.email}`,
    `Address: ${p.street}, ${p.cityStateZip}`,
    `Member ID: ${p.memberId}`,
    '',
    `Encounter date: ${p.encounterDate}`,
    '',
    `${p.patientName} presented for a ${CLINICAL_CONTENT[0]} and a`,
    `${CLINICAL_CONTENT[1]}. All analytes within reference ranges;`,
    `${CLINICAL_CONTENT[2]}.`,
    '',
    `Follow-up scheduled for ${p.followUpDate}. Contact Mr. ${p.patientLastName}`,
    `at ${p.phone} to confirm the appointment.`,
  ].join('\n');
}

/**
 * ASCII → full-width (U+FF01–U+FF5E). DERIVED from the single declared
 * synthetic SSN rather than hand-written a second time, so the obfuscated
 * form provably encodes the same number and the two can never drift apart.
 */
export function toFullWidth(s) {
  return String(s).replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
}

/**
 * A note whose ONLY identifier is a full-width copy of the synthetic SSN.
 * An ASCII-shape detector finds nothing in it; NFKC normalization reveals
 * the SSN. This is the evasion the boundary's normalization pass exists to
 * refuse (OBFUSCATED_SENSITIVE_DATA) — never to silently sanitize, because
 * normalized offsets cannot be mapped back onto the raw bytes safely.
 */
export function buildObfuscatedText() {
  return [
    'EXAMPLE LABORATORY - QUARTERLY WELLNESS SUMMARY',
    '(synthetic test record - every identifier below is fictional)',
    '',
    'The comprehensive metabolic panel was unremarkable and follow-up is',
    'routine. No action is required before the next scheduled draw.',
    '',
    `Filing reference: ＳＳＮ ${toFullWidth(SYNTHETIC_PHI.ssn)}`,
  ].join('\n');
}

export function buildCleanText() {
  return [
    'EXAMPLE LABORATORY - ASSAY PROTOCOL NOTE',
    '',
    'The comprehensive metabolic panel is processed on the primary analyzer',
    'within four hours of collection. Reference ranges follow the current',
    'laboratory procedure manual. No identifiers appear in this note.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Minimal PDF builder (text drawn with Tj; optional FlateDecode).     */
/* ------------------------------------------------------------------ */

function escapePdfString(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildRecordPdf(text = buildRecordText(), { compress = false } = {}) {
  const lines = text.split('\n');
  const ops = ['BT', '/F1 10 Tf', '50 770 Td'];
  lines.forEach((line, i) => {
    if (i > 0) ops.push('0 -14 Td');
    ops.push(`(${escapePdfString(line)}) Tj`);
  });
  ops.push('ET');
  let stream = Buffer.from(ops.join('\n'), 'latin1');
  let filter = '';
  if (compress) {
    stream = deflateSync(stream);
    filter = ' /Filter /FlateDecode';
  }

  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  objects.push({ dict: `<< /Length ${stream.length}${filter} >>`, stream });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [0];
  let position = chunks[0].length;
  objects.forEach((obj, i) => {
    offsets.push(position);
    let body;
    if (typeof obj === 'string') {
      body = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, 'latin1');
    } else {
      body = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n${obj.dict}\nstream\n`, 'latin1'),
        obj.stream,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    }
    chunks.push(body);
    position += body.length;
  });

  const xrefStart = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

/** A PDF whose only content is an image XObject — the scanned-PDF shape. */
export function buildImageOnlyPdf() {
  const image = Buffer.alloc(64, 0xab);
  const content = Buffer.from('q 100 0 0 100 50 600 cm /Im1 Do Q', 'latin1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
    { dict: `<< /Length ${content.length} >>`, stream: content },
    { dict: `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${image.length} >>`, stream: image },
  ];
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [0];
  let position = chunks[0].length;
  objects.forEach((obj, i) => {
    let body;
    offsets.push(position);
    if (typeof obj === 'string') {
      body = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, 'latin1');
    } else {
      body = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n${obj.dict}\nstream\n`, 'latin1'),
        obj.stream,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    }
    chunks.push(body);
    position += body.length;
  });
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/** A PDF declaring /Encrypt — must refuse ENCRYPTED_ARTIFACT. */
export function buildEncryptedMarkerPdf() {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF\n',
    'latin1',
  );
}

/* ------------------------------------------------------------------ */
/* Minimal DOCX builder (real ZIP: stored + deflated entries).         */
/* ------------------------------------------------------------------ */

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function zipEntry(name, data, { deflate = false } = {}) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data) >>> 0;
  const method = deflate ? 8 : 0;
  const payload = deflate ? deflateRawSync(data) : data;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0, 12); // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  return { name: nameBuf, method, crc, payload, uncompressed: data.length, local };
}

export function buildDocx(text = buildRecordText()) {
  const paragraphs = text
    .split('\n')
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`)
    .join('');
  const documentXml = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${paragraphs}</w:body></w:document>`,
    'utf8',
  );
  const contentTypes = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
    'utf8',
  );
  const rels = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
    'utf8',
  );

  const entries = [
    zipEntry('[Content_Types].xml', contentTypes),
    zipEntry('_rels/.rels', rels),
    zipEntry('word/document.xml', documentXml, { deflate: true }),
  ];

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    chunks.push(e.local, e.name, e.payload);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0, 8); // flags
    cen.writeUInt16LE(e.method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(e.crc, 16);
    cen.writeUInt32LE(e.payload.length, 20);
    cen.writeUInt32LE(e.uncompressed, 24);
    cen.writeUInt16LE(e.name.length, 28);
    cen.writeUInt16LE(0, 30); // extra len
    cen.writeUInt16LE(0, 32); // comment len
    cen.writeUInt16LE(0, 34); // disk
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, e.name]));
    offset += e.local.length + e.name.length + e.payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}
