/**
 * E1.5 — Verifier 1.3.0 attestation support: structural + behavioral tests.
 *
 * Run with: node --test test/attestations-e1-5.test.mjs
 *
 * Validates:
 *   - INV-ATT-5: verify(id) without options is unchanged (no attestation
 *     fetching, identical shape to v1.0.x)
 *   - buildActorAttestationPayload is deterministic + locked field order
 *   - verifyAttestation handles HASH_MISMATCH / UNSIGNED / SIGNATURE_INVALID
 *   - computeAttestationCompositeStatus follows §6a state machine
 *   - INV-ATT-3 documented in source
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildActorAttestationPayload,
  verifyAttestation,
  computeAttestationCompositeStatus,
  verifyWithAttestations,
} from "../src/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_PATH = path.resolve(__dirname, "../src/index.mjs");
const PKG_PATH = path.resolve(__dirname, "../package.json");
const BIN_PATH = path.resolve(__dirname, "../bin/verify.mjs");

// ============================================================================
// 1. Package metadata
// ============================================================================

describe("package version", () => {
  test("@strixgov/verifier bumped to 1.3.0 (or higher) for attestation support", () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
    const [major, minor] = pkg.version.split(".").map(Number);
    assert.ok(
      major > 1 || (major === 1 && minor >= 3),
      `Expected version >= 1.3.0, got ${pkg.version}`,
    );
  });
});

// ============================================================================
// 2. INV-ATT-5: backward compat
// ============================================================================

describe("INV-ATT-5: backward compatibility", () => {
  test("source documents INV-ATT-5 explicitly", () => {
    const src = fs.readFileSync(SRC_PATH, "utf-8");
    assert.match(src, /INV-ATT-5/);
    assert.match(src, /backward compat/i);
  });

  test("verifyWithAttestations returns base verify() result when includeAttestations is falsy", async () => {
    // Use a non-existent evidence ID — the verify() call will fail to fetch
    // and return a result with verificationStatus: "ERROR". The point is
    // that verifyWithAttestations does NOT add attestations/compositeStatus
    // keys when the option is not set.
    const result = await verifyWithAttestations(99999999, {
      proofBase: "https://invalid.invalid",
      jwksBase: "https://invalid.invalid",
      // NOTE: includeAttestations omitted
    });
    assert.equal(typeof result.verificationStatus, "string");
    assert.ok(
      !("attestations" in result),
      "INV-ATT-5: legacy callers must NOT receive an attestations field",
    );
    assert.ok(
      !("compositeStatus" in result),
      "INV-ATT-5: legacy callers must NOT receive a compositeStatus field",
    );
  });
});

// ============================================================================
// 3. Canonical ACTOR payload
// ============================================================================

describe("buildActorAttestationPayload: locked field order", () => {
  test("emits §2a fields in exact locked order", () => {
    const json = buildActorAttestationPayload({
      attestationId: "11111111-1111-1111-1111-111111111111",
      evidenceId: "42",
      schemaVersion: 1,
      actorType: "human",
      actorId: "user_clerk_abc",
      actorRole: "admin",
      onBehalfOf: null,
      agentId: null,
      signingKeyId: "strix-test-2026-04",
      environment: "test",
      tenantId: "academy",
      createdAt: "2026-04-30T15:00:00.000Z",
    });

    // Byte-for-byte determinism — any reorder breaks downstream signatures.
    assert.equal(
      json,
      '{"schemaVersion":"1",' +
        '"attestationId":"11111111-1111-1111-1111-111111111111",' +
        '"evidenceId":"42",' +
        '"attestationType":"ACTOR",' +
        '"actorType":"human",' +
        '"actorId":"user_clerk_abc",' +
        '"actorRole":"admin",' +
        '"onBehalfOf":null,' +
        '"agentId":null,' +
        '"signingKeyId":"strix-test-2026-04",' +
        '"environment":"test",' +
        '"tenantId":"academy",' +
        '"createdAt":"2026-04-30T15:00:00.000Z"}',
    );
  });

  test("nullable fields appear as null when undefined (never omitted)", () => {
    const json = buildActorAttestationPayload({
      attestationId: "x",
      evidenceId: "1",
      schemaVersion: 1,
      actorType: "agent",
      actorId: "system:ai",
      actorRole: "ai_agent",
      // onBehalfOf undefined
      // agentId undefined
      signingKeyId: "k",
      environment: "test",
      tenantId: "t",
      createdAt: "2026-04-30T15:00:00.000Z",
    });
    assert.match(json, /"onBehalfOf":null/);
    assert.match(json, /"agentId":null/);
  });

  test("attestationType is always ACTOR (forced)", () => {
    const json = buildActorAttestationPayload({
      attestationId: "x",
      evidenceId: "1",
      schemaVersion: 1,
      actorType: "human",
      actorId: "u",
      actorRole: "r",
      // attempt to override — must be ignored
      attestationType: "APPROVAL",
      signingKeyId: "k",
      environment: "test",
      tenantId: "t",
      createdAt: "2026-04-30T15:00:00.000Z",
    });
    assert.match(json, /"attestationType":"ACTOR"/);
  });
});

// ============================================================================
// 4. verifyAttestation states
// ============================================================================

describe("verifyAttestation: state classification", () => {
  test("HASH_MISMATCH when canonicalPayloadHash mismatches", async () => {
    const result = await verifyAttestation({
      attestationId: "x",
      attestationType: "ACTOR",
      canonicalPayload: '{"schemaVersion":"1"}',
      canonicalPayloadHash: "0".repeat(64), // wrong hash
      signature: null,
      signingKeyId: null,
    });
    assert.equal(result.verificationStatus, "HASH_MISMATCH");
    assert.equal(result.hashValid, false);
  });

  test("UNSIGNED when hash valid but signature absent", async () => {
    // Compute a real hash to pass the hash check
    const { createHash } = await import("node:crypto");
    const payload = '{"schemaVersion":"1"}';
    const hash = createHash("sha256").update(payload).digest("hex");
    const result = await verifyAttestation({
      attestationId: "x",
      attestationType: "ACTOR",
      canonicalPayload: payload,
      canonicalPayloadHash: hash,
      signature: null,
      signingKeyId: "any-key",
    });
    assert.equal(result.verificationStatus, "UNSIGNED");
    assert.equal(result.hashValid, true);
    assert.equal(result.signatureValid, false);
  });

  test("SIGNATURE_INVALID when signature present but no signingKeyId", async () => {
    const { createHash } = await import("node:crypto");
    const payload = '{"schemaVersion":"1"}';
    const hash = createHash("sha256").update(payload).digest("hex");
    const result = await verifyAttestation({
      attestationId: "x",
      attestationType: "ACTOR",
      canonicalPayload: payload,
      canonicalPayloadHash: hash,
      signature: "fake-signature-bytes",
      signingKeyId: null,
    });
    assert.equal(result.verificationStatus, "SIGNATURE_INVALID");
  });

  test("ERROR when canonicalPayload missing", async () => {
    const result = await verifyAttestation({
      attestationId: "x",
      attestationType: "ACTOR",
      canonicalPayload: "",
      canonicalPayloadHash: "abc",
      signature: "sig",
      signingKeyId: "k",
    });
    assert.equal(result.verificationStatus, "ERROR");
  });
});

// ============================================================================
// 5. composite status state machine (§6a)
// ============================================================================

describe("computeAttestationCompositeStatus: §6a state machine", () => {
  test("base !== VERIFIED → EVIDENCE_FAILED (short-circuit)", () => {
    const status = computeAttestationCompositeStatus("LEGACY_UNSIGNED", [
      { verificationStatus: "VERIFIED" },
    ]);
    assert.equal(status, "EVIDENCE_FAILED");
  });

  test("base VERIFIED + no attestations → EVIDENCE_VERIFIED", () => {
    assert.equal(
      computeAttestationCompositeStatus("VERIFIED", []),
      "EVIDENCE_VERIFIED",
    );
    assert.equal(
      computeAttestationCompositeStatus("VERIFIED", null),
      "EVIDENCE_VERIFIED",
    );
  });

  test("base VERIFIED + all VERIFIED → FULLY_VERIFIED", () => {
    const status = computeAttestationCompositeStatus("VERIFIED", [
      { verificationStatus: "VERIFIED" },
      { verificationStatus: "VERIFIED" },
    ]);
    assert.equal(status, "FULLY_VERIFIED");
  });

  test("any SIGNATURE_INVALID → ATTESTATION_INVALID", () => {
    const status = computeAttestationCompositeStatus("VERIFIED", [
      { verificationStatus: "VERIFIED" },
      { verificationStatus: "SIGNATURE_INVALID" },
    ]);
    assert.equal(status, "ATTESTATION_INVALID");
  });

  test("any HASH_MISMATCH → ATTESTATION_INVALID", () => {
    const status = computeAttestationCompositeStatus("VERIFIED", [
      { verificationStatus: "HASH_MISMATCH" },
    ]);
    assert.equal(status, "ATTESTATION_INVALID");
  });

  test("any UNSIGNED → PARTIAL", () => {
    const status = computeAttestationCompositeStatus("VERIFIED", [
      { verificationStatus: "VERIFIED" },
      { verificationStatus: "UNSIGNED" },
    ]);
    assert.equal(status, "PARTIAL");
  });

  test("any MISSING → PARTIAL", () => {
    const status = computeAttestationCompositeStatus("VERIFIED", [
      { verificationStatus: "MISSING" },
    ]);
    assert.equal(status, "PARTIAL");
  });

  test("any ERROR → PARTIAL", () => {
    const status = computeAttestationCompositeStatus("VERIFIED", [
      { verificationStatus: "VERIFIED" },
      { verificationStatus: "ERROR" },
    ]);
    assert.equal(status, "PARTIAL");
  });

  test("ATTESTATION_INVALID has priority over PARTIAL", () => {
    const status = computeAttestationCompositeStatus("VERIFIED", [
      { verificationStatus: "UNSIGNED" },
      { verificationStatus: "SIGNATURE_INVALID" },
    ]);
    assert.equal(status, "ATTESTATION_INVALID");
  });
});

// ============================================================================
// 6. INV-ATT-3 documentation
// ============================================================================

describe("INV-ATT-3 (non-authority) documented in source", () => {
  test("source mentions INV-ATT-3 explicitly", () => {
    const src = fs.readFileSync(SRC_PATH, "utf-8");
    assert.match(src, /INV-ATT-3/);
    assert.match(src, /non-authority/i);
  });

  test("source mentions MUST NOT be used as authorization signal", () => {
    const src = fs.readFileSync(SRC_PATH, "utf-8");
    assert.match(src, /MUST NOT be used as.*authoriz/is);
  });
});

// ============================================================================
// 7. CLI flag wiring
// ============================================================================

describe("CLI: --include-attestations flag", () => {
  test("CLI imports verifyWithAttestations", () => {
    const src = fs.readFileSync(BIN_PATH, "utf-8");
    assert.match(src, /verifyWithAttestations/);
  });

  test("CLI parses --include-attestations argument", () => {
    const src = fs.readFileSync(BIN_PATH, "utf-8");
    assert.match(src, /--include-attestations/);
  });

  test("CLI parses --verify-base argument", () => {
    const src = fs.readFileSync(BIN_PATH, "utf-8");
    assert.match(src, /--verify-base/);
  });

  test("CLI help text documents new flags", () => {
    const src = fs.readFileSync(BIN_PATH, "utf-8");
    assert.match(src, /--include-attestations.*Fetch \+ verify linked attestations/);
  });
});
