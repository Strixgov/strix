/**
 * Append-only, hash-chained evidence log for governed egress.
 *
 * PRIVACY CONSTRAINT (spec §4, load-bearing): the evidence system must not
 * store the PHI it protects. Every entry is built field-by-field from
 * hashes, counts, categories, tokens, reason codes, policy ids, destination
 * names, actor ids and timestamps — never from document text, finding
 * values, or prompts. The rule is enforced where entries are CONSTRUCTED
 * (gate.mjs / pipeline.mjs build each entry field-by-field, never by
 * spreading caller input), and the outcome is proven by
 * test/evidence-no-phi.test.mjs, which checks the whole serialized log
 * against every raw value in the synthetic fixture.
 *
 * CHAINING (added by the 2026-09-03 360 review): each record carries
 * `entryHash` = sha256 over a canonical serialization of its own content
 * plus `prevHash`, the previous record's entryHash ('genesis' for the
 * first). `verifyEvidenceChain` re-derives every link, so an edited,
 * removed, or reordered entry is DETECTABLE from the log alone. Honest
 * ceiling, stated because chains are chronically over-read (the NAV-1
 * lesson): a self-consistent chain proves only INTERNAL CONSISTENCY — the
 * whole log is unsigned and locally held, so a party who can rewrite one
 * entry can rewrite them all and re-chain. Tamper-EVIDENT against partial
 * edits, never tamper-PROOF, and never a signed Strix artifact. Signing
 * against the Strix operational key and binding into DecisionEvidence is
 * the named Phase-B kernel integration (see README); this chain exists so
 * that migration binds ONE root hash rather than N loose rows.
 *
 * v0.1 evidence entries are UNSIGNED local records — a record, not proof.
 *
 * SIGNING (2026-09-28): pass a signer (signing.mjs) and every record is
 * also Ed25519-signed with a customer-held key, checked by
 * `verifySignedEvidence`. The unsigned default and this function's
 * INTERNAL_CONSISTENCY_ONLY ceiling are unchanged.
 */
import { createHash } from 'node:crypto';

/**
 * Canonical serialization for chain hashing: recursively key-sorted JSON.
 * Local to this log — deliberately NOT a general canonicalizer (CJ-1: the
 * platform's SCJ v1 is the only sanctioned canonicalizer for SIGNED
 * artifacts; this log is unsigned and its hashes never leave the package's
 * own chain-verification, so a private, simpler form avoids minting a
 * second serializer anything else could come to depend on).
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    // JSON's own rule: undefined (and functions/symbols) become null inside
    // arrays; object keys holding them are dropped below.
    const json = JSON.stringify(value);
    return json === undefined ? 'null' : json;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  // Keys whose value JSON would drop are dropped here too. Before 2026-09-28
  // they were hashed as the text `undefined`, so a record carrying one (every
  // proxy refusal has `purpose: undefined`) could never be verified once
  // written to a JSONL file and read back: the key was gone from the file
  // but inside the hash.
  const keys = Object.keys(value)
    .filter((k) => JSON.stringify(value[k]) !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function entryHashOf(record, prevHash) {
  return createHash('sha256').update(`${prevHash}\n${canonical(record)}`, 'utf8').digest('hex');
}

/**
 * @param {{ signer?: { keyId: string, sign(entryHash: string): string },
 *           resume?: { seq: number, headHash: string } }} [options]
 *   `signer` (see signing.mjs) signs every record: its keyId goes INSIDE the
 *   hashed content, and the signature over entryHash sits beside it.
 *   `resume` continues an existing chain (a restarted proxy appending to
 *   the same file); obtain it from signing.mjs `resumePointOf`, which
 *   verifies the existing records first.
 */
export function createInMemoryEvidenceLog(options = {}) {
  const { signer, resume } = options;
  if (resume !== undefined) {
    const okHead = resume.headHash === 'genesis' || /^[0-9a-f]{64}$/.test(resume.headHash);
    if (!Number.isInteger(resume.seq) || resume.seq < 0 || !okHead || (resume.seq === 0) !== (resume.headHash === 'genesis')) {
      throw new TypeError('resume must be { seq, headHash } from an existing, verified log');
    }
  }
  const entries = [];
  let seq = resume?.seq ?? 0;
  let prevHash = resume?.headHash ?? 'genesis';
  return {
    append(entry) {
      if (entry && (Object.hasOwn(entry, 'signature') || Object.hasOwn(entry, 'signingKeyId'))) {
        throw new TypeError('evidence entries may not carry signature fields; the log adds them');
      }
      const content = { ...entry, seq: (seq += 1), at: new Date().toISOString() };
      if (signer) content.signingKeyId = signer.keyId;
      const entryHash = entryHashOf(content, prevHash);
      const record = Object.freeze(
        signer ? { ...content, prevHash, entryHash, signature: signer.sign(entryHash) } : { ...content, prevHash, entryHash },
      );
      prevHash = entryHash;
      entries.push(record);
      return record;
    },
    list() {
      return [...entries];
    },
  };
}

/**
 * Re-derive every link of a presented evidence log.
 *
 * @param {Array<object>} records — as returned by list() (or re-read from
 *   wherever a deployment persisted them).
 * @returns {{ valid: true, length: number, headHash: string | 'genesis', proves: 'INTERNAL_CONSISTENCY_ONLY' }
 *         | { valid: false, index: number, reasonCode: 'CHAIN_LINK_BROKEN'|'ENTRY_HASH_MISMATCH'|'SEQ_GAP', detail: string, proves: 'INTERNAL_CONSISTENCY_ONLY' }}
 *
 * `proves` is a literal FIELD on every result (the Break Strix
 * evidenceAddressable discipline) so no surface rendering a verdict can
 * round "the chain is self-consistent" up to "the log is authentic".
 */
export function verifyEvidenceChain(records) {
  const proves = 'INTERNAL_CONSISTENCY_ONLY';
  let prevHash = 'genesis';
  for (let i = 0; i < records.length; i += 1) {
    // `signature` sits outside the hashed content (it signs entryHash);
    // `signingKeyId` is inside it. Stripping a signature leaves the chain
    // valid, which is why signed logs are checked with verifySignedEvidence.
    const { entryHash, prevHash: claimedPrev, signature: _signature, ...content } = records[i];
    if (claimedPrev !== prevHash) {
      return {
        valid: false,
        index: i,
        reasonCode: 'CHAIN_LINK_BROKEN',
        detail: `entry ${i} claims prevHash ${String(claimedPrev).slice(0, 12)}… but the chain head is ${prevHash.slice(0, 12)}… — an entry was removed, reordered, or injected`,
        proves,
      };
    }
    if (content.seq !== i + 1) {
      return {
        valid: false,
        index: i,
        reasonCode: 'SEQ_GAP',
        detail: `entry ${i} carries seq ${String(content.seq)}, expected ${i + 1}`,
        proves,
      };
    }
    const derived = entryHashOf(content, prevHash);
    if (derived !== entryHash) {
      return {
        valid: false,
        index: i,
        reasonCode: 'ENTRY_HASH_MISMATCH',
        detail: `entry ${i}'s content does not re-derive its own entryHash — the entry was edited after it was appended`,
        proves,
      };
    }
    prevHash = entryHash;
  }
  return { valid: true, length: records.length, headHash: prevHash, proves };
}
