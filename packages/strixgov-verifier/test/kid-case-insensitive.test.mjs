/**
 * Regression test for the uppercase-kid resolution bug (issue #1306).
 *
 * Bug summary:
 *   A historical signer-config defect minted production records under an
 *   uppercase env segment in the kid ("strix-PROD-2026-05") instead of the
 *   canonical lowercase ("strix-prod-2026-05"). The JWKS endpoint only ever
 *   advertises the lowercase kid, so the verifier's first-match resolver
 *   (`resolveJwksByKid`) returned zero candidates → "Key not found in JWKS"
 *   → UNVERIFIABLE for ~727 otherwise-valid records.
 *
 *   The kid casing never enters the signed canonical payload — it only
 *   selects WHICH public key to try. Resolving "strix-PROD-2026-05" against a
 *   JWKS that advertises "strix-prod-2026-05" tries the same key bytes and is
 *   signature-equivalent. The runtime resolver
 *   (apps/strix-console/src/lib/signing.ts getPublicKeyJwks) already matched
 *   kids case-insensitively; this brings the verifier into parity.
 *
 * This test does not touch the network. It calls resolveJwksByKid directly.
 *
 * If a future change drops the case-insensitive fallback, this test fails.
 *
 * v1.17.0 refinement (issue #1628): resolution now UNIONS exact + case-variant
 * candidates rather than short-circuiting on the first exact match, so a
 * wrong-but-exact JWKS entry cannot shadow a correct case-variant key. Exact
 * matches are still tried first.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { resolveJwksByKid } from "../src/index.mjs";

// Canonical lowercase kid as advertised by the JWKS endpoint.
const JWKS = {
  keys: [
    {
      kty: "OKP",
      crv: "Ed25519",
      x: "f-3EhLmVCOLUWEGP8F3j3Yl8BdXCZMa5Pvf4uQYpkmo",
      kid: "strix-prod-2026-05",
      use: "sig",
      alg: "EdDSA",
      key_ops: ["verify"],
    },
  ],
};

describe("resolveJwksByKid — case-insensitive kid fallback (#1306)", () => {
  test("exact lowercase kid resolves (unchanged behavior)", () => {
    const m = resolveJwksByKid("strix-prod-2026-05", JWKS);
    assert.equal(m.length, 1);
    assert.equal(m[0].kid, "strix-prod-2026-05");
  });

  test("uppercase env segment resolves to the lowercase JWKS key", () => {
    const m = resolveJwksByKid("strix-PROD-2026-05", JWKS);
    assert.equal(m.length, 1, "uppercase kid must resolve, not 404");
    assert.equal(m[0].kid, "strix-prod-2026-05");
    assert.equal(m[0].x, "f-3EhLmVCOLUWEGP8F3j3Yl8BdXCZMa5Pvf4uQYpkmo");
  });

  test("mixed-case kid resolves", () => {
    const m = resolveJwksByKid("Strix-Prod-2026-05", JWKS);
    assert.equal(m.length, 1);
    assert.equal(m[0].kid, "strix-prod-2026-05");
  });

  test("exact match is preferred FIRST but case-variants are also returned (union, v1.17.0)", () => {
    // Both casings present. Pre-1.17.0 this short-circuited on the exact match
    // and returned ONLY "BBB". As of 1.17.0 the resolver unions exact +
    // case-variant candidates so a wrong-but-exact entry can't shadow the
    // correct case-variant (issue #1628). Exact stays first (preferred), the
    // case-variant is appended.
    const jwks = {
      keys: [
        { ...JWKS.keys[0], kid: "strix-prod-2026-05", x: "AAA" },
        { ...JWKS.keys[0], kid: "strix-PROD-2026-05", x: "BBB" },
      ],
    };
    const m = resolveJwksByKid("strix-PROD-2026-05", jwks);
    assert.equal(m.length, 2, "union returns both the exact and the case-variant key");
    assert.equal(m[0].x, "BBB", "exact match is tried first");
    assert.equal(m[1].x, "AAA", "the case-variant is appended, not dropped");
  });

  test("wrong-but-exact kid does NOT shadow the correct case-variant (issue #1628)", () => {
    // The production failure: the JWKS served a WRONG key under the exact
    // (uppercase) kid the record carried AND the CORRECT key under the
    // canonical lowercase kid. Pre-1.17.0 the exact-first short-circuit
    // returned only the wrong key → SIGNATURE_INVALID even though the correct
    // key was served. The union MUST include the correct lowercase key so the
    // verifier can accept on it.
    const jwks = {
      keys: [
        // wrong key, exact-cased to the record's kid
        { ...JWKS.keys[0], kid: "strix-PROD-2026-05", x: "WRONG" },
        // correct signer key, canonical lowercase kid
        {
          ...JWKS.keys[0],
          kid: "strix-prod-2026-05",
          x: "awOoXq8mWFYM2hz6acwlOPvazXvpzKLoR4BYdP-MuLY",
        },
      ],
    };
    const m = resolveJwksByKid("strix-PROD-2026-05", jwks);
    const xs = m.map((k) => k.x);
    assert.ok(
      xs.includes("awOoXq8mWFYM2hz6acwlOPvazXvpzKLoR4BYdP-MuLY"),
      "the correct case-variant key must be among the candidates, not shadowed",
    );
    assert.equal(m[0].x, "WRONG", "exact match is still tried first");
  });

  test("a genuinely absent kid still resolves to nothing", () => {
    const m = resolveJwksByKid("strix-prod-2026-09", JWKS);
    assert.equal(m.length, 0);
  });

  test("redacted form is unaffected (matched by suffix, no case in digits)", () => {
    const m = resolveJwksByKid("strix-***-2026-05", JWKS);
    assert.equal(m.length, 1);
    assert.equal(m[0].kid, "strix-prod-2026-05");
  });

  test("kid collision: case-insensitive fallback returns all candidates", () => {
    // Phase-2 closure scenario (Academy retired key + active key share a kid),
    // but the record carries the uppercase variant. Both must be tried.
    const jwks = {
      keys: [
        { ...JWKS.keys[0], kid: "strix-prod-2026-05", x: "AAA" },
        { ...JWKS.keys[0], kid: "strix-prod-2026-05", x: "BBB" },
      ],
    };
    const m = resolveJwksByKid("strix-PROD-2026-05", jwks);
    assert.equal(m.length, 2, "both collision candidates must be returned");
  });
});
