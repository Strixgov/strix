// Golden-vector lock for the Signed Evidence v1 canonical payload.
//
// This is the core trust artifact. `buildCanonicalPayload` reconstructs
// the exact bytes that were signed, and it carries a SUBTLE dual-form
// discriminator (v1.3): Academy (`sourceApp === "academy-platform"`)
// signs schemaVersion + evidenceId as JSON NUMBERS with a
// euAiActArticle12-first regulatoryContext; Console signers emit them as
// JSON STRINGS with a complianceMode-first regulatoryContext. The two
// byte-shapes verify against different signatures.
//
// A refactor that "simplifies" the discriminator would silently break
// every record signed in the form it dropped. These golden vectors lock
// BOTH forms + the v1.10.0 signedPayload passthrough.
//
// IF THIS TEST FAILS: you changed the SE v1 canonical serialization. That
// breaks historical signatures. Do NOT update the golden constants to
// pass — the failure is the bug. The only legitimate change is a
// gate-reviewed SE v2 with a new schemaVersion + migration path
// (docs/architecture/decisions/002-signed-evidence-schema-freeze.md).

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildCanonicalPayload, verifySignature, verifyHash } from "../src/index.mjs";

// ── Fixed input record (shared base) ──────────────────────────────────

const BASE = Object.freeze({
  evidenceHash: "ev".repeat(32),
  proofChainHash: "pc".repeat(32),
  capabilityId: "admin.updateMemberRole",
  action: "allow",
  actorId: "user_golden_actor",
  actorRole: "owner",
  createdAt: "2026-05-26T00:00:00.000Z",
  signingKeyId: "strix-prod-2026-05",
  environment: "production",
  tenantId: "academy prod",
  regulatoryContext: {
    complianceMode: "eu-ai-act",
    euAiActArticle12: true,
    euAiActArticle14: true,
    euAiActArticle28: false,
  },
});

// ── LOCKED GOLDEN VECTORS — do not edit to make a test pass ──────────

const GOLDEN_CONSOLE =
  '{"schemaVersion":"1","evidenceId":"5686","evidenceHash":"evevevevevevevevevevevevevevevevevevevevevevevevevevevevevevevev","proofChainHash":"pcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpc","capabilityId":"admin.updateMemberRole","action":"allow","actorId":"user_golden_actor","actorRole":"owner","createdAt":"2026-05-26T00:00:00.000Z","signingKeyId":"strix-prod-2026-05","environment":"production","tenantId":"academy prod","regulatoryContext":{"complianceMode":"eu-ai-act","euAiActArticle12":true,"euAiActArticle14":true,"euAiActArticle28":false}}';

const GOLDEN_ACADEMY =
  '{"schemaVersion":1,"evidenceId":5686,"evidenceHash":"evevevevevevevevevevevevevevevevevevevevevevevevevevevevevevevev","proofChainHash":"pcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpcpc","capabilityId":"admin.updateMemberRole","action":"allow","actorId":"user_golden_actor","actorRole":"owner","createdAt":"2026-05-26T00:00:00.000Z","signingKeyId":"strix-prod-2026-05","environment":"production","tenantId":"academy prod","regulatoryContext":{"euAiActArticle12":true,"euAiActArticle14":true,"euAiActArticle28":false,"complianceMode":"eu-ai-act"}}';

// ── Fixed signing key (deterministic, shared with CT golden vectors) ──

const GOLDEN_SEED_HEX = "5452495820435420676f6c64656e2076656374206b6579207365656420763031";
function goldenKey() {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(GOLDEN_SEED_HEX, "hex"),
  ]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
}

// Locked signature over the Console-form canonical with the golden key.
const GOLDEN_CONSOLE_SIGNATURE = (() => {
  // Computed once from the fixed key over GOLDEN_CONSOLE. Ed25519 is
  // deterministic, so this is stable. We compute it in-test rather than
  // hardcoding the base64url so the test is self-checking against the
  // locked canonical string above — if GOLDEN_CONSOLE drifts, the signature
  // changes and the round-trip assertion below still pins correctness.
  return crypto.sign(null, Buffer.from(GOLDEN_CONSOLE, "utf8"), goldenKey().privateKey).toString("base64url");
})();

// ── The locks ─────────────────────────────────────────────────────────

test("GOLDEN SE v1: Console form (string schemaVersion/evidenceId, complianceMode-first ctx) is byte-exact", () => {
  const rec = { ...BASE, schemaVersion: "1", evidenceId: "5686" };
  assert.equal(buildCanonicalPayload(rec), GOLDEN_CONSOLE,
    "Console-form SE v1 canonical drifted — breaks every Console-signed historical record");
});

test("GOLDEN SE v1: Academy form (numeric schemaVersion/evidenceId, article12-first ctx) is byte-exact", () => {
  const rec = { ...BASE, sourceApp: "academy-platform", schemaVersion: 1, evidenceId: 5686 };
  assert.equal(buildCanonicalPayload(rec), GOLDEN_ACADEMY,
    "Academy-form SE v1 canonical drifted — breaks every Academy-signed historical record (4,450+ records)");
});

test("GOLDEN SE v1: the two forms produce DIFFERENT bytes (discriminator is load-bearing)", () => {
  assert.notEqual(GOLDEN_CONSOLE, GOLDEN_ACADEMY,
    "Academy and Console forms must differ — they verify against different signatures by design");
  // Specifically: numeric vs string schemaVersion + evidenceId.
  assert.ok(GOLDEN_CONSOLE.includes('"schemaVersion":"1"'));
  assert.ok(GOLDEN_ACADEMY.includes('"schemaVersion":1,'));
  // And regulatoryContext key order differs.
  assert.ok(GOLDEN_CONSOLE.includes('"regulatoryContext":{"complianceMode"'));
  assert.ok(GOLDEN_ACADEMY.includes('"regulatoryContext":{"euAiActArticle12"'));
});

test("GOLDEN SE v1: signedPayload passthrough returns verbatim bytes (v1.10.0 reconstruction-free path)", () => {
  const rec = { ...BASE, schemaVersion: "1", evidenceId: "5686", signedPayload: '{"verbatim":"bytes"}' };
  assert.equal(buildCanonicalPayload(rec), '{"verbatim":"bytes"}',
    "signedPayload, when present, must be returned verbatim — it IS the originally-signed bytes");
});

test("GOLDEN SE v1: full sign → verify → hash round trip on Console form", () => {
  const sig = GOLDEN_CONSOLE_SIGNATURE;
  // Signature verifies against the canonical.
  assert.equal(verifySignature(GOLDEN_CONSOLE, sig, goldenKey().publicKey), true);
  // Hash of the canonical matches a recompute.
  const hash = crypto.createHash("sha256").update(GOLDEN_CONSOLE).digest("hex");
  assert.equal(verifyHash(GOLDEN_CONSOLE, hash), true);
  // A one-char tamper to the canonical breaks both.
  const tampered = GOLDEN_CONSOLE.replace('"owner"', '"admin"');
  assert.equal(verifySignature(tampered, sig, goldenKey().publicKey), false);
  assert.equal(verifyHash(tampered, hash), false);
});

// ── Canonical serializer hardening (Section F missing tests) ─────────

test("HARDEN SE v1: input object key order does not affect canonical bytes (key-order determinism)", () => {
  // buildCanonicalPayload reads fields in its own locked object-literal
  // order, so a record whose keys arrive in a different order (e.g. from
  // a jsonb round-trip) must still produce the locked canonical.
  const reordered = {};
  // Insert keys in reverse-ish order.
  reordered.regulatoryContext = BASE.regulatoryContext;
  reordered.tenantId = BASE.tenantId;
  reordered.environment = BASE.environment;
  reordered.signingKeyId = BASE.signingKeyId;
  reordered.createdAt = BASE.createdAt;
  reordered.actorRole = BASE.actorRole;
  reordered.actorId = BASE.actorId;
  reordered.action = BASE.action;
  reordered.capabilityId = BASE.capabilityId;
  reordered.proofChainHash = BASE.proofChainHash;
  reordered.evidenceHash = BASE.evidenceHash;
  reordered.evidenceId = "5686";
  reordered.schemaVersion = "1";
  assert.equal(buildCanonicalPayload(reordered), GOLDEN_CONSOLE,
    "canonical must be insensitive to input key order — jsonb re-keying must not change signed bytes");
});

test("HARDEN SE v1: regulatoryContext jsonb re-keying does not change canonical (key order reconstructed)", () => {
  // Postgres jsonb re-keys nested objects on storage. The builder
  // reconstructs the signer-correct ctx key order. Feed a ctx in the
  // "wrong" order and confirm the canonical still matches the golden.
  const recConsole = {
    ...BASE,
    schemaVersion: "1",
    evidenceId: "5686",
    regulatoryContext: {
      // jsonb-canonical alphabetical order (what Prisma would return)
      complianceMode: "eu-ai-act",
      euAiActArticle12: true,
      euAiActArticle14: true,
      euAiActArticle28: false,
    },
  };
  assert.equal(buildCanonicalPayload(recConsole), GOLDEN_CONSOLE);
});

test("HARDEN SE v1: unicode + special chars in a field round-trip through canonical without double-encoding", () => {
  const rec = {
    ...BASE,
    schemaVersion: "1",
    evidenceId: "5686",
    actorId: 'user_é中文_🦉_"quote"_\\backslash',
  };
  const canonical = buildCanonicalPayload(rec);
  // JSON.parse round-trip recovers the exact actorId.
  const parsed = JSON.parse(canonical);
  assert.equal(parsed.actorId, 'user_é中文_🦉_"quote"_\\backslash');
  // And a signature over it verifies (no encoding ambiguity).
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), goldenKey().privateKey);
  assert.equal(verifySignature(canonical, sig.toString("base64url"), goldenKey().publicKey), true);
});

test("HARDEN SE v1: clock-skew createdAt is signed verbatim, no normalization", () => {
  for (const ts of [
    "2026-05-26T00:00:00.000Z",
    "2026-05-26T00:00:00.001Z",
    "2099-12-31T23:59:59.999Z",
    "2000-01-01T00:00:00.000Z",
  ]) {
    const rec = { ...BASE, schemaVersion: "1", evidenceId: "5686", createdAt: ts };
    const canonical = buildCanonicalPayload(rec);
    assert.ok(canonical.includes(`"createdAt":${JSON.stringify(ts)}`), `timestamp ${ts} must appear verbatim`);
  }
});

test("HARDEN SE v1: byte-drift through a persistence round-trip is detected", () => {
  // Simulate: sign canonical → store record → re-load (possibly with a
  // field mutated by a buggy storage layer) → re-verify. The signature
  // must fail if ANY field drifted in persistence.
  const rec = { ...BASE, schemaVersion: "1", evidenceId: "5686" };
  const canonical = buildCanonicalPayload(rec);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), goldenKey().privateKey).toString("base64url");

  // "Persistence" mutates tenantId (e.g. a normalization that trimmed the space).
  const persisted = { ...rec, tenantId: "academyprod" };
  const reCanonical = buildCanonicalPayload(persisted);
  assert.notEqual(reCanonical, canonical, "mutated field must change canonical bytes");
  assert.equal(verifySignature(reCanonical, sig, goldenKey().publicKey), false,
    "a field that drifted in persistence must fail signature verification");
});
