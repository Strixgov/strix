// JS side of the cross-language conformance contract.
//
// Both the JS reference verifier (here) and the Python verifier
// (python/strix-verify/tests/test_conformance_vectors.py) read the SAME
// fixture (fixtures/se-v1-conformance-vectors.json) and must agree on every
// vector. This is what makes "two independent implementations verify the same
// signed evidence against the same contract" a tested claim, not a slogan.
//
// The fixture is generated from this verifier (fixtures/generate.mjs) and is
// transitively locked by se-v1-golden-vectors.test.mjs — so if the canonical
// serialization drifts, that golden test fails first. This test then proves
// the published fixture matches the live builder + verifier.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildCanonicalPayload, verifySignature, verifyHash } from "../src/index.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dir, "fixtures", "se-v1-conformance-vectors.json"), "utf8"),
);
const publicKey = crypto.createPublicKey({ key: fixture.publicJwk, format: "jwk" });

for (const v of fixture.vectors) {
  test(`CONFORMANCE [${v.name}]: JS builder reproduces fixture canonical bytes`, () => {
    assert.equal(buildCanonicalPayload(v.inputRecord), v.expectedCanonical);
  });

  test(`CONFORMANCE [${v.name}]: sha256 matches fixture`, () => {
    const digest = crypto.createHash("sha256").update(v.expectedCanonical).digest("hex");
    assert.equal(digest, v.expectedSha256);
  });

  test(`CONFORMANCE [${v.name}]: signature verifies + hash checks`, () => {
    assert.equal(verifySignature(v.expectedCanonical, v.signatureB64url, publicKey), true);
    assert.equal(verifyHash(v.expectedCanonical, v.expectedSha256), true);
    // One-byte tamper must fail both.
    const tampered = v.expectedCanonical.includes("owner")
      ? v.expectedCanonical.replace("owner", "admin")
      : v.expectedCanonical + " ";
    assert.equal(verifySignature(tampered, v.signatureB64url, publicKey), false);
  });
}

test("CONFORMANCE: dual-form discriminator is load-bearing (forms differ)", () => {
  const byName = Object.fromEntries(fixture.vectors.map((v) => [v.name, v]));
  assert.notEqual(byName["console-form"].expectedCanonical, byName["academy-form"].expectedCanonical);
});
