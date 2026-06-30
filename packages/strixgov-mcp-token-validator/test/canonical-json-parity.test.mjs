/**
 * Canonical-JSON parity — the vendored SCJ v1 implementation must be
 * byte-identical to `solo-builder-core/src/canonical-json.ts` and
 * `@strixgov/verifier`. Any drift here is a CJ-1 invariant violation.
 *
 * The validator's whole purpose is to verify signatures whose canonical
 * bytes were produced by a different process (mcp-adapter's signer).
 * If our canonicalizer diverges by a single byte, every signature
 * silently fails verification.
 *
 * This test asserts byte-equality against locked golden vectors
 * inline. The vectors are intentionally minimal — full SCJ v1
 * conformance is owned by `solo-builder-core/tests/canonical-json.test.mjs`
 * (108 tests + the locked vectors.sha256.lock); this file pins the
 * subset relevant to authorization-token canonicalization.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeJSON, sha256OfJSON } from "../src/canonical-json.mjs";

const LOCKED_VECTORS = [
  // primitives
  { name: "null", input: null, canonical: "null" },
  { name: "true", input: true, canonical: "true" },
  { name: "false", input: false, canonical: "false" },
  { name: "integer", input: 42, canonical: "42" },
  { name: "negative integer", input: -7, canonical: "-7" },
  { name: "empty string", input: "", canonical: '""' },
  { name: "ascii string", input: "hello", canonical: '"hello"' },

  // arrays preserve order
  { name: "array of ints", input: [3, 1, 2], canonical: "[3,1,2]" },
  { name: "empty array", input: [], canonical: "[]" },

  // objects byte-sort keys
  { name: "object sorted keys", input: { b: 1, a: 2 }, canonical: '{"a":2,"b":1}' },
  { name: "empty object", input: {}, canonical: "{}" },

  // nested
  {
    name: "nested object",
    input: { z: { y: 1, x: 2 }, a: [3, 1, 2] },
    canonical: '{"a":[3,1,2],"z":{"x":2,"y":1}}',
  },

  // realistic authorization-payload shape
  {
    name: "authorization-shape payload",
    input: {
      schemaVersion: 1,
      authorizationId: "exa_abc",
      decisionId: "dec_xyz",
      capabilityId: "mcp.notion.update_page",
      actorId: "agent-1",
      actorClass: "agent",
      payloadHash: "sha256:0000",
      tenantId: "acme",
      environment: "prod",
      nonce: "AAAA",
      issuedAt: "2026-05-23T12:00:00Z",
      expiresAt: "2026-05-23T12:05:00Z",
    },
    canonical:
      '{"actorClass":"agent","actorId":"agent-1","authorizationId":"exa_abc","capabilityId":"mcp.notion.update_page","decisionId":"dec_xyz","environment":"prod","expiresAt":"2026-05-23T12:05:00Z","issuedAt":"2026-05-23T12:00:00Z","nonce":"AAAA","payloadHash":"sha256:0000","schemaVersion":1,"tenantId":"acme"}',
  },
];

for (const vec of LOCKED_VECTORS) {
  test(`SCJ v1 vector: ${vec.name}`, () => {
    const got = canonicalizeJSON(vec.input);
    assert.equal(got, vec.canonical);
  });
}

test("sha256OfJSON produces sha256:<hex> with the expected prefix", () => {
  const hash = sha256OfJSON({ a: 1 });
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
});

test("byte-sorting is UTF-16 code-unit order (matches Array.sort default)", () => {
  // Keys "Z" (0x5A) < "a" (0x61) under UTF-16 ordering. SCJ v1 §1.
  const got = canonicalizeJSON({ a: 1, Z: 2 });
  assert.equal(got, '{"Z":2,"a":1}');
});

test("rejects undefined values", () => {
  assert.throws(() => canonicalizeJSON({ a: undefined }), /CANONICAL_JSON_UNDEFINED_FIELD/);
});

test("rejects NaN / Infinity", () => {
  assert.throws(() => canonicalizeJSON(NaN), /CANONICAL_JSON_NON_FINITE_NUMBER/);
  assert.throws(() => canonicalizeJSON(Infinity), /CANONICAL_JSON_NON_FINITE_NUMBER/);
});

test("rejects -0", () => {
  assert.throws(() => canonicalizeJSON(-0), /CANONICAL_JSON_NEGATIVE_ZERO/);
});

test("rejects bigint / function / symbol", () => {
  assert.throws(() => canonicalizeJSON(1n), /CANONICAL_JSON_INVALID_TYPE/);
  assert.throws(() => canonicalizeJSON(() => 1), /CANONICAL_JSON_INVALID_TYPE/);
  assert.throws(() => canonicalizeJSON(Symbol("x")), /CANONICAL_JSON_INVALID_TYPE/);
});

test("rejects non-plain objects (Date, Map, etc.)", () => {
  assert.throws(() => canonicalizeJSON(new Date()), /CANONICAL_JSON_INVALID_TYPE/);
  assert.throws(() => canonicalizeJSON(new Map()), /CANONICAL_JSON_INVALID_TYPE/);
});
