import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  generateSigningKey,
  loadOrCreateKeyRing,
  verifyReceipt,
  verifyExecutionOutcome,
} from "@strixgov/tool-gateway";
import { governMCPServer } from "../src/index.mjs";

const CAPABILITIES = [
  {
    id: "mcp.nooa.inspect_repository",
    name: "inspect_repository",
    risk: "LOW",
    mode: "READ",
  },
  {
    id: "mcp.nooa.propose_patch",
    name: "propose_patch",
    risk: "HIGH",
    mode: "WRITE",
  },
  {
    id: "mcp.nooa.merge_production",
    name: "merge_production",
    risk: "CRITICAL",
    mode: "WRITE",
  },
];

function buildServer(extra = {}) {
  const signingKey = extra.signingKey ?? generateSigningKey("nooa-test-key");
  const calls = [];
  const server = governMCPServer(
    {
      inspect_repository: async (args) => {
        calls.push(["inspect_repository", args]);
        return { files: 3 };
      },
      propose_patch: async (args) => {
        calls.push(["propose_patch", args]);
        return { branch: "remediation" };
      },
      merge_production: async (args) => {
        calls.push(["merge_production", args]);
        return { merged: true };
      },
      failing_tool: async () => {
        calls.push(["failing_tool", {}]);
        const error = new Error("upstream unavailable");
        error.code = "UPSTREAM_UNAVAILABLE";
        throw error;
      },
    },
    {
      serverId: "nooa",
      capabilities: CAPABILITIES,
      signingKey,
      policy: {
        rules: {
          "mcp.nooa.inspect_repository": "ALLOW",
          "mcp.nooa.propose_patch": "ALLOW",
          "mcp.nooa.merge_production": "DENY",
          "mcp.nooa.failing_tool": "ALLOW",
        },
        default: "DENY",
      },
      identity: {
        actorId: "spiffe://openshell.local/nooa/remediator",
        actorRole: "agent",
        requireTrusted: true,
      },
      tenantId: "nvidia-demo",
      environment: "openshell",
      ...extra,
    },
  );
  return { server, signingKey, calls };
}

test("trusted workload identity overrides spoofed MCP client metadata", async () => {
  const { server } = buildServer();
  const execution = await server.executeTool(
    "inspect_repository",
    { repository: "demo/repo" },
    { actorId: "attacker", actorRole: "admin" },
  );
  assert.equal(execution.ok, true);
  assert.equal(
    execution.authorizationReceipt.actorId,
    "spiffe://openshell.local/nooa/remediator",
  );
  assert.equal(execution.authorizationReceipt.actorRole, "agent");
});

test("ALLOW produces linked authorization and SUCCEEDED outcome", async () => {
  const { server, signingKey, calls } = buildServer();
  const execution = await server.executeTool("propose_patch", { patch: "sha256:abc" });

  assert.equal(execution.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(execution.authorizationReceipt.decision, "ALLOW");
  assert.equal(execution.executionOutcome.executionStatus, "SUCCEEDED");

  const verified = verifyExecutionOutcome(
    execution.executionOutcome,
    signingKey.publicKey,
    execution.authorizationReceipt,
  );
  assert.equal(verified.verificationStatus, "VERIFIED");
});

test("DENY never invokes handler and produces no execution outcome", async () => {
  const { server, calls } = buildServer();
  const execution = await server.executeTool("merge_production", { commit: "abc" });
  assert.equal(execution.ok, false);
  assert.equal(execution.decision, "DENY");
  assert.equal(calls.length, 0);
  assert.equal(execution.authorizationReceipt.decision, "DENY");
  assert.equal(execution.executionOutcome, null);
});

test("executor failure produces signed FAILED outcome", async () => {
  const { server, signingKey } = buildServer();
  const execution = await server.executeTool("failing_tool", {});
  assert.equal(execution.ok, false);
  assert.equal(execution.decision, "ALLOW");
  assert.equal(execution.executionOutcome.executionStatus, "FAILED");
  assert.equal(execution.executionOutcome.errorCode, "EXECUTOR_ERROR");
  assert.equal(
    verifyExecutionOutcome(
      execution.executionOutcome,
      signingKey.publicKey,
      execution.authorizationReceipt,
    ).verificationStatus,
    "VERIFIED",
  );
});

test("callTool preserves compatibility and exposes proof on errors", async () => {
  const { server } = buildServer();
  const value = await server.callTool("inspect_repository", {});
  assert.deepEqual(value, { files: 3 });

  await assert.rejects(
    () => server.callTool("merge_production", {}),
    (err) => {
      assert.equal(err.code, "EXACT_RULE");
      assert.equal(err.authorizationReceipt.decision, "DENY");
      assert.equal(err.executionOutcome, null);
      return true;
    },
  );
});

test("trusted-identity failure is governed, signed, and non-executing", async () => {
  let called = false;
  const server = governMCPServer(
    { inspect_repository: async () => { called = true; return {}; } },
    {
      serverId: "nooa",
      signingKey: generateSigningKey("identity-test"),
      policy: { rules: { "mcp.nooa.inspect_repository": "ALLOW" }, default: "DENY" },
      identity: { requireTrusted: true },
    },
  );

  const execution = await server.executeTool(
    "inspect_repository",
    {},
    { actorId: "client-claim", actorRole: "admin" },
  );
  assert.equal(execution.ok, false);
  assert.equal(execution.decision, "DENY");
  assert.equal(execution.error.code, "IDENTITY_RESOLUTION_FAILED");
  assert.equal(execution.authorizationReceipt.decision, "DENY");
  assert.equal(execution.authorizationReceipt.actorId, undefined);
  assert.equal(execution.executionOutcome, null);
  assert.equal(called, false);
  assert.equal(
    verifyReceipt(execution.authorizationReceipt, server.signingKey.publicKey).status,
    "VERIFIED",
  );
});

test("persistent receipts require an explicit persistent signing key or key ring", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strix-nooa-key-test-"));
  try {
    assert.throws(
      () =>
        governMCPServer(
          { inspect_repository: async () => ({}) },
          {
            serverId: "nooa",
            storagePath: dir,
            policy: { default: "DENY" },
          },
        ),
      /storagePath requires an explicit persistent signingKey or keyRing/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persistent authorization and outcome records are stored separately", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strix-nooa-outcomes-"));
  try {
    const { server } = buildServer({ storagePath: dir });
    await server.callTool("inspect_repository", { repository: "demo/repo" });

    const receiptLines = fs
      .readFileSync(path.join(dir, "receipts.jsonl"), "utf8")
      .trim()
      .split("\n");
    const outcomeLines = fs
      .readFileSync(path.join(dir, "execution-outcomes.jsonl"), "utf8")
      .trim()
      .split("\n");

    assert.equal(receiptLines.length, 1);
    assert.equal(outcomeLines.length, 1);
    assert.equal(JSON.parse(receiptLines[0]).decision, "ALLOW");
    assert.equal(JSON.parse(outcomeLines[0]).executionStatus, "SUCCEEDED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("key rotation signs new outcomes with the active key and preserves history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strix-nooa-rotation-"));
  try {
    const keyRing = await loadOrCreateKeyRing({
      root: path.join(dir, "keys"),
      kid: "nooa-old",
    });
    const server = governMCPServer(
      { inspect_repository: async ({ sequence }) => ({ sequence }) },
      {
        serverId: "nooa",
        capabilities: CAPABILITIES,
        keyRing,
        storagePath: path.join(dir, "evidence"),
        policy: {
          rules: { "mcp.nooa.inspect_repository": "ALLOW" },
          default: "DENY",
        },
        identity: {
          actorId: "spiffe://openshell.local/nooa/remediator",
          requireTrusted: true,
        },
        tenantId: "nvidia-demo",
        environment: "openshell",
      },
    );

    const before = await server.executeTool("inspect_repository", { sequence: 1 });
    assert.equal(before.authorizationReceipt.signingKeyId, "nooa-old");
    assert.equal(before.executionOutcome.signingKeyId, "nooa-old");

    await server.gateway.rotateKey({ kid: "nooa-new" });
    const after = await server.executeTool("inspect_repository", { sequence: 2 });
    assert.equal(server.signingKey.kid, "nooa-new");
    assert.equal(after.authorizationReceipt.signingKeyId, "nooa-new");
    assert.equal(after.executionOutcome.signingKeyId, "nooa-new");

    assert.equal(
      verifyExecutionOutcome(
        before.executionOutcome,
        keyRing.publicKeyForKid("nooa-old"),
        before.authorizationReceipt,
      ).verificationStatus,
      "VERIFIED",
    );
    assert.equal(
      verifyExecutionOutcome(
        after.executionOutcome,
        keyRing.publicKeyForKid("nooa-new"),
        after.authorizationReceipt,
      ).verificationStatus,
      "VERIFIED",
    );
    assert.deepEqual(
      keyRing.jwks().keys.map((key) => key.kid).sort(),
      ["nooa-new", "nooa-old"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
