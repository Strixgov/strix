// Tests for exportOfflineBundle (src/index.mjs) — the customer-facing CLI
// half of docs/architecture/offline-proof-bundle-v1.md §"Export surface".
//
// Spins up a real local HTTP server (same pattern as ct-verifier.test.mjs)
// standing in for apps/strix-console/src/app/api/public/proof/bundle/[evidenceId]/route.ts,
// and asserts exportOfflineBundle forwards each of that route's real response
// shapes (200 success, 501 pending-trust-anchor, 404 not_found, 422
// record_unsigned) verbatim — never fabricating a bundle or swallowing the
// route's structured reason.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { exportOfflineBundle } from "../src/index.mjs";

async function startFakeConsole(responses) {
  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/api\/public\/proof\/bundle\/([^/?]+)/);
    const evidenceId = match ? decodeURIComponent(match[1]) : null;
    const canned = responses[evidenceId];
    if (!canned) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", evidenceId, message: "no fixture" }));
      return;
    }
    res.writeHead(canned.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(canned.body));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    cleanup: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("exportOfflineBundle returns ok:true and the bundle verbatim on 200", async () => {
  const fakeBundle = { bundleVersion: 1, record: { id: "42" }, publicKey: { kty: "OKP" } };
  const ctx = await startFakeConsole({
    "42": { status: 200, body: fakeBundle },
  });
  try {
    const r = await exportOfflineBundle("42", { proofBase: ctx.baseUrl });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.bundle, fakeBundle);
  } finally {
    await ctx.cleanup();
  }
});

test("exportOfflineBundle forwards a 501 pending_trust_anchor_setup verbatim, never fabricates a bundle", async () => {
  const errorBody = {
    error: "not_implemented",
    evidenceId: "42",
    message: "Offline proof bundle export is not yet available.",
    prerequisites: {
      status: "pending_trust_anchor_setup",
      items: [{ id: "rootKeyPinnedInVerifierRelease", ready: false }],
    },
  };
  const ctx = await startFakeConsole({ "42": { status: 501, body: errorBody } });
  try {
    const r = await exportOfflineBundle("42", { proofBase: ctx.baseUrl });
    assert.equal(r.ok, false);
    assert.equal(r.status, 501);
    assert.equal(r.error, "not_implemented");
    assert.equal(r.prerequisites.status, "pending_trust_anchor_setup");
    assert.equal(r.bundle, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test("exportOfflineBundle forwards a 404 not_found verbatim", async () => {
  const ctx = await startFakeConsole({});
  try {
    const r = await exportOfflineBundle("does-not-exist", { proofBase: ctx.baseUrl });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.error, "not_found");
  } finally {
    await ctx.cleanup();
  }
});

test("exportOfflineBundle forwards a 422 record_unsigned verbatim", async () => {
  const errorBody = {
    error: "record_unsigned",
    evidenceId: "7",
    message: "This record is LEGACY_UNSIGNED — there is no signature to bundle.",
  };
  const ctx = await startFakeConsole({ "7": { status: 422, body: errorBody } });
  try {
    const r = await exportOfflineBundle("7", { proofBase: ctx.baseUrl });
    assert.equal(r.ok, false);
    assert.equal(r.status, 422);
    assert.equal(r.error, "record_unsigned");
  } finally {
    await ctx.cleanup();
  }
});

test("exportOfflineBundle rejects with a helpful error when the host is unreachable", async () => {
  // Port 1 is a reserved low port that will refuse the connection immediately
  // rather than hang, on every platform this suite runs on.
  await assert.rejects(
    () => exportOfflineBundle("42", { proofBase: "http://127.0.0.1:1" }),
    /Network error fetching/,
  );
});
