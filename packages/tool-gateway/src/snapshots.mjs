/**
 * Chain snapshots — cross-signed key-rotation boundary markers.
 *
 * When a KeyRing rotates, the receipt chain transitions from being signed
 * by the old kid to being signed by the new kid. A naive verifier walking
 * the chain forward would see the kid change and have no proof that the
 * holder of the new key authorised the rotation, opening the door to a
 * "swap the JWKS, rewrite the tail" attack from a future compromise.
 *
 * Snapshot solves it: at rotation, the gateway emits a single record that
 *
 *   - commits to the LAST receipt under the previous kid
 *     (`lastReceiptId`, `lastProofChainHash`),
 *   - names both kids (`previousKid`, `newKid`),
 *   - is signed twice — once by the previous kid (the last act of the
 *     retiring key) and once by the new kid (the first act of its
 *     successor).
 *
 * A tampered "swap the JWKS" attack is now visible: the previous-kid
 * signature can only be produced by the holder of the previous private
 * key, which was retired moments before. Any valid snapshot is a
 * cryptographic claim that the same operator controls both keys.
 *
 * Snapshots are append-only, kept in a separate JSONL alongside receipts
 * (`snapshots.jsonl`). They are not part of the receipt proof chain —
 * they are a parallel chain that *names* the receipt-chain boundary.
 *
 * Locked field order — DO NOT REORDER:
 *
 *   schemaVersion → snapshotId → previousKid → newKid → lastReceiptId
 *   → lastProofChainHash → policyVersion → tenantId → environment
 *   → timestamp
 */

import crypto from "node:crypto";
import { canonicalJSON } from "./canonical.mjs";

export const SNAPSHOT_SCHEMA_VERSION = "snap-1";

// Dispatch table for snapshot verification: add new versions here.
export const SUPPORTED_SNAPSHOT_VERSIONS = Object.freeze(["snap-1"]);

const SNAPSHOT_FIELD_ORDER = Object.freeze([
  "schemaVersion",
  "snapshotId",
  "previousKid",
  "newKid",
  "lastReceiptId",
  "lastProofChainHash",
  "policyVersion",
  "tenantId",
  "environment",
  "timestamp",
]);

/**
 * @param {object} canonical
 * @returns {string}
 */
export function canonicalSnapshotPayload(canonical) {
  if (!canonical || typeof canonical !== "object") {
    throw new TypeError("canonicalSnapshotPayload: payload must be an object");
  }
  const parts = [];
  for (const field of SNAPSHOT_FIELD_ORDER) {
    const value = canonical[field];
    if (value === undefined || value === null) {
      throw new Error(
        `canonicalSnapshotPayload: required field '${field}' is missing`,
      );
    }
    parts.push(`${JSON.stringify(field)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}

export function newSnapshotId() {
  return `snap_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Build a doubly-signed snapshot.
 *
 * @param {{
 *   previousKey: import("./types.d.ts").SigningKey,
 *   newKey: import("./types.d.ts").SigningKey,
 *   lastReceiptId: string,
 *   lastProofChainHash: string,
 *   policyVersion: string,
 *   tenantId: string,
 *   environment: string,
 *   timestamp?: string,
 *   snapshotId?: string,
 * }} args
 */
export function issueSnapshot(args) {
  const {
    previousKey,
    newKey,
    lastReceiptId,
    lastProofChainHash,
    policyVersion,
    tenantId,
    environment,
  } = args;
  if (!previousKey?.privateKey) {
    throw new Error("issueSnapshot: previousKey.privateKey is required");
  }
  if (!newKey?.privateKey) {
    throw new Error("issueSnapshot: newKey.privateKey is required");
  }
  if (previousKey.kid === newKey.kid) {
    throw new Error("issueSnapshot: previous and new kid must differ");
  }
  if (typeof lastReceiptId !== "string" || !lastReceiptId) {
    throw new Error("issueSnapshot: lastReceiptId is required");
  }
  if (typeof lastProofChainHash !== "string" || lastProofChainHash.length !== 64) {
    throw new Error("issueSnapshot: lastProofChainHash must be 64 hex chars");
  }
  if (typeof policyVersion !== "string" || !policyVersion) {
    throw new Error("issueSnapshot: policyVersion is required");
  }

  const canonical = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: args.snapshotId ?? newSnapshotId(),
    previousKid: previousKey.kid,
    newKid: newKey.kid,
    lastReceiptId,
    lastProofChainHash,
    policyVersion,
    tenantId,
    environment,
    timestamp: args.timestamp ?? new Date().toISOString(),
  };

  const payload = Buffer.from(canonicalSnapshotPayload(canonical), "utf8");
  const signaturePrevious = crypto
    .sign(null, payload, previousKey.privateKey)
    .toString("base64url");
  const signatureNew = crypto
    .sign(null, payload, newKey.privateKey)
    .toString("base64url");

  return {
    ...canonical,
    signaturePrevious,
    signatureNew,
  };
}

/**
 * Verify a snapshot. Returns one verification result per signature so the
 * caller can distinguish "previous-key signed, new-key didn't" from a
 * fully-valid snapshot.
 *
 * @param {object} snapshot
 * @param {{
 *   resolvePublicKey: (kid: string) => import("node:crypto").KeyObject | null,
 * }} opts
 */
export function verifySnapshot(snapshot, opts) {
  const result = {
    snapshotId: snapshot?.snapshotId,
    previousSignatureValid: false,
    newSignatureValid: false,
    status: "ERROR",
  };
  try {
    if (!snapshot || typeof snapshot !== "object") {
      result.error = "snapshot is not an object";
      return result;
    }
    if (!SUPPORTED_SNAPSHOT_VERSIONS.includes(snapshot.schemaVersion)) {
      result.error = `unsupported schemaVersion: '${snapshot.schemaVersion}' (supported: ${SUPPORTED_SNAPSHOT_VERSIONS.join(", ")})`;
      return result;
    }
    const canonical = {};
    for (const field of SNAPSHOT_FIELD_ORDER) canonical[field] = snapshot[field];
    const payload = Buffer.from(canonicalSnapshotPayload(canonical), "utf8");

    const previousKey = opts.resolvePublicKey(snapshot.previousKid);
    const newKey = opts.resolvePublicKey(snapshot.newKid);
    if (!previousKey) {
      result.error = `previous kid not resolvable: ${snapshot.previousKid}`;
      return result;
    }
    if (!newKey) {
      result.error = `new kid not resolvable: ${snapshot.newKid}`;
      return result;
    }
    if (snapshot.signaturePrevious) {
      result.previousSignatureValid = crypto.verify(
        null,
        payload,
        previousKey,
        Buffer.from(snapshot.signaturePrevious, "base64url"),
      );
    }
    if (snapshot.signatureNew) {
      result.newSignatureValid = crypto.verify(
        null,
        payload,
        newKey,
        Buffer.from(snapshot.signatureNew, "base64url"),
      );
    }
    if (result.previousSignatureValid && result.newSignatureValid) {
      result.status = "VERIFIED";
    } else if (result.previousSignatureValid || result.newSignatureValid) {
      result.status = "PARTIAL";
    } else {
      result.status = "TAMPERED";
    }
  } catch (err) {
    result.error = err?.message ?? String(err);
    result.status = "ERROR";
  }
  return result;
}

export { SNAPSHOT_FIELD_ORDER };
