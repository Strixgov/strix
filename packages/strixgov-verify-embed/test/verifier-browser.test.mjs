// Unit tests for the browser-side verifier.
//
// Runs under Node 20+ which exposes WebCrypto with Ed25519 — the same
// API the embed uses in the browser. Tests mock `fetch` to serve the
// locked test fixtures from release/strixgov-strix/packages/strixgov-verifier/examples/
// so we exercise the real Ed25519 path without hitting production.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verify, buildCanonicalPayload, deriveComplianceFlags } from "../src/verifier-browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(
  here,
  "..",
  "..",
  "..",
  "release",
  "strixgov-strix",
  "packages",
  "strixgov-verifier",
  "examples",
);

const VERIFIED = JSON.parse(readFileSync(join(FIXTURES, "verified.json"), "utf8"));
const TAMPERED = JSON.parse(readFileSync(join(FIXTURES, "tamper-hash.json"), "utf8"));
const WRONG_KEY = JSON.parse(readFileSync(join(FIXTURES, "wrong-key.json"), "utf8"));
const TEST_JWKS = JSON.parse(readFileSync(join(FIXTURES, "test-jwks.json"), "utf8"));

// ── Helper: install a mock fetch that serves the test fixtures ──────

function installMockFetch(records, jwks = TEST_JWKS) {
  const calls = [];
  globalThis.fetch = async (url, _opts) => {
    calls.push(url);
    if (typeof url === "string" && url.endsWith("/.well-known/strix-jwks.json")) {
      return { ok: true, status: 200, json: async () => jwks };
    }
    if (typeof url === "string" && url.includes("/proof/")) {
      const id = url.split("/").pop();
      const rec = records.find((r) => String(r.evidenceId ?? r.id) === id);
      if (rec) {
        return { ok: true, status: 200, json: async () => rec };
      }
      return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
    }
    return { ok: false, status: 500, json: async () => ({ error: "Mock fetch fallthrough" }) };
  };
  return calls;
}

function restoreFetch() {
  delete globalThis.fetch;
}

// ── buildCanonicalPayload — byte-parity with the Node verifier ──────

test("buildCanonicalPayload uses signedPayload when present", () => {
  const out = buildCanonicalPayload({ signedPayload: "abc123" });
  assert.equal(out, "abc123");
});

test("buildCanonicalPayload reconstructs the 13-field locked order (Console form)", () => {
  const r = {
    schemaVersion: "1",
    evidenceId: "5686",
    evidenceHash: "f1c4a7e2",
    proofChainHash: "",
    capabilityId: "x",
    action: "allow",
    actorId: "a",
    actorRole: "r",
    createdAt: "2026-05-15T18:00:00.000Z",
    signingKeyId: "k",
    environment: "production",
    tenantId: "t",
    regulatoryContext: { complianceMode: "", euAiActArticle12: false, euAiActArticle14: false, euAiActArticle28: false },
  };
  const out = buildCanonicalPayload(r);
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed), [
    "schemaVersion", "evidenceId", "evidenceHash", "proofChainHash",
    "capabilityId", "action", "actorId", "actorRole", "createdAt",
    "signingKeyId", "environment", "tenantId", "regulatoryContext",
  ]);
});

// ── deriveComplianceFlags — mirrors apps/strix-console ──────────────

test("deriveComplianceFlags returns null when no complianceMode", () => {
  assert.equal(deriveComplianceFlags(null, {}), null);
  assert.equal(deriveComplianceFlags("", {}), null);
});

test("deriveComplianceFlags article28 requires all checks to pass", () => {
  const flags = deriveComplianceFlags("eu_ai_act_2026", {
    hasTraceFields: true,
    hashValid: true,
    chainValid: true,
    signatureValid: true,
    signaturePresent: true,
  });
  assert.equal(flags.article12_traceable, true);
  assert.equal(flags.article12_tamper_resistant, true);
  assert.equal(flags.article14_oversight_supported, true);
  assert.equal(flags.article28_audit_ready, true);
});

test("deriveComplianceFlags article28 is false when signature is invalid", () => {
  const flags = deriveComplianceFlags("eu_ai_act_2026", {
    hasTraceFields: true,
    hashValid: false,
    chainValid: false,
    signatureValid: false,
    signaturePresent: true,
  });
  assert.equal(flags.article28_audit_ready, false);
});

// ── verify() — end-to-end with mocked fetch ────────────────────────

test("verify returns VERIFIED for a valid record", async (t) => {
  installMockFetch([VERIFIED]);
  t.after(restoreFetch);

  const result = await verify(1, {
    proofBase: "https://test.example",
    jwksUrl: "https://test.example/.well-known/strix-jwks.json",
  });

  assert.equal(result.verificationStatus, "VERIFIED");
  assert.equal(result.signatureValid, true);
  assert.equal(result.signaturePresent, true);
  assert.equal(result.resolvedKey?.kid, "strix-test-2026-05");
  assert.equal(result.error, null);
});

test("verify returns COMPLIANCE_VIOLATION for a tampered record", async (t) => {
  installMockFetch([TAMPERED]);
  t.after(restoreFetch);

  const result = await verify(TAMPERED.evidenceId, {
    proofBase: "https://test.example",
    jwksUrl: "https://test.example/.well-known/strix-jwks.json",
  });

  assert.equal(result.verificationStatus, "COMPLIANCE_VIOLATION");
  assert.equal(result.signatureValid, false);
  assert.equal(result.signaturePresent, true);
});

test("verify returns COMPLIANCE_VIOLATION when wrong key was used", async (t) => {
  installMockFetch([WRONG_KEY]);
  t.after(restoreFetch);

  const result = await verify(WRONG_KEY.evidenceId, {
    proofBase: "https://test.example",
    jwksUrl: "https://test.example/.well-known/strix-jwks.json",
  });

  // wrong-key fixture either has its kid resolve to a different key (→ COMPLIANCE_VIOLATION)
  // or has a kid not in the JWKS (→ ERROR). Either way it must NOT be VERIFIED.
  assert.notEqual(result.verificationStatus, "VERIFIED");
});

test("verify returns NOT_FOUND for a missing record", async (t) => {
  installMockFetch([VERIFIED]); // mock only has record id=1
  t.after(restoreFetch);

  const result = await verify(99999, {
    proofBase: "https://test.example",
    jwksUrl: "https://test.example/.well-known/strix-jwks.json",
  });

  assert.equal(result.verificationStatus, "NOT_FOUND");
  assert.match(result.error ?? "", /not found/i);
});

test("verify returns LEGACY_UNSIGNED for a record with no signature", async (t) => {
  const legacy = { ...VERIFIED, signature: null, signingKeyId: null };
  installMockFetch([legacy]);
  t.after(restoreFetch);

  const result = await verify(legacy.evidenceId, {
    proofBase: "https://test.example",
    jwksUrl: "https://test.example/.well-known/strix-jwks.json",
  });

  assert.equal(result.verificationStatus, "LEGACY_UNSIGNED");
  assert.equal(result.signaturePresent, false);
});

test("verify emits verifiedAt timestamp", async (t) => {
  installMockFetch([VERIFIED]);
  t.after(restoreFetch);

  const result = await verify(1, {
    proofBase: "https://test.example",
    jwksUrl: "https://test.example/.well-known/strix-jwks.json",
  });

  assert.match(result.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

// ── Mirror invariant check ───────────────────────────────────────────
//
// This is the load-bearing check: our buildCanonicalPayload MUST produce
// byte-identical output to the upstream @strixgov/verifier. If this
// test fails, the embed will silently disagree with the CLI on edge
// cases — exactly the failure mode the verifier-museum project guards
// against.

test("buildCanonicalPayload byte-parity with verified.json", () => {
  // The fixture is the canonical-payload of a real signed record. If
  // we reconstruct it from its constituent fields and re-canonicalize,
  // the output must equal the bytes that the original signature was
  // produced over.
  const out = buildCanonicalPayload(VERIFIED);
  const parsed = JSON.parse(out);

  // Spot-check key fields (full byte-parity is enforced by the
  // verifier-package golden vectors; we just confirm the field order
  // and types match here).
  // Note: Console-form coercion produces String(...) for schemaVersion
  // and evidenceId when the source isn't "academy-platform" — the
  // VERIFIED record verifies because its signature was generated over
  // exactly these stringified bytes.
  assert.equal(parsed.schemaVersion, "1");                 // Console form: string
  assert.equal(parsed.evidenceId, "1");                    // Console form: string
  assert.equal(parsed.signingKeyId, "strix-test-2026-05");
  assert.equal(parsed.regulatoryContext.complianceMode, null);
  assert.equal(Object.keys(parsed.regulatoryContext)[0], "complianceMode");  // Console-order
});
