import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const HASH_FIELDS = Object.freeze([
  "capabilityId", "actorId", "actorRole", "actorEmail",
  "action", "reason", "source", "timestamp",
]);

/** Compare API projections with the authenticated SE-v1 envelope. Never
 * promote unsigned fields into the authenticated display object. */
export function evidenceFieldMismatches(record, payload) {
  const mismatches = [];
  const check = (name, value, expected) => {
    if (!isDeepStrictEqual(value, expected)) mismatches.push(name);
  };
  for (const field of Object.keys(payload)) {
    if (!Object.hasOwn(record, field)) continue;
    // Academy DB insertion time differs from the writer's signed timestamp.
    // Display only envelope createdAt; compare the API's hashedAt below.
    if (field === "createdAt" && typeof payload.schemaVersion === "number"
      && Object.hasOwn(record, "hashedAt")) continue;
    if (field === "schemaVersion" || field === "evidenceId") {
      check(field, String(record[field]), String(payload[field]));
    } else {
      check(field, record[field], payload[field]);
    }
  }
  for (const [alias, value, expected] of [
    ["decision", record.decision, payload.action],
    ["actor.id", record.actor?.id, payload.actorId],
    ["actor.role", record.actor?.role, payload.actorRole],
    ["hashedAt", record.hashedAt, payload.createdAt],
  ]) {
    if (value !== undefined) check(alias, value, expected);
  }
  return mismatches;
}

/** Independent Academy computeEvidenceHash (8 fields, insertion order).
 * Server hashMatch/recomputedHash/hashInputFields never select the algorithm
 * or supply the digest. Missing inputs are NOT_CHECKED. This does not
 * implement Console postReceipt hashing or timestamp search. */
export function checkEvidenceContentHash(record, payload) {
  const unavailable = (reason) => ({ valid: null, recomputedHash: null, profile: null, inputFields: [], reason });
  if (record.sourceApp !== "academy-platform" && typeof payload?.schemaVersion !== "number") {
    return unavailable("UNSUPPORTED_HASH_PROFILE");
  }
  const timestamp = record.hashedAt ?? payload?.createdAt ?? record.createdAt;
  const input = {
    capabilityId: record.capabilityId,
    actorId: record.actorId ?? record.actor?.id,
    actorRole: record.actorRole ?? record.actor?.role,
    actorEmail: record.actorEmail ?? null,
    action: record.action ?? record.decision,
    reason: record.reason ?? null,
    source: record.source,
    timestamp,
  };
  if (!HASH_FIELDS.every((k) => input[k] === null || typeof input[k] === "string")
    || !["actorEmail", "reason"].every((k) => Object.hasOwn(record, k))
    || typeof record.evidenceHash !== "string") {
    return unavailable("EVIDENCE_HASH_INPUTS_MISSING");
  }
  const digest = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  let recomputedHash = digest(input);
  let profile = "academy_canonical_8field_v1";
  let inputFields = [...HASH_FIELDS];
  // Historical compatibility restricted to the two documented writers.
  // No arbitrary server field list, no brute-force timestamp repair.
  if (recomputedHash !== record.evidenceHash
    && ((input.source === "ai" && input.actorRole === "ai_agent")
      || (input.source === "cron" && input.actorRole === "simulated_attacker"))) {
    const { actorEmail, ...legacy } = input;
    const legacyHash = digest(legacy);
    if (legacyHash === record.evidenceHash) {
      recomputedHash = legacyHash;
      profile = "academy_legacy_ai_7field_v0";
      inputFields = HASH_FIELDS.filter((k) => k !== "actorEmail");
    }
  }
  const valid = recomputedHash === record.evidenceHash;
  return { valid, recomputedHash, profile, inputFields, reason: valid ? "EVIDENCE_HASH_MATCH" : "EVIDENCE_HASH_MISMATCH" };
}
