/**
 * MC-1 SCITT Signed Statement (COSE_Sign1) golden-vector conformance for the
 * published @strixgov/verifier COSE path.
 *
 * The verifier here is a THIRD independent implementation over the same
 * byte-locked corpus (conformance/corpus/mcp_proof_scitt_v1/, vendored under
 * test/fixtures/): it must agree with `expected_status` on every vector, the
 * same corpus a zero-shared-code Python impl (cbor2 + PyNaCl) already agrees
 * with. Convergence is the moat.
 *
 * GATED: verifying the format is a capability, not a public claim. No public
 * "SCITT-conformant" claim until IANA registration + THREAT-MODEL §9
 * (docs/security/scitt-public-claim-gate.md).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyMcpScittStatement,
  detectMcpProofForm,
  MCP_SCITT_PROFILE,
} from "../src/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, "fixtures", "mcp_proof_scitt_v1");
const index = JSON.parse(fs.readFileSync(path.join(CORPUS, "index.json"), "utf8"));

test("SCITT profile constant matches the corpus", () => {
  assert.equal(index.schema_version, "mcp_proof_scitt_v1");
  assert.equal(MCP_SCITT_PROFILE, "application/mcp-proof-scitt+cose");
});

for (const entry of index.vectors) {
  test(`corpus vector ${entry.vector_id} → ${entry.expected_status}`, () => {
    const v = JSON.parse(fs.readFileSync(path.join(CORPUS, entry.relative_path), "utf8"));
    const bytes = Buffer.from(v.cose_sign1_hex, "hex");
    const resolveKey = (kid) => (kid === v.kid ? v.public_key_jwk : undefined);
    const res = verifyMcpScittStatement(bytes, { resolveKey });
    const got = res.ok ? "VERIFIED" : res.reason;
    assert.equal(got, entry.expected_status);
    if (entry.expected_status === "VERIFIED") {
      assert.equal(res.kid, v.kid);
      assert.equal(res.sub, v.sub); // capability_id feed
      assert.equal(detectMcpProofForm(bytes), "mcp_proof_scitt_cose");
    }
  });
}

test("unknown kid fails closed with KEY_UNKNOWN (one trust root)", () => {
  const v = JSON.parse(fs.readFileSync(path.join(CORPUS, "positive/mcp1-scitt-pos-01-valid.json"), "utf8"));
  const res = verifyMcpScittStatement(Buffer.from(v.cose_sign1_hex, "hex"), { resolveKey: () => undefined });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "KEY_UNKNOWN");
});

test("form discriminator distinguishes JSON v1 from COSE and rejects junk", () => {
  assert.equal(detectMcpProofForm(Buffer.from('{"payload":{}}', "utf8")), "mcp_proof_v1_json");
  assert.equal(detectMcpProofForm(Buffer.from([0xd2, 0x84])), "mcp_proof_scitt_cose");
  assert.equal(detectMcpProofForm(Buffer.from([0x00, 0x01])), "unknown");
});

test("malformed / truncated input fails closed as MALFORMED_CBOR (defensive parsing)", () => {
  const key = () => undefined;
  // empty, a lone tag byte, and a mid-message truncation must all decode-fail,
  // not silently coerce out-of-bounds reads.
  assert.equal(verifyMcpScittStatement(Buffer.alloc(0), { resolveKey: key }).reason, "MALFORMED_CBOR");
  assert.equal(verifyMcpScittStatement(Buffer.from([0xd2]), { resolveKey: key }).reason, "MALFORMED_CBOR");
  assert.equal(verifyMcpScittStatement(Buffer.from([0x84, 0x58, 0x40]), { resolveKey: key }).reason, "MALFORMED_CBOR");
});
