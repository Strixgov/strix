/**
 * OOXML ZIP container reader for multi-part formats (XLSX, PPTX).
 *
 * Same discipline as the DOCX reader — the central directory is authoritative,
 * local-header sizes are never trusted, only STORED and DEFLATE are accepted —
 * with one difference that matters for a multi-part format: the inflate bound
 * is a BUDGET SHARED ACROSS EVERY PART read from one artifact. A per-part cap
 * is enough for DOCX (one document part) and is not enough for a workbook: a
 * file with forty sheets each inflating to just under the per-part cap would
 * pass every individual check while materializing gigabytes. Exceeding the
 * budget is ARTIFACT_TOO_LARGE, never a truncation — a truncated sheet would
 * be released partially unscanned.
 */
import { inflateRawSync } from 'node:zlib';
import { MAX_INFLATED_BYTES } from './limits.mjs';

export class ZipContainerError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'ZipContainerError';
    this.reasonCode = reasonCode;
  }
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_ENTRIES = 10_000;

/**
 * The end-of-central-directory record must END the file: its comment length
 * has to land exactly on the last byte. A signature found anywhere else (say,
 * inside a comment) would let this reader follow a different central
 * directory than the one another tool uses.
 */
function findEocd(buf) {
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  return -1;
}

/**
 * Open a container. Returns `{ names, read(name) }`, where `read` returns the
 * inflated bytes of one entry (or null when absent) and draws on a single
 * budget for the whole container.
 */
export function openZipContainer(buf, { budget = MAX_INFLATED_BYTES } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipContainerError('UNSUPPORTED_ARTIFACT', 'not a ZIP container');
  const eocd = findEocd(buf);
  if (eocd === -1) throw new ZipContainerError('UNSUPPORTED_ARTIFACT', 'no ZIP end-of-central-directory');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ENTRIES) throw new ZipContainerError('ARTIFACT_TOO_LARGE', 'too many container entries');
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  const foldedNames = new Set();
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) {
      throw new ZipContainerError('UNSUPPORTED_ARTIFACT', 'malformed ZIP central directory');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    // Two entries with one name: which one a reader picks is
    // implementation-defined, so the scanned part and the part another tool
    // displays could differ. Refused rather than guessed. OOXML part names
    // are case-INSENSITIVE, so names differing only in case collide too.
    const folded = name.toLowerCase();
    if (entries.has(name) || foldedNames.has(folded)) {
      throw new ZipContainerError('UNSUPPORTED_ARTIFACT', 'duplicate container entry name');
    }
    foldedNames.add(folded);
    entries.set(name, { method, compSize, size, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  let remaining = budget;
  function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    const { method, compSize, size, localOffset } = e;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new ZipContainerError('UNSUPPORTED_ARTIFACT', 'malformed ZIP local header');
    }
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compSize > buf.length) throw new ZipContainerError('UNSUPPORTED_ARTIFACT', 'truncated ZIP entry');
    const data = buf.subarray(dataStart, dataStart + compSize);
    let out;
    if (method === 0) {
      out = Buffer.from(data);
    } else if (method === 8) {
      if (remaining <= 0) throw new ZipContainerError('ARTIFACT_TOO_LARGE', 'container exceeds the inflate budget');
      try {
        out = inflateRawSync(data, { maxOutputLength: remaining });
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZipContainerError('ARTIFACT_TOO_LARGE', 'container exceeds the inflate budget');
        }
        throw new ZipContainerError('UNSUPPORTED_ARTIFACT', 'a container part failed to inflate');
      }
    } else {
      throw new ZipContainerError('UNSUPPORTED_ARTIFACT', `unsupported ZIP compression method ${method}`);
    }
    remaining -= out.length;
    if (remaining < 0) throw new ZipContainerError('ARTIFACT_TOO_LARGE', 'container exceeds the inflate budget');
    // The declared size must match what came out. A mismatch means the entry
    // was cut short or padded, and a short read is a partial document.
    if (out.length !== size) throw new ZipContainerError('UNSUPPORTED_ARTIFACT', 'a container part does not match its declared size');
    return out;
  }

  return Object.freeze({ names: Object.freeze([...entries.keys()]), read });
}

/**
 * Macros are found by what the package DECLARES, not by one file name: a
 * VBA project renamed away from `vbaProject.bin` is still declared in
 * `[Content_Types].xml`.
 */
export function hasMacros(zip) {
  if (zip.names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n))) return true;
  const types = zip.read('[Content_Types].xml');
  return types !== null && /vbaProject|macroEnabled|vnd\.ms-office\.activeX/i.test(types.toString('utf8'));
}

/** Which OOXML document a container holds, from its parts — never from its name. */
export function ooxmlKind(names) {
  const set = new Set(names);
  const kinds = [];
  if (set.has('word/document.xml')) kinds.push('docx');
  if (set.has('xl/workbook.xml')) kinds.push('xlsx');
  if (set.has('ppt/presentation.xml')) kinds.push('pptx');
  // A container claiming two document types is ambiguous by construction.
  return kinds.length === 1 ? kinds[0] : null;
}
