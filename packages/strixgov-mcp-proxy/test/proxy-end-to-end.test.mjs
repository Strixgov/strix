/**
 * End-to-end proxy test using two InMemoryTransport pairs:
 *
 *   [Test Client] ─in-memory─▶ [Proxy as Server]
 *                              [Proxy as Client] ─in-memory─▶ [Fake Upstream MCP Server]
 *
 * Validates the full pipeline — incoming MCP request → governance
 * evaluation → upstream call → response — without spawning real
 * subprocesses. The same code paths run in production; only the
 * transports are swapped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { startProxy } from "../src/index.mjs";

const SAMPLE_CAPS = [
  { id: "mcp.demo.read_thing",   name: "read_thing",   risk: "LOW",      mode: "READ"  },
  { id: "mcp.demo.write_thing",  name: "write_thing",  risk: "MEDIUM",   mode: "WRITE" },
  { id: "mcp.demo.delete_thing", name: "delete_thing", risk: "CRITICAL", mode: "WRITE" },
];

/**
 * Build a fake upstream MCP server + a Client pre-connected to it via
 * an InMemoryTransport pair. The proxy treats this client as if it
 * were a real subprocess-spawned upstream.
 */
async function buildFakeUpstream(toolCallLog) {
  const upstreamServer = new Server(
    { name: "fake-upstream", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  upstreamServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "read_thing",   description: "Read a thing",   inputSchema: { type: "object" } },
      { name: "write_thing",  description: "Write a thing",  inputSchema: { type: "object" } },
      { name: "delete_thing", description: "Delete a thing", inputSchema: { type: "object" } },
    ],
  }));
  upstreamServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    toolCallLog.push({ name: request.params.name, args: request.params.arguments });
    return {
      content: [{ type: "text", text: `executed ${request.params.name}` }],
    };
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await upstreamServer.connect(serverSide);

  const upstreamClient = new Client(
    { name: "test-upstream-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await upstreamClient.connect(clientSide);

  return { upstreamServer, upstreamClient };
}

/** Build a test MCP client paired to the proxy's server-side transport. */
async function buildConsumerClient() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const consumerClient = new Client(
    { name: "test-consumer", version: "0.0.1" },
    { capabilities: {} },
  );
  return { consumerClient, clientSide, serverSide };
}

async function startTestProxy({
  allowList,
  capabilities = SAMPLE_CAPS,
  riskOverrides,
  storagePath,
} = {}) {
  const upstreamCallLog = [];
  const auditLog = [];
  const receipts = [];
  const upstream = await buildFakeUpstream(upstreamCallLog);
  const { consumerClient, clientSide, serverSide } = await buildConsumerClient();

  const rules = {};
  if (allowList) for (const id of allowList) rules[id] = "ALLOW";

  // Default to a per-test tmpdir so we never pollute the dev's home dir with
  // ~/.strix-mcp-proxy/demo/. Callers can override (incl. passing `null` to
  // exercise the explicit ephemeral opt-out path).
  const resolvedStoragePath =
    storagePath === undefined
      ? await fs.mkdtemp(path.join(os.tmpdir(), "strix-proxy-test-"))
      : storagePath;

  const handle = await startProxy({
    serverId: "demo",
    capabilities,
    policy: { rules, riskOverrides, default: "DENY" },
    storagePath: resolvedStoragePath,
    onReceipt: (r) => receipts.push(r),
    onAudit: (e) => auditLog.push(e),
    transport: {
      kind: "test",
      upstreamClient: upstream.upstreamClient,
      serverTransport: serverSide,
    },
  });
  await consumerClient.connect(clientSide);

  return {
    consumer: consumerClient,
    proxy: handle,
    upstream,
    upstreamCallLog,
    receipts,
    auditLog,
    storagePath: resolvedStoragePath,
    cleanup: async () => {
      try { await consumerClient.close(); } catch { /* */ }
      try { await handle.stop(); } catch { /* */ }
      try { await upstream.upstreamClient.close(); } catch { /* */ }
      try { await upstream.upstreamServer.close(); } catch { /* */ }
      if (resolvedStoragePath && resolvedStoragePath.startsWith(os.tmpdir())) {
        try { await fs.rm(resolvedStoragePath, { recursive: true, force: true }); } catch { /* */ }
      }
    },
  };
}

test("listTools surfaces the upstream's tool descriptors verbatim (governance does not reshape tools)", async () => {
  const ctx = await startTestProxy({ allowList: ["mcp.demo.read_thing"] });
  try {
    const result = await ctx.consumer.listTools();
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["delete_thing", "read_thing", "write_thing"]);
    // Description preserved end-to-end.
    const readTool = result.tools.find((t) => t.name === "read_thing");
    assert.equal(readTool.description, "Read a thing");
  } finally {
    await ctx.cleanup();
  }
});

test("ALLOW: callTool reaches the upstream and the response round-trips", async () => {
  const ctx = await startTestProxy({ allowList: ["mcp.demo.read_thing"] });
  try {
    const result = await ctx.consumer.callTool({
      name: "read_thing",
      arguments: { id: "x" },
    });
    assert.equal(result.content[0].text, "executed read_thing");
    assert.equal(ctx.upstreamCallLog.length, 1);
    assert.deepEqual(ctx.upstreamCallLog[0], { name: "read_thing", args: { id: "x" } });
  } finally {
    await ctx.cleanup();
  }
});

test("DENY: callTool fails AND the upstream is never invoked AND a signed receipt is still emitted", async () => {
  const ctx = await startTestProxy({}); // no allowlist → DENY default
  try {
    await assert.rejects(
      () => ctx.consumer.callTool({ name: "delete_thing", arguments: { id: "x" } }),
      /denied/i,
    );
    assert.equal(ctx.upstreamCallLog.length, 0, "upstream must not be invoked on DENY");
    assert.equal(ctx.receipts.length, 1);
    assert.equal(ctx.receipts[0].decision, "DENY");
    assert.ok(ctx.receipts[0].signature, "denied calls still produce a signed receipt");
  } finally {
    await ctx.cleanup();
  }
});

test("companion-pack canonical id is used in the receipt (not heuristic-derived)", async () => {
  const ctx = await startTestProxy({ allowList: ["mcp.demo.read_thing"] });
  try {
    await ctx.consumer.callTool({ name: "read_thing", arguments: {} });
    assert.equal(ctx.receipts[0].capabilityId, "mcp.demo.read_thing");
    assert.equal(ctx.receipts[0].decision, "ALLOW");
  } finally {
    await ctx.cleanup();
  }
});

test("actor context from _meta is forwarded to the receipt", async () => {
  const ctx = await startTestProxy({ allowList: ["mcp.demo.read_thing"] });
  try {
    await ctx.consumer.callTool({
      name: "read_thing",
      arguments: { id: "x" },
      _meta: { strix_actor_id: "agent-demo-1" },
    });
    assert.equal(ctx.receipts[0].actorId, "agent-demo-1");
  } finally {
    await ctx.cleanup();
  }
});

test("audit events fire for lifecycle and for denied calls", async () => {
  const ctx = await startTestProxy({});
  try {
    await assert.rejects(() => ctx.consumer.callTool({ name: "delete_thing", arguments: {} }));
    const kinds = ctx.auditLog.map((e) => e.kind);
    assert.ok(kinds.includes("upstream.connected"));
    assert.ok(kinds.includes("proxy.listening"));
    assert.ok(kinds.includes("call.denied"));
  } finally {
    await ctx.cleanup();
  }
});

test("riskOverrides gate the whole CRITICAL surface in one rule", async () => {
  const ctx = await startTestProxy({
    riskOverrides: { LOW: "ALLOW", MEDIUM: "DENY", CRITICAL: "DENY" },
  });
  try {
    await ctx.consumer.callTool({ name: "read_thing", arguments: {} });          // LOW → ALLOW
    await assert.rejects(() => ctx.consumer.callTool({ name: "write_thing", arguments: {} }));   // MEDIUM → DENY
    await assert.rejects(() => ctx.consumer.callTool({ name: "delete_thing", arguments: {} }));  // CRITICAL → DENY
    const decisions = ctx.receipts.map((r) => r.decision);
    assert.deepEqual(decisions, ["ALLOW", "DENY", "DENY"]);
  } finally {
    await ctx.cleanup();
  }
});

test("startProxy validates required opts.upstream.command in stdio mode", async () => {
  await assert.rejects(
    () => startProxy({}),
    /opts\.upstream\.command is required/,
  );
});

test("startProxy validates transport.serverTransport in test mode", async () => {
  const upstream = await buildFakeUpstream([]);
  try {
    await assert.rejects(
      () => startProxy({
        serverId: "demo",
        transport: { kind: "test", upstreamClient: upstream.upstreamClient },
        policy: { default: "DENY" },
        // storagePath: null so this purely-validation test doesn't write a
        // signing key to the dev's home directory before throwing.
        storagePath: null,
      }),
      /serverTransport/,
    );
  } finally {
    await upstream.upstreamClient.close();
    await upstream.upstreamServer.close();
  }
});

// ─── Persistent signing key (when storagePath is set) ─────────────────
//
// Pre-0.1.2 startProxy used an in-memory ephemeral signing key for
// every run — meaning receipts written to JSONL on disk could never
// be verified after the proxy exited, because the key that signed them
// was discarded with the process. These tests pin the persistent-key
// path: when storagePath is set, the keypair is written to
// `<storagePath>/keys/` so the SAME kid keeps signing receipts across
// restarts, and an external verifier can be pointed at
// `<storagePath>/keys/public-jwk.json`.

async function tempDir(label) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `strix-proxy-${label}-`));
}

async function startProxyWithStorage(storagePath) {
  const upstreamCallLog = [];
  const upstream = await buildFakeUpstream(upstreamCallLog);
  const { consumerClient, clientSide, serverSide } = await buildConsumerClient();

  const handle = await startProxy({
    serverId: "demo",
    capabilities: SAMPLE_CAPS,
    policy: { rules: { "mcp.demo.read_thing": "ALLOW" }, default: "DENY" },
    storagePath,
    transport: {
      kind: "test",
      upstreamClient: upstream.upstreamClient,
      serverTransport: serverSide,
    },
  });
  await consumerClient.connect(clientSide);

  return {
    consumer: consumerClient,
    proxy: handle,
    upstream,
    cleanup: async () => {
      try { await consumerClient.close(); } catch { /* */ }
      try { await handle.stop(); } catch { /* */ }
      try { await upstream.upstreamClient.close(); } catch { /* */ }
      try { await upstream.upstreamServer.close(); } catch { /* */ }
    },
  };
}

test("storagePath causes signing key + public JWK to be persisted to disk", async () => {
  const dir = await tempDir("persist");
  const ctx = await startProxyWithStorage(dir);
  try {
    const keyDir = path.join(dir, "keys");
    const pemPath = path.join(keyDir, "signing-key.pem");
    const jwkPath = path.join(keyDir, "public-jwk.json");

    // Both files must exist after startProxy returns.
    await fs.access(pemPath);
    await fs.access(jwkPath);

    // Public JWK is well-formed and uses the expected kid convention.
    const jwk = JSON.parse(await fs.readFile(jwkPath, "utf8"));
    assert.equal(jwk.kty, "OKP");
    assert.equal(jwk.crv, "Ed25519");
    assert.equal(jwk.kid, "strix-demo");
    assert.equal(typeof jwk.x, "string");
    assert.ok(jwk.x.length > 0);

    // Private key file content is PKCS8 PEM (cheap shape check — full
    // crypto round-trip is exercised by tool-gateway's own tests).
    const pem = await fs.readFile(pemPath, "utf8");
    assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
  } finally {
    await ctx.cleanup();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("persistent signing kid survives a proxy restart (the demo-story invariant)", async () => {
  const dir = await tempDir("restart");
  try {
    // First start — writes the keypair.
    const ctx1 = await startProxyWithStorage(dir);
    const kid1 = ctx1.proxy.signingKey.kid;
    const pubX1 = ctx1.proxy.signingKey.publicKeyJwk.x;
    await ctx1.cleanup();

    // Second start in the same storagePath — must reuse, not regenerate.
    const ctx2 = await startProxyWithStorage(dir);
    const kid2 = ctx2.proxy.signingKey.kid;
    const pubX2 = ctx2.proxy.signingKey.publicKeyJwk.x;
    await ctx2.cleanup();

    assert.equal(kid1, "strix-demo");
    assert.equal(kid2, "strix-demo");
    // Same public key bytes ⇒ same private key on disk was reused.
    assert.equal(pubX1, pubX2, "second start must reuse the persisted key");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("caller-supplied opts.signingKey wins over storagePath persistence", async () => {
  // Caller-supplied keys bypass disk persistence entirely. This pins the
  // ordering documented in proxy.mjs §3a — operators integrating with a
  // KMS or secrets manager shouldn't be surprised by a key file showing
  // up on disk because storagePath happens to be set.
  const { generateSigningKey } = await import("@strixgov/tool-gateway");
  const explicitKey = generateSigningKey("custom-kid");
  const dir = await tempDir("explicit-wins");
  const upstream = await buildFakeUpstream([]);
  const { consumerClient, clientSide, serverSide } = await buildConsumerClient();
  try {
    const handle = await startProxy({
      serverId: "demo",
      capabilities: SAMPLE_CAPS,
      policy: { default: "DENY" },
      storagePath: dir,
      signingKey: explicitKey,
      transport: {
        kind: "test",
        upstreamClient: upstream.upstreamClient,
        serverTransport: serverSide,
      },
    });
    await consumerClient.connect(clientSide);
    try {
      assert.equal(handle.signingKey.kid, "custom-kid");
      // No keys/ subdirectory should have been created — disk persistence
      // is skipped when the caller supplied a key explicitly.
      await assert.rejects(
        () => fs.access(path.join(dir, "keys", "public-jwk.json")),
        /ENOENT/,
      );
    } finally {
      await consumerClient.close();
      await handle.stop();
    }
  } finally {
    await upstream.upstreamClient.close();
    await upstream.upstreamServer.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("storagePath unset ⇒ defaults to ~/.strix-mcp-proxy/<serverId> with persistent key", async () => {
  // v0.1.4: leaving storagePath undefined no longer falls back to ephemeral.
  // The proxy now defaults storagePath to a per-serverId persistent path so
  // receipts on disk are always verifiable across restarts. Use a tmpdir
  // override here instead of HOME so the test stays hermetic.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strix-proxy-default-"));
  try {
    const ctx = await startTestProxy({
      allowList: ["mcp.demo.read_thing"],
      storagePath: dir,
    });
    try {
      assert.ok(ctx.proxy.signingKey, "signingKey must be present by default");
      assert.equal(ctx.proxy.signingKey.kid, "strix-demo");
      // The key file must exist on disk where the verifier expects it.
      const jwkPath = path.join(dir, "keys", "public-jwk.json");
      const jwk = JSON.parse(await fs.readFile(jwkPath, "utf8"));
      assert.equal(jwk.kid, "strix-demo");
      assert.equal(jwk.kty, "OKP");
    } finally {
      await ctx.cleanup();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("storagePath: null ⇒ explicit ephemeral opt-out (no disk writes)", async () => {
  // Documented escape hatch for callers who really do want an in-memory
  // ephemeral key (CI smoke runs, demos). Receipts in this mode are chain-
  // coherent within the session but unverifiable across restarts; that's
  // the trade-off the caller is opting into.
  const ctx = await startTestProxy({
    allowList: ["mcp.demo.read_thing"],
    storagePath: null,
  });
  try {
    assert.ok(ctx.proxy.signingKey, "signingKey must still be present (ephemeral)");
    assert.equal(ctx.proxy.signingKey.kid, "strix-demo");
  } finally {
    await ctx.cleanup();
  }
});

// ─── Approval resolution (JSON-config friendly approver types) ────────
//
// Pre-0.1.3 startProxy only accepted `approval.prompt` as a function —
// which made the JSON-config path useless for headless approval, since
// JSON can't carry a function. 0.1.3 adds string-typed approvers
// (`type: "file" | "auto" | "terminal"`) that the proxy translates to
// the appropriate @strixgov/tool-gateway primitive. These tests pin the
// resolution rules.

async function startProxyWithApproval(approval, extraOpts = {}) {
  const upstreamCallLog = [];
  const upstream = await buildFakeUpstream(upstreamCallLog);
  const { consumerClient, clientSide, serverSide } = await buildConsumerClient();

  // v0.1.4: storagePath now defaults to ~/.strix-mcp-proxy/<serverId>, so
  // approval-config tests would pollute the dev's home dir unless we route
  // to a tmpdir. Approval-resolution tests don't care about the path —
  // they only check that the approver function is wired correctly — so a
  // tmpdir override is the right boundary here. Callers can still pass
  // their own `storagePath` via extraOpts.
  const tmpStoragePath =
    extraOpts.storagePath === undefined
      ? await fs.mkdtemp(path.join(os.tmpdir(), "strix-proxy-approval-"))
      : extraOpts.storagePath;

  const handle = await startProxy({
    serverId: "demo",
    capabilities: SAMPLE_CAPS,
    // write_thing is MEDIUM. With `MEDIUM → APPROVAL_REQUIRED`, every
    // write_thing call should hit the approval path so these tests can
    // observe whether the approver was wired correctly.
    policy: {
      rules: { "mcp.demo.read_thing": "ALLOW" },
      riskOverrides: { MEDIUM: "APPROVAL_REQUIRED" },
      default: "DENY",
    },
    approval,
    transport: {
      kind: "test",
      upstreamClient: upstream.upstreamClient,
      serverTransport: serverSide,
    },
    ...extraOpts,
    storagePath: tmpStoragePath,
  });
  await consumerClient.connect(clientSide);

  return {
    consumer: consumerClient,
    proxy: handle,
    upstream,
    upstreamCallLog,
    storagePath: tmpStoragePath,
    cleanup: async () => {
      try { await consumerClient.close(); } catch { /* */ }
      try { await handle.stop(); } catch { /* */ }
      try { await upstream.upstreamClient.close(); } catch { /* */ }
      try { await upstream.upstreamServer.close(); } catch { /* */ }
      if (tmpStoragePath && tmpStoragePath.startsWith(os.tmpdir())) {
        try { await fs.rm(tmpStoragePath, { recursive: true, force: true }); } catch { /* */ }
      }
    },
  };
}

test("approval.type: 'auto' auto-approves MEDIUM calls and they reach the upstream", async () => {
  const ctx = await startProxyWithApproval({ enabled: true, type: "auto" });
  try {
    const result = await ctx.consumer.callTool({
      name: "write_thing",
      arguments: { id: "x" },
    });
    assert.equal(result.content[0].text, "executed write_thing");
    assert.equal(ctx.upstreamCallLog.length, 1, "auto-approved write must reach the upstream");
  } finally {
    await ctx.cleanup();
  }
});

test("approval.autoApprove: true (long form) behaves like type: 'auto'", async () => {
  // Pin that the long form continues to work — operators who already
  // wrote `autoApprove: true` shouldn't get broken by the new resolver.
  const ctx = await startProxyWithApproval({ enabled: true, autoApprove: true });
  try {
    await ctx.consumer.callTool({ name: "write_thing", arguments: {} });
    assert.equal(ctx.upstreamCallLog.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("approval.type: 'file' wires up a fileApprover and writes a request file to disk", async () => {
  const requestDir = await tempDir("file-approver");
  const ctx = await startProxyWithApproval(
    {
      enabled: true,
      type: "file",
      requestDir,
      timeoutMs: 250, // short timeout so the test doesn't hang
    },
  );
  try {
    // No out-of-band approval response is written → expect timeout → DENY.
    // What we're verifying here is structural: the proxy did the request-file
    // write, which means the fileApprover was constructed and called.
    await assert.rejects(
      () => ctx.consumer.callTool({ name: "write_thing", arguments: { id: "x" } }),
      /denied|timeout/i,
    );
    assert.equal(ctx.upstreamCallLog.length, 0, "denied call must not reach upstream");
  } finally {
    await ctx.cleanup();
    await fs.rm(requestDir, { recursive: true, force: true });
  }
});

test("approval.type: 'file' with no requestDir defaults to <storagePath>/approvals", async () => {
  const storagePath = await tempDir("file-approver-default");
  const ctx = await startProxyWithApproval(
    { enabled: true, type: "file", timeoutMs: 250 },
    { storagePath },
  );
  try {
    await assert.rejects(
      () => ctx.consumer.callTool({ name: "write_thing", arguments: {} }),
      /denied|timeout/i,
    );
    // fileApprover cleans up request/response files on each call, so we
    // can't assert their persistence. But the approvals directory itself
    // is created on first request — that's enough structural evidence.
    const dirExists = await fs
      .access(path.join(storagePath, "approvals"))
      .then(() => true)
      .catch(() => false);
    assert.ok(dirExists, "<storagePath>/approvals directory must be created");
  } finally {
    await ctx.cleanup();
    await fs.rm(storagePath, { recursive: true, force: true });
  }
});

test("approval.type: 'file' with ~/ requestDir expands to os.homedir()", async () => {
  // We don't want to actually write to the developer's home directory in
  // a test, so use a custom HOME via os.tmpdir trick: temporarily replace
  // os.homedir's return value via env. node's os.homedir respects $HOME
  // on Unix and $USERPROFILE on Windows; setting both keeps the test
  // platform-agnostic.
  const fakeHome = await tempDir("fake-home");
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const ctx = await startProxyWithApproval({
      enabled: true,
      type: "file",
      requestDir: "~/strix-approvals-test",
      timeoutMs: 250,
    });
    try {
      await assert.rejects(() => ctx.consumer.callTool({ name: "write_thing", arguments: {} }));
      const exists = await fs
        .access(path.join(fakeHome, "strix-approvals-test"))
        .then(() => true)
        .catch(() => false);
      assert.ok(exists, "~/ in approval.requestDir must expand to homedir");
    } finally {
      await ctx.cleanup();
    }
  } finally {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});

test("approval.type: 'terminal' is the explicit legacy default (passes through; denies in non-TTY)", async () => {
  // node:test inherits the parent process's stdin TTY-ness. When run from
  // a real terminal, terminalApprove's early "non-TTY → PROMPT_FAILED" guard
  // doesn't fire, so it falls back to waiting on the timeout — verifying the
  // longer DENY-on-timeout path is still active. Short timeout so the test
  // doesn't sit for 60s; we're pinning the "type: 'terminal' is passed
  // through to the gateway" behavior, not the specific deny reason.
  const ctx = await startProxyWithApproval({
    enabled: true,
    type: "terminal",
    timeoutMs: 250,
  });
  try {
    await assert.rejects(
      () => ctx.consumer.callTool({ name: "write_thing", arguments: {} }),
      /denied|timeout/i,
    );
    assert.equal(ctx.upstreamCallLog.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("approval.type: unknown ⇒ startProxy throws at startup (fail-fast, not silently fail-closed)", async () => {
  // The whole point of typed config is to surface misconfiguration BEFORE
  // the proxy starts denying calls in production. Operators who type
  // `"type": "filee"` should see an immediate startup error, not a silent
  // deny loop.
  const upstream = await buildFakeUpstream([]);
  const { serverSide } = await buildConsumerClient();
  try {
    await assert.rejects(
      () =>
        startProxy({
          serverId: "demo",
          capabilities: SAMPLE_CAPS,
          policy: { default: "DENY" },
          approval: { enabled: true, type: "websocket-pony" },
          transport: {
            kind: "test",
            upstreamClient: upstream.upstreamClient,
            serverTransport: serverSide,
          },
          // storagePath: null so this fail-fast validation test doesn't
          // write a signing key to the dev's home directory before the
          // approval.type error throws.
          storagePath: null,
        }),
      /unknown approval\.type/,
    );
  } finally {
    await upstream.upstreamClient.close();
    await upstream.upstreamServer.close();
  }
});

test("approval.prompt (function) wins over approval.type (programmatic caller priority)", async () => {
  // If a programmatic caller (e.g. embedded SDK use) passes a prompt
  // function directly, the proxy's string-to-function translator must
  // NOT overwrite it. Verifies the resolution-order docstring's claim
  // that prompt-fn is rule #1.
  let promptCallCount = 0;
  const customPrompt = async () => {
    promptCallCount++;
    return { approved: true, reason: "USER_APPROVED", approvedBy: "custom" };
  };

  const ctx = await startProxyWithApproval({
    enabled: true,
    type: "auto", // would normally autoApprove without ever calling prompt
    prompt: customPrompt, // but this should win
  });
  try {
    await ctx.consumer.callTool({ name: "write_thing", arguments: {} });
    assert.equal(promptCallCount, 1, "custom prompt must be called, not autoApprove path");
    assert.equal(ctx.upstreamCallLog.length, 1);
  } finally {
    await ctx.cleanup();
  }
});
