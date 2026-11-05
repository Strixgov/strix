// #2710: real HTTP + Ed25519 + subprocess CLI. No server verdict is trusted.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildCanonicalPayload, verify } from "../src/index.mjs";

const run = promisify(execFile);
const cli = new URL("../bin/verify.mjs", import.meta.url).pathname;
const kp = crypto.generateKeyPairSync("ed25519");
const kid = "strix-test-2026-11";
const jwk = { ...kp.publicKey.export({ format: "jwk" }), kid };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function fixture() {
  const record = {
    sourceApp: "academy-platform", schemaVersion: 1, evidenceId: 2710,
    capabilityId: "test.refund", action: "deny", decision: "deny",
    actorId: "test-actor", actorRole: "admin", actorEmail: null,
    actor: { id: "test-actor", role: "admin" },
    reason: "standing_invalid", source: "trpc",
    createdAt: "2026-11-04T12:00:00.001Z",
    hashedAt: "2026-11-04T12:00:00.000Z",
    proofChainHash: "ab".repeat(32), signingKeyId: kid,
    environment: "test", tenantId: "fixture",
    regulatoryContext: { euAiActArticle12: true, euAiActArticle14: true, euAiActArticle28: true, complianceMode: null },
  };
  record.evidenceHash = sha(JSON.stringify({
    capabilityId: record.capabilityId, actorId: record.actorId,
    actorRole: record.actorRole, actorEmail: record.actorEmail,
    action: record.action, reason: record.reason, source: record.source,
    timestamp: record.hashedAt,
  }));
  record.signedPayload = buildCanonicalPayload({ ...record, createdAt: record.hashedAt });
  record.signature = crypto.sign(null, Buffer.from(record.signedPayload), kp.privateKey).toString("base64url");
  return record;
}

async function serve(t, record, { keys = [jwk], consoleShape = false } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url.startsWith("/.well-known/") ? { keys }
      : consoleShape ? { fields: record, signature: record.signature, signingKeyId: "strix-***-2026-11", evidenceId: "lookup-hash" }
      : { ok: true, proof: record, verification: {
        hashMatch: true, recomputedHash: record.evidenceHash,
        // An attacker cannot choose a smaller hash field list.
        hashInputFields: ["action"], signatureVerification: { state: "VERIFIED" },
      } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { proofBase: base, jwksBase: base };
}

async function output(options, json = false) {
  try {
    const r = await run(process.execPath, [cli, "2710", "--proof-base", options.proofBase, "--jwks-base", options.jwksBase, ...(json ? ["--json"] : [])]);
    return { code: 0, stdout: r.stdout.replace(/\x1b\[[0-9;]*m/g, "") };
  } catch (err) {
    return { code: err.code, stdout: err.stdout.replace(/\x1b\[[0-9;]*m/g, "") };
  }
}

test("untampered Academy: genuine content hash, signed timestamp display, no chain claim", async (t) => {
  const record = fixture();
  const opts = await serve(t, record);
  const r = await verify(2710, opts);
  assert.equal(r.verificationStatus, "VERIFIED");
  assert.equal(r.hashValid, true);
  assert.equal(r.recomputedEvidenceHash, record.evidenceHash);
  assert.equal(r.signatureValid, true);
  assert.deepEqual(r.fieldMismatches, []);
  assert.equal(r.chainValid, null);
  assert.equal(r.verificationScope, "SIGNED_ENVELOPE_AND_EVIDENCE_CONTENT");
  const human = await output(opts);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /Created:\s+2026-11-04T12:00:00.000Z/);
  assert.doesNotMatch(human.stdout, /2026-11-04T12:00:00.001Z/);
  assert.match(human.stdout, /Chain continuity not checked/);
});

for (const [field, value] of [
  ["action", "allow"], ["capabilityId", "other.action"], ["actorId", "other-actor"],
  ["actorRole", "owner"], ["environment", "production"], ["tenantId", "other-tenant"],
  ["evidenceId", 999], ["schemaVersion", 2], ["evidenceHash", "ff".repeat(32)],
  ["proofChainHash", "ef".repeat(32)], ["hashedAt", "2026-11-04T13:00:00.000Z"],
  ["decision", "allow"], ["regulatoryContext", {}],
]) {
  test(`top-level ${field} tamper cannot preserve VERIFIED`, async (t) => {
    const record = { ...fixture(), [field]: value };
    const r = await verify(2710, await serve(t, record));
    assert.equal(r.signatureValid, true);
    assert.equal(r.verificationStatus, "COMPLIANCE_VIOLATION");
    assert.equal(r.verificationReason, "FIELD_MISMATCH");
    assert.ok(r.fieldMismatches.includes(field));
    assert.notEqual(r.authenticatedRecord[field], value);
  });
}

test("nested actor and signing key mismatches refuse; tampered signing kid cannot validate", async (t) => {
  const record = fixture();
  record.actor.id = "forged";
  record.signingKeyId = "alias-key";
  const r = await verify(2710, await serve(t, record, { keys: [{ ...jwk, kid: "alias-key" }] }));
  assert.equal(r.signatureValid, true);
  assert.equal(r.verificationReason, "FIELD_MISMATCH");
  assert.ok(r.fieldMismatches.includes("actor.id"));
  assert.ok(r.fieldMismatches.includes("signingKeyId"));
});

test("#2710 exact attack: CLI shows signed deny, hash false, FIELD_MISMATCH, exit 1", async (t) => {
  const record = { ...fixture(), action: "allow" };
  const opts = await serve(t, record);
  const human = await output(opts);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /Action:\s+deny/);
  assert.doesNotMatch(human.stdout, /Action:\s+allow/);
  assert.match(human.stdout, /Hash valid:\s+false/);
  assert.match(human.stdout, /Signature valid:\s+true/);
  assert.match(human.stdout, /FIELD_MISMATCH/);
  const json = await output(opts, true);
  assert.equal(json.code, 1);
  const r = JSON.parse(json.stdout);
  assert.equal(r.hashValid, false);
  assert.equal(r.authenticatedRecord.action, "deny");
});

for (const field of ["reason", "source", "actorEmail"]) {
  test(`content-only ${field} tamper fails independently despite server hashMatch=true`, async (t) => {
    const record = { ...fixture(), [field]: "tampered" };
    const r = await verify(2710, await serve(t, record));
    assert.equal(r.signatureValid, true);
    assert.equal(r.hashValid, false);
    assert.equal(r.verificationReason, "EVIDENCE_HASH_MISMATCH");
    assert.equal(r.verificationStatus, "COMPLIANCE_VIOLATION");
  });
}

test("signed-payload tamper fails crypto and exposes no authenticated summary", async (t) => {
  const record = fixture();
  record.signedPayload = record.signedPayload.replace('"deny"', '"allow"');
  const opts = await serve(t, record);
  const r = await verify(2710, opts);
  assert.equal(r.signatureValid, false);
  assert.equal(r.verificationReason, "SIGNATURE_INVALID");
  assert.equal(r.authenticatedRecord, null);
  const human = await output(opts);
  assert.equal(human.code, 1);
  assert.doesNotMatch(human.stdout, /Action:/);
});

for (const bytes of ['{"arbitrary":true}', 'null', '{"schemaVersion":2}', 'not-json']) {
  test(`malformed or unsupported signed payload refuses: ${bytes}`, async (t) => {
    const record = fixture();
    record.signedPayload = bytes;
    record.signature = crypto.sign(null, Buffer.from(bytes), kp.privateKey).toString("base64url");
    const r = await verify(2710, await serve(t, record));
    assert.equal(r.verificationReason, "SIGNED_PAYLOAD_INVALID");
    assert.equal(r.authenticatedRecord, null);
  });
}

test("unknown key and unsupported algorithm remain explicit; hash is separate", async (t) => {
  const record = fixture();
  const r = await verify(2710, await serve(t, record, { keys: [] }));
  assert.equal(r.verificationStatus, "UNVERIFIABLE");
  assert.equal(r.verificationReason, "SIGNING_KEY_UNKNOWN");
  assert.equal(r.hashValid, true);
  assert.equal(r.authenticatedRecord, null);
  record.signatureAlgorithm = "HS256";
  const bad = await verify(2710, await serve(t, record));
  assert.equal(bad.verificationReason, "UNSUPPORTED_ALGORITHM");
});

test("wrong key under the correct kid fails crypto, not the independent hash", async (t) => {
  const other = crypto.generateKeyPairSync("ed25519");
  const r = await verify(2710, await serve(t, fixture(), {
    keys: [{ ...other.publicKey.export({ format: "jwk" }), kid }],
  }));
  assert.equal(r.hashValid, true);
  assert.equal(r.signatureValid, false);
  assert.equal(r.verificationReason, "SIGNATURE_INVALID");
  assert.equal(r.authenticatedRecord, null);
});

test("legacy seven-field writer is identified explicitly, never chosen by server flags", async (t) => {
  const record = { ...fixture(), source: "ai", actorRole: "ai_agent" };
  record.actor.role = record.actorRole;
  record.evidenceHash = sha(JSON.stringify({ capabilityId: record.capabilityId,
    actorId: record.actorId, actorRole: record.actorRole, action: record.action,
    reason: record.reason, source: record.source, timestamp: record.hashedAt }));
  delete record.signedPayload;
  record.signedPayload = buildCanonicalPayload({ ...record, createdAt: record.hashedAt });
  record.signature = crypto.sign(null, Buffer.from(record.signedPayload), kp.privateKey).toString("base64url");
  const r = await verify(2710, await serve(t, record));
  assert.equal(r.verificationStatus, "VERIFIED");
  assert.equal(r.hashValid, true);
  assert.equal(r.hashProfile, "academy_legacy_ai_7field_v0");
  assert.ok(!r.hashInputFields.includes("actorEmail"));
});

test("missing hash inputs report not checked, never signature-as-hash success", async (t) => {
  const record = fixture();
  delete record.source;
  const opts = await serve(t, record);
  const r = await verify(2710, opts);
  assert.equal(r.signatureValid, true);
  assert.equal(r.hashValid, null);
  assert.equal(r.hashReason, "EVIDENCE_HASH_INPUTS_MISSING");
  assert.equal(r.verificationScope, "SIGNED_ENVELOPE_ONLY");
  const human = await output(opts);
  assert.match(human.stdout, /Hash valid:\s+not checked/);
  assert.match(human.stdout, /envelope authenticity only/);
});

test("Console fields shape keeps full kid and canonical identity; unsupported hash profile is explicit", async (t) => {
  const record = { ...fixture(), sourceApp: "strix-console", schemaVersion: "1", evidenceId: "2710" };
  delete record.signedPayload;
  delete record.hashedAt;
  record.signedPayload = buildCanonicalPayload(record);
  record.signature = crypto.sign(null, Buffer.from(record.signedPayload), kp.privateKey).toString("base64url");
  const r = await verify(2710, await serve(t, record, { consoleShape: true }));
  assert.equal(r.verificationStatus, "VERIFIED");
  assert.equal(r.authenticatedRecord.signingKeyId, kid);
  assert.equal(r.authenticatedRecord.evidenceId, "2710");
  assert.equal(r.hashValid, null);
  assert.equal(r.hashReason, "UNSUPPORTED_HASH_PROFILE");
});
