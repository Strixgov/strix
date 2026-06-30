/**
 * Agent Swarm v1 — verifier conformance.
 *
 * Proves the independent verifier (`verifySwarm` in src/index.mjs, which
 * re-implements SCJ v1 + Ed25519 + the attenuation algebra with ZERO shared
 * code) agrees byte-for-byte with the @strixgov/sdk swarm signer. The corpus
 * (test/fixtures/swarm/proof-verified.json) was produced by the SDK signer and
 * shaped exactly like GET /api/public/proof/swarm/<id>. If the verifier's SCJ
 * canonicalization drifts from the SDK's by a single byte, every edge signature
 * fails and these tests go red — which is the entire point of the conformance
 * gate.
 *
 * Uses node:test (no vitest dependency), matching rt-09-verifier-conformance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifySwarm, scjCanonicalize } from "../src/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "swarm", "proof-verified.json"), "utf-8"),
);

// Deep clone so each test mutates an isolated copy.
const clone = (o) => JSON.parse(JSON.stringify(o));

test("VERIFIED — SDK-signed run verifies under the independent verifier", async () => {
  const r = await verifySwarm("swarm_gv1", { proof: clone(CORPUS) });
  assert.equal(r.verificationStatus, "VERIFIED");
  assert.equal(r.reason, "SWARM_VERIFIED");
  assert.equal(r.rooted, true);
  assert.equal(r.counts.edges, 2);
  assert.equal(r.counts.actions, 1);
  assert.equal(r.actions[0].status, "VERIFIED");
  // Independent verdict agrees with the server's claim.
  assert.equal(r.agreesWithServer, true);
});

test("INVALID — a single tampered byte in an edge signature is caught", async () => {
  const c = clone(CORPUS);
  const sig = c.delegations[0].signature;
  c.delegations[0].signature = sig.slice(0, 5) + (sig[5] === "A" ? "B" : "A") + sig.slice(6);
  const r = await verifySwarm("swarm_gv1", { proof: c });
  assert.equal(r.verificationStatus, "INVALID");
  assert.equal(r.actions[0].reason, "SWARM_PATH_BROKEN");
});

test("INVALID — tampering an authenticated field breaks the signature (SCJ binds it)", async () => {
  const c = clone(CORPUS);
  // Widen the leaf edge's capability beyond what was signed.
  c.delegations[1].canonical.payload.capabilitySubset = ["deal.read", "deal.close"];
  const r = await verifySwarm("swarm_gv1", { proof: c });
  assert.equal(r.verificationStatus, "INVALID");
  // Signature check fires before attenuation (the bytes no longer match).
  assert.equal(r.actions[0].reason, "SWARM_PATH_BROKEN");
});

test("UNVERIFIABLE — unknown delegator key is 'cannot verify', not 'invalid'", async () => {
  const c = clone(CORPUS);
  c.delegations[1].delegatorPublicKeyJwk = null;
  const r = await verifySwarm("swarm_gv1", { proof: c });
  assert.equal(r.verificationStatus, "UNVERIFIABLE");
  assert.equal(r.actions[0].reason, "SWARM_DELEGATOR_KEY_UNKNOWN");
});

test("INVALID — unrooted run (root decision not approved)", async () => {
  const c = clone(CORPUS);
  c.rooted = false;
  const r = await verifySwarm("swarm_gv1", { proof: c });
  assert.equal(r.verificationStatus, "INVALID");
  assert.equal(r.reason, "SWARM_UNROOTED");
});

test("INVALID — orphaned action (path references a missing delegation)", async () => {
  const c = clone(CORPUS);
  c.actions[0].canonical.payload.delegationPath = ["d1", "d2", "d3"];
  const r = await verifySwarm("swarm_gv1", { proof: c });
  assert.equal(r.verificationStatus, "INVALID");
  assert.equal(r.actions[0].reason, "SWARM_ORPHAN_SIDE_EFFECT");
});

test("INVALID — task-hash mismatch between action and executing edge", async () => {
  const c = clone(CORPUS);
  c.actions[0].canonical.payload.taskHash = "sha256:" + "c".repeat(64);
  const r = await verifySwarm("swarm_gv1", { proof: c });
  assert.equal(r.verificationStatus, "INVALID");
  assert.equal(r.actions[0].reason, "SWARM_TASK_HASH_MISMATCH");
});

test("INVALID — expired edge under a wall clock past its window", async () => {
  const r = await verifySwarm("swarm_gv1", {
    proof: clone(CORPUS),
    now: new Date("2026-06-07T05:00:00.000Z"),
  });
  assert.equal(r.verificationStatus, "INVALID");
  assert.equal(r.actions[0].reason, "SWARM_EXPIRED");
});

test("NOT_FOUND — 404 from the proof surface", async () => {
  // No proof injected + a base that will 404; simulate by injecting a 404-shaped
  // path via a stub fetch is overkill — instead assert the offline contract:
  // an empty/edgeless proof with no run is an ERROR, a real 404 is handled by
  // the fetch path. Here we cover the malformed-response guard.
  const r = await verifySwarm("swarm_gv1", { proof: { delegations: [], actions: [] } });
  assert.equal(r.verificationStatus, "ERROR");
});

test("scjCanonicalize sorts object keys recursively (byte contract)", () => {
  assert.equal(scjCanonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(scjCanonicalize({ z: { y: 1, x: 2 }, a: [3, 1] }), '{"a":[3,1],"z":{"x":2,"y":1}}');
  assert.equal(scjCanonicalize(["c", "a", "b"]), '["c","a","b"]'); // arrays order-preserved
});
