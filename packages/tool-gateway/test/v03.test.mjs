/**
 * v0.3 surface tests.
 *
 * Covers:
 *   - ConnectedSyncer constructor validation (apiKey length, fetch presence).
 *   - Receipt sync: HMAC-SHA256 over the body, header set, wire version flag.
 *   - Fail-open semantics: upstream 5xx / network error never blocks the
 *     local execute() call. Receipt is still on-disk and signed.
 *   - Buffer / drain: queued records on failure; drain succeeds on next
 *     successful flush.
 *   - Buffer overflow: oldest record dropped, sync-error fires.
 *   - Snapshot sync: rotateKey() POSTs to the snapshots path.
 *   - Verifier 1.7.0: verifyConnectedWireEnvelope accepts well-formed
 *     envelope, rejects wrong key / unrecognised wireVersion.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createServer } from "node:http";

import {
  createGateway,
  generateSigningKey,
  loadOrCreateKeyRing,
  MemoryStorage,
  JsonlStorage,
  ConnectedSyncer,
  WIRE_VERSION,
} from "../src/index.mjs";

import {
  verifyConnectedWireEnvelope,
  SUPPORTED_WIRE_VERSIONS,
} from "../../strixgov-verifier/src/index.mjs";

async function tmpDir(prefix = "strix-gw-v03-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const POLICY = {
  rules: { "fs.read": "ALLOW" },
  default: "DENY",
};
const CAPS = {
  "fs.read": { id: "fs.read", risk: "LOW", mode: "READ" },
};

function startCaptureServer() {
  /** @type {Array<{ url: string, headers: Record<string, string>, body: string, status: number }>} */
  const captured = [];
  let respondWithStatus = 200;
  let respondWithBody = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({
        url: req.url ?? "",
        headers: { ...req.headers },
        body,
        status: respondWithStatus,
      });
      res.writeHead(respondWithStatus, {
        "content-type": "application/json",
      });
      res.end(respondWithBody);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        captured,
        setStatus: (s, body = "") => {
          respondWithStatus = s;
          respondWithBody = body;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test("ConnectedSyncer rejects too-short apiKey", () => {
  assert.throws(
    () =>
      new ConnectedSyncer({
        kernelUrl: "http://x",
        apiKey: "tooshort",
        tenantId: "t",
      }),
    /at least 16 chars/,
  );
});

test("ConnectedSyncer rejects missing tenantId", () => {
  assert.throws(
    () =>
      new ConnectedSyncer({
        kernelUrl: "http://x",
        apiKey: "0123456789abcdef0123456789abcdef",
        tenantId: "",
      }),
    /tenantId is required/,
  );
});

test("WIRE_VERSION is v0.4-stable and the verifier recognises it", () => {
  assert.equal(WIRE_VERSION, "v0.4-stable");
  assert.ok(SUPPORTED_WIRE_VERSIONS.includes(WIRE_VERSION));
  // v0.3-experimental still recognised for backward compat
  assert.ok(SUPPORTED_WIRE_VERSIONS.includes("v0.3-experimental"));
});

test("Receipt sync: well-formed POST with HMAC, tenant, and wire-version headers", async () => {
  const srv = await startCaptureServer();
  try {
    const apiKey = "0123456789abcdef0123456789abcdef";
    const gateway = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: {
        kernelUrl: srv.baseUrl,
        apiKey,
        tenantId: "tenant-x",
      },
    });
    await gateway.execute(
      { capabilityId: "fs.read", action: "read", args: { path: "x" } },
      () => "ok",
    );
    // Wait briefly for fire-and-forget POST to land.
    for (let i = 0; i < 20 && srv.captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(srv.captured.length, 1);
    const post = srv.captured[0];
    assert.equal(post.headers["x-tenant-id"], "tenant-x");
    assert.equal(post.headers["x-strix-wire-version"], "v0.4-stable");
    assert.equal(post.headers["authorization"], `Bearer ${apiKey}`);
    assert.match(post.headers["x-strix-signature"], /^hmac-sha256=[0-9a-f]{64}$/);
    const v = verifyConnectedWireEnvelope({
      body: post.body,
      signatureHeader: post.headers["x-strix-signature"],
      apiKey,
    });
    assert.equal(v.valid, true);
    assert.equal(v.recognised, true);
    assert.equal(v.wireVersion, "v0.4-stable");
    // v0.4-stable: timestamp and nonce must be present
    assert.ok(typeof v.timestamp === "string" && v.timestamp.length > 0, "timestamp present");
    assert.ok(typeof v.nonce === "string" && /^[0-9a-f]{32}$/.test(v.nonce), "nonce is 32-char hex");
    const parsed = JSON.parse(post.body);
    assert.equal(parsed.wireVersion, "v0.4-stable");
    assert.ok(parsed.timestamp, "body has timestamp");
    assert.ok(parsed.nonce, "body has nonce");
    assert.equal(parsed.receipts.length, 1);
  } finally {
    await srv.close();
  }
});

test("Fail-open: upstream 5xx never blocks local execute(), local receipt still issued", async () => {
  const srv = await startCaptureServer();
  srv.setStatus(503);
  try {
    const errors = [];
    const gateway = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: {
        kernelUrl: srv.baseUrl,
        apiKey: "0123456789abcdef0123456789abcdef",
        tenantId: "t",
      },
    });
    gateway.on("sync-error", (e) => errors.push(e));
    const result = await gateway.execute(
      { capabilityId: "fs.read", action: "read", args: { path: "x" } },
      () => "ok",
    );
    assert.equal(result.ok, true);
    assert.ok(result.receipt.signature);
    // sync-error fires asynchronously after the POST resolves.
    for (let i = 0; i < 20 && errors.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(errors.length >= 1, "expected sync-error event");
    assert.equal(errors[0].reason, "non-2xx");
    assert.equal(gateway.connectedSyncer.pending, 1);
  } finally {
    await srv.close();
  }
});

test("Fail-open: network error queues the receipt for drain", async () => {
  const errors = [];
  const gateway = createGateway({
    policy: POLICY,
    capabilities: CAPS,
    signingKey: generateSigningKey("k"),
    storage: new MemoryStorage(),
    approval: { enabled: false },
    connectedMode: {
      kernelUrl: "http://127.0.0.1:1", // black hole
      apiKey: "0123456789abcdef0123456789abcdef",
      tenantId: "t",
    },
  });
  gateway.on("sync-error", (e) => errors.push(e));
  const result = await gateway.execute(
    { capabilityId: "fs.read", action: "read", args: { path: "x" } },
    () => "ok",
  );
  assert.equal(result.ok, true);
  for (let i = 0; i < 20 && errors.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(errors.length >= 1);
  assert.equal(errors[0].reason, "network-error");
});

test("drain() succeeds on next successful flush", async () => {
  const srv = await startCaptureServer();
  srv.setStatus(503);
  try {
    const gateway = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: {
        kernelUrl: srv.baseUrl,
        apiKey: "0123456789abcdef0123456789abcdef",
        tenantId: "t",
      },
    });
    // Three failed sends queue 3 records.
    for (let i = 0; i < 3; i++) {
      await gateway.execute(
        { capabilityId: "fs.read", action: "read", args: { path: `x${i}` } },
        () => "ok",
      );
    }
    // Wait for the fire-and-forget posts to settle.
    for (let i = 0; i < 30 && gateway.connectedSyncer.pending < 3; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(gateway.connectedSyncer.pending, 3);
    // Now upstream recovers; drain.
    srv.setStatus(200);
    const drained = await gateway.drainSync();
    assert.equal(drained.drained, 3);
    assert.equal(drained.pending, 0);
  } finally {
    await srv.close();
  }
});

test("Buffer overflow drops the oldest record and fires sync-error", async () => {
  const srv = await startCaptureServer();
  srv.setStatus(503);
  try {
    const errors = [];
    const gateway = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: {
        kernelUrl: srv.baseUrl,
        apiKey: "0123456789abcdef0123456789abcdef",
        tenantId: "t",
        bufferCap: 2,
      },
    });
    gateway.on("sync-error", (e) => errors.push(e));
    for (let i = 0; i < 4; i++) {
      await gateway.execute(
        { capabilityId: "fs.read", action: "read", args: { path: `x${i}` } },
        () => "ok",
      );
    }
    // Wait for the four fire-and-forget posts to settle.
    for (let i = 0; i < 30 && errors.filter((e) => e.reason === "buffer-overflow").length < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const overflows = errors.filter((e) => e.reason === "buffer-overflow");
    assert.ok(overflows.length >= 2, "expected at least 2 buffer-overflow events");
    assert.equal(gateway.connectedSyncer.pending, 2); // capped
  } finally {
    await srv.close();
  }
});

test("Snapshot sync hits the snapshots path, signed with the same HMAC", async () => {
  const srv = await startCaptureServer();
  try {
    const root = await tmpDir();
    const dir = await tmpDir();
    const ring = await loadOrCreateKeyRing({ root, kid: "kid-A" });
    const gateway = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      keyRing: ring,
      storage: new JsonlStorage({ dir }),
      approval: { enabled: false },
      connectedMode: {
        kernelUrl: srv.baseUrl,
        apiKey: "0123456789abcdef0123456789abcdef",
        tenantId: "t",
      },
    });
    // Need a receipt before we can rotate.
    await gateway.execute(
      { capabilityId: "fs.read", action: "read", args: {} },
      () => "ok",
    );
    await gateway.rotateKey({ kid: "kid-B" });
    for (let i = 0; i < 30 && srv.captured.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const snapshotPost = srv.captured.find((p) => p.url.endsWith("/snapshots"));
    assert.ok(snapshotPost, "expected a POST to /snapshots");
    const parsed = JSON.parse(snapshotPost.body);
    assert.equal(parsed.wireVersion, "v0.4-stable");
    assert.ok(parsed.timestamp, "snapshot body has timestamp");
    assert.ok(parsed.nonce, "snapshot body has nonce");
    assert.equal(parsed.snapshots.length, 1);
    assert.equal(parsed.snapshots[0].newKid, "kid-B");
  } finally {
    await srv.close();
  }
});

test("verifyConnectedWireEnvelope rejects wrong-key signatures", async () => {
  const apiKey = "0123456789abcdef0123456789abcdef";
  const wrongKey = "fedcba9876543210fedcba9876543210";
  const body = JSON.stringify({
    wireVersion: "v0.3-experimental",
    receipts: [{ receiptId: "rcpt_xyz" }],
  });
  const sig =
    "hmac-sha256=" +
    crypto.createHmac("sha256", apiKey).update(body).digest("hex");
  const ok = verifyConnectedWireEnvelope({ body, signatureHeader: sig, apiKey });
  assert.equal(ok.valid, true);
  assert.equal(ok.recognised, true);
  const bad = verifyConnectedWireEnvelope({
    body,
    signatureHeader: sig,
    apiKey: wrongKey,
  });
  assert.equal(bad.valid, false);
});

test("verifyConnectedWireEnvelope flags unknown wireVersion as not recognised", async () => {
  const apiKey = "0123456789abcdef0123456789abcdef";
  const body = JSON.stringify({
    wireVersion: "v0.99-future",
    receipts: [],
  });
  const sig =
    "hmac-sha256=" +
    crypto.createHmac("sha256", apiKey).update(body).digest("hex");
  const r = verifyConnectedWireEnvelope({ body, signatureHeader: sig, apiKey });
  assert.equal(r.valid, true);
  assert.equal(r.recognised, false);
  assert.equal(r.wireVersion, "v0.99-future");
});

test("Connected mode disabled: no sync attempts, no errors", async () => {
  const srv = await startCaptureServer();
  try {
    const gateway = createGateway({
      policy: POLICY,
      capabilities: CAPS,
      signingKey: generateSigningKey("k"),
      storage: new MemoryStorage(),
      approval: { enabled: false },
      connectedMode: {
        enabled: false,
        kernelUrl: srv.baseUrl,
        apiKey: "0123456789abcdef0123456789abcdef",
        tenantId: "t",
      },
    });
    await gateway.execute(
      { capabilityId: "fs.read", action: "read", args: {} },
      () => "ok",
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(srv.captured.length, 0);
    assert.equal(gateway.connectedSyncer, null);
  } finally {
    await srv.close();
  }
});

test("No connectedMode option: no syncer, no events, fully local", async () => {
  const gateway = createGateway({
    policy: POLICY,
    capabilities: CAPS,
    signingKey: generateSigningKey("k"),
    storage: new MemoryStorage(),
    approval: { enabled: false },
  });
  assert.equal(gateway.connectedSyncer, null);
  const r = await gateway.execute(
    { capabilityId: "fs.read", action: "read", args: {} },
    () => "ok",
  );
  assert.equal(r.ok, true);
  // drainSync is a safe no-op when disabled.
  const drain = await gateway.drainSync();
  assert.equal(drain.drained, 0);
  assert.equal(drain.pending, 0);
});
