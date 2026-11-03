// A tool that RETURNS `isError: true` failed, even though its handler
// finished. MCP servers report most tool failures that way rather than by
// throwing, so the signed execution outcome must say FAILED.
//
// Found on 2026-10-31 by running @strixgov/mcp-proxy@0.2.0 against a real
// Postgres 16: a DROP TABLE sent to a read tool was refused by Postgres
// ("cannot execute DROP TABLE in a read-only transaction"), and its signed
// outcome said SUCCEEDED.
import test from "node:test";
import assert from "node:assert/strict";

import { generateSigningKey, verifyExecutionOutcome } from "@strixgov/tool-gateway";
import { verifyExecutionOutcomeRecord } from "@strixgov/verifier/execution-outcome";
import { governMCPServer, TOOL_REPORTED_ERROR } from "../src/index.mjs";

const DB_ERROR = {
  isError: true,
  content: [{ type: "text", text: "cannot execute DROP TABLE in a read-only transaction" }],
};

// Shaped like the proxy's upstream: a listTools + handler interface whose
// handler returns MCP CallToolResults.
function buildServer(handlerResult) {
  const signingKey = generateSigningKey("tool-error-test-key");
  const calls = [];
  const server = governMCPServer(
    {
      listTools: async () => [{ name: "query" }],
      handler: async (name, args) => {
        calls.push([name, args]);
        return typeof handlerResult === "function" ? handlerResult() : handlerResult;
      },
    },
    {
      serverId: "postgres",
      signingKey,
      policy: { rules: { "mcp.postgres.query": "ALLOW" }, default: "DENY" },
    },
  );
  return { server, signingKey, calls };
}

test("a tool result with isError: true is signed FAILED, with TOOL_REPORTED_ERROR", async () => {
  const { server, calls } = buildServer(DB_ERROR);
  const execution = await server.executeTool("query", { sql: "drop table orders" });

  assert.equal(calls.length, 1, "the tool was called");
  assert.equal(execution.decision, "ALLOW");
  assert.equal(execution.executionOutcome.executionStatus, "FAILED");
  assert.equal(execution.executionOutcome.errorCode, TOOL_REPORTED_ERROR);
  assert.equal(execution.executionOutcome.resultHash, "");
});

test("the FAILED outcome verifies with both the gateway and the published verifier", async () => {
  const { server, signingKey } = buildServer(DB_ERROR);
  const execution = await server.executeTool("query", { sql: "drop table orders" });
  assert.equal(execution.executionOutcome.executionStatus, "FAILED");

  assert.equal(
    verifyExecutionOutcome(execution.executionOutcome, signingKey.publicKey, execution.authorizationReceipt)
      .verificationStatus,
    "VERIFIED",
  );
  const independent = verifyExecutionOutcomeRecord(execution.executionOutcome, {
    publicKey: signingKey.publicKey,
    authorizationReceipt: execution.authorizationReceipt,
  });
  assert.equal(independent.verificationStatus, "VERIFIED");
  assert.equal(independent.consistencyValid, true);
});

test("the client still receives the tool's error result unchanged", async () => {
  const { server } = buildServer(DB_ERROR);
  const execution = await server.executeTool("query", { sql: "drop table orders" });
  assert.equal(execution.ok, true, "the call was allowed and the handler returned");
  assert.deepEqual(execution.result, DB_ERROR);

  const value = await server.callTool("query", { sql: "drop table orders" });
  assert.deepEqual(value, DB_ERROR, "callTool returns the error result, it does not throw");
});

test("isError: false, or no flag, is SUCCEEDED", async () => {
  for (const result of [
    { isError: false, content: [{ type: "text", text: "1" }] },
    { content: [{ type: "text", text: "1" }] },
  ]) {
    const { server } = buildServer(result);
    const execution = await server.executeTool("query", { sql: "select 1" });
    assert.equal(execution.executionOutcome.executionStatus, "SUCCEEDED");
    assert.equal(execution.executionOutcome.errorCode, "");
  }
});

test("only the literal true counts as the flag", async () => {
  for (const isError of ["true", 1]) {
    const { server } = buildServer({ isError, content: [] });
    const execution = await server.executeTool("query", { sql: "select 1" });
    assert.equal(execution.executionOutcome.executionStatus, "SUCCEEDED", `isError: ${JSON.stringify(isError)}`);
  }
});

test("a handler that throws is still FAILED with EXECUTOR_ERROR", async () => {
  const { server } = buildServer(() => {
    const error = new Error("connection refused");
    error.code = "ECONNREFUSED";
    throw error;
  });
  const execution = await server.executeTool("query", { sql: "select 1" });
  assert.equal(execution.ok, false);
  assert.equal(execution.executionOutcome.executionStatus, "FAILED");
  assert.equal(execution.executionOutcome.errorCode, "EXECUTOR_ERROR");
});
