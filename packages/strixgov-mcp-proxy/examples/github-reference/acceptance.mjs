import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { githubCapabilities } from "@strixgov/capabilities-mcp-common/github";
import {
  approveSigned,
  buildProxyConfig,
  createApproverKey,
  guardPaths,
  respond,
} from "@strixgov/guard";
import { startProxy } from "@strixgov/mcp-proxy";
import { computePolicyVersion } from "@strixgov/tool-gateway";
import { verifyExecutionOutcomeRecord } from "@strixgov/verifier/execution-outcome";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSUMER = process.cwd();
const BASE_EVIDENCE_DIR = process.env.STRIX_EVIDENCE_DIR
  ? path.resolve(process.env.STRIX_EVIDENCE_DIR)
  : path.resolve(CONSUMER, "evidence");
const RUN_ID = new Date().toISOString().replaceAll(":", "-");
const EVIDENCE_DIR = path.join(BASE_EVIDENCE_DIR, `run-${RUN_ID}`);
const TEST_ACTOR = "synthetic-fixture-agent";
const FIXTURE_OWNER = "strix-demo";
const FIXTURE_REPO = "offline-fixture";
const APPROVAL_TIMEOUT_MS = 1800;
const POLL_INTERVAL_MS = 250;
const APPROVER_LABEL = "synthetic-local-reviewer";
const PASS_PHRASE = crypto.randomBytes(24).toString("base64url");

const scenarioResults = [];
const fixtureExecutions = [];
const fixtureOutcomes = [];
const approvalRequests = [];
const approvalRecords = [];

function record(id, status, details) {
  scenarioResults.push({ id, status, details });
  console.log(`${id}: ${status} — ${details}`);
}

function appendFixtureCall(call) {
  fixtureExecutions.push({ at: new Date().toISOString(), ...call });
}

function tool(name, description) {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: true },
  };
}

async function buildFixtureStack({ policy, approval, storagePath }) {
  const upstreamServer = new Server(
    { name: "strix-offline-github-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  upstreamServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      tool("get_file_contents", "Read fixture repository file contents."),
      tool("merge_pull_request", "Fixture-only GitHub-shaped merge; never called through the proxy."),
      tool("create_branch", "Create an in-memory fixture branch."),
      tool("delete_repository", "Unclassified destructive fixture tool."),
    ],
  }));
  upstreamServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    appendFixtureCall({ name, args, route: "upstream-server" });
    if (name === "get_file_contents") {
      fixtureOutcomes.push({ at: new Date().toISOString(), name, status: "READ_RETURNED", detail: "synthetic fixture data only" });
      return { content: [{ type: "text", text: "FIXTURE README: no real repository was read." }] };
    }
    if (name === "create_branch") {
      fixtureOutcomes.push({ at: new Date().toISOString(), name, status: "FIXTURE_WRITE_SUCCEEDED", detail: "branch recorded in memory only" });
      return { content: [{ type: "text", text: "FIXTURE_WRITE_SUCCEEDED: branch recorded in memory only." }] };
    }
    if (name === "merge_pull_request") {
      fixtureOutcomes.push({ at: new Date().toISOString(), name, status: "FIXTURE_REFUSED", detail: "no production merge path is configured" });
      return {
        isError: true,
        content: [{ type: "text", text: "FIXTURE REFUSED: no production merge path is configured." }],
      };
    }
    fixtureOutcomes.push({ at: new Date().toISOString(), name, status: "FIXTURE_REFUSED", detail: "unknown tool" });
    return { isError: true, content: [{ type: "text", text: "FIXTURE_REFUSED: unknown tool." }] };
  });

  const [upstreamClientTransport, upstreamServerTransport] = InMemoryTransport.createLinkedPair();
  await upstreamServer.connect(upstreamServerTransport);
  const upstreamClient = new Client(
    { name: "strix-proxy-upstream-fixture-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await upstreamClient.connect(upstreamClientTransport);

  const [consumerTransport, proxyServerTransport] = InMemoryTransport.createLinkedPair();
  const consumer = new Client(
    { name: "strix-fixture-consumer", version: "1.0.0" },
    { capabilities: {} },
  );
  const receipts = [];
  const handle = await startProxy({
    serverId: "github",
    capabilities: githubCapabilities,
    policy,
    approval,
    storagePath,
    onReceipt: (receipt) => receipts.push(receipt),
    transport: {
      kind: "test",
      upstreamClient,
      serverTransport: proxyServerTransport,
    },
  });
  await consumer.connect(consumerTransport);

  return {
    consumer,
    upstreamClient,
    upstreamServer,
    handle,
    receipts,
    async close() {
      try { await consumer.close(); } catch {}
      try { await handle.stop(); } catch {}
      try { await upstreamServer.close(); } catch {}
    },
  };
}

function denied(resultOrError) {
  return resultOrError instanceof Error || resultOrError?.isError === true;
}

async function expectDenied(promise, label) {
  let outcome;
  try {
    outcome = await promise;
  } catch (error) {
    outcome = error;
  }
  assert.ok(denied(outcome), `${label}: expected a denial/error, got ${JSON.stringify(outcome)}`);
  return outcome;
}

async function waitForRequests(env, count, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { approvalsDir } = guardPaths(env.STRIX_GUARD_HOME);
    const names = await fs.readdir(approvalsDir).catch(() => []);
    const ids = names.filter((name) => name.endsWith(".request.json"))
      .map((name) => name.slice(0, -".request.json".length));
    if (ids.length >= count) return ids.sort();
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${count} pending approval request(s)`);
}

async function readRequest(env, requestId) {
  const requestPath = path.join(guardPaths(env.STRIX_GUARD_HOME).approvalsDir, `${requestId}.request.json`);
  const raw = await fs.readFile(requestPath, "utf8");
  const request = JSON.parse(raw);
  approvalRequests.push({ requestId, requestSha256: crypto.createHash("sha256").update(raw).digest("hex"), request });
  return request;
}

async function approveRequest(env, requestId) {
  const result = await approveSigned(requestId, {
    env,
    io: {
      isTty: true,
      confirm: async () => true,
      secret: async () => PASS_PHRASE,
      print: () => {},
    },
  });
  let response = null;
  try { response = JSON.parse(await fs.readFile(result.responsePath, "utf8")); } catch {}
  approvalRecords.push({
    requestId,
    decision: "APPROVED",
    approverLabel: result.label,
    kid: result.kid,
    response,
    responseCapturedBeforeConsumption: Boolean(response?.signature),
  });
  return result;
}

async function denyRequest(env, requestId, reason = "SYNTHETIC_TEST_DENY") {
  const result = await respond(requestId, { approved: false, by: APPROVER_LABEL, reason, env });
  approvalRecords.push({ requestId, decision: "DENIED", approverLabel: APPROVER_LABEL, reason, signed: false });
  return result;
}

async function markApprovalConsumed(env, requestId, outcome) {
  const record = [...approvalRecords].reverse().find((entry) => entry.requestId === requestId);
  if (!record) throw new Error(`Missing approval record for ${requestId}`);
  const dir = guardPaths(env.STRIX_GUARD_HOME).approvalsDir;
  record.outcome = outcome;
  record.requestFileRemoved = !(await fs.access(path.join(dir, `${requestId}.request.json`)).then(() => true, () => false));
  record.responseFileRemoved = !(await fs.access(path.join(dir, `${requestId}.response.json`)).then(() => true, () => false));
}

async function waitSettled(promise) {
  return Promise.race([
    promise.then((value) => ({ state: "fulfilled", value }), (error) => ({ state: "rejected", error })),
    delay(APPROVAL_TIMEOUT_MS + 1200).then(() => ({ state: "timeout" })),
  ]);
}

async function packageVersions() {
  const names = [
    "@modelcontextprotocol/sdk",
    "@strixgov/capabilities-mcp-common",
    "@strixgov/guard",
    "@strixgov/mcp-adapter",
    "@strixgov/mcp-proxy",
    "@strixgov/tool-gateway",
    "@strixgov/verifier",
  ];
  const rows = [];
  for (const name of names) {
    const file = path.join(CONSUMER, "node_modules", ...name.split("/"), "package.json");
    const pkg = JSON.parse(await fs.readFile(file, "utf8"));
    rows.push({ name: pkg.name, version: pkg.version });
  }
  return rows;
}

async function walkFiles(root) {
  const files = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else files.push(full);
    }
  }
  await visit(root);
  return files;
}

function runVerifier(receiptFile, jwksFile) {
  const verifier = path.join(CONSUMER, "node_modules", "@strixgov", "verifier", "bin", "verify.mjs");
  return spawnSync(process.execPath, [verifier, "chain", receiptFile, "--jwks", jwksFile], {
    cwd: CONSUMER,
    encoding: "utf8",
    timeout: 20_000,
  });
}

async function writeEvidenceFiles({ storagePath, firstKid, lastKid, policyBundle }) {
  const runtimeFiles = await walkFiles(storagePath);
  const receiptSource = runtimeFiles.find((file) => path.basename(file) === "receipts.jsonl");
  const jwksSource = runtimeFiles.find((file) => path.basename(file) === "public-jwk.json");
  assert.ok(receiptSource, `No persisted receipts.jsonl found under ${storagePath}`);
  assert.ok(jwksSource, `No public-jwk.json found under ${storagePath}`);
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  const receiptFile = path.join(EVIDENCE_DIR, "receipts.jsonl");
  const jwksFile = path.join(EVIDENCE_DIR, "public-jwk.json");
  await fs.copyFile(receiptSource, receiptFile);
  await fs.copyFile(jwksSource, jwksFile);

  const verification = runVerifier(receiptFile, jwksFile);
  await fs.writeFile(path.join(EVIDENCE_DIR, "verifier-chain.stdout.txt"), verification.stdout ?? "");
  await fs.writeFile(path.join(EVIDENCE_DIR, "verifier-chain.stderr.txt"), verification.stderr ?? "");
  assert.equal(verification.status, 0, `Published verifier rejected the untampered receipt chain: ${verification.stdout}\n${verification.stderr}`);

  const receiptRows = (await fs.readFile(receiptFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const outcomesSource = runtimeFiles.find((file) => path.basename(file) === "execution-outcomes.jsonl");
  assert.ok(outcomesSource, `No persisted execution-outcomes.jsonl found under ${storagePath}`);
  const outcomesFile = path.join(EVIDENCE_DIR, "execution-outcomes.jsonl");
  await fs.copyFile(outcomesSource, outcomesFile);
  const outcomeRows = (await fs.readFile(outcomesFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const receiptsById = new Map(receiptRows.map((receipt) => [receipt.receiptId, receipt]));
  const jwks = JSON.parse(await fs.readFile(jwksFile, "utf8"));
  const outcomeChecks = outcomeRows.map((outcome) => {
    const authorizationReceipt = receiptsById.get(outcome.authorizationReceiptId);
    return {
      outcomeId: outcome.outcomeId,
      executionStatus: outcome.executionStatus,
      verification: verifyExecutionOutcomeRecord(outcome, {
        jwks: { keys: [jwks] },
        authorizationReceipt,
      }),
    };
  });
  assert.ok(outcomeChecks.length > 0, "Expected at least one signed execution outcome");
  assert.ok(outcomeChecks.every((check) => check.verification.verificationStatus === "VERIFIED"),
    `Independent execution-outcome verification failed: ${JSON.stringify(outcomeChecks)}`);
  await fs.writeFile(path.join(EVIDENCE_DIR, "execution-outcome-verification.json"), `${JSON.stringify(outcomeChecks, null, 2)}\n`);

  const originalLines = (await fs.readFile(receiptFile, "utf8")).trim().split("\n");
  assert.ok(originalLines.length >= 2, "Expected multiple receipts to prove persisted history/restart");
  const first = JSON.parse(originalLines[0]);
  assert.ok(typeof first.signature === "string" && first.signature.length > 4, "First receipt has no signature");
  first.signature = `${first.signature[0] === "A" ? "B" : "A"}${first.signature.slice(1)}`;
  originalLines[0] = JSON.stringify(first);
  const tamperedFile = path.join(EVIDENCE_DIR, "tampered-receipts.jsonl");
  await fs.writeFile(tamperedFile, `${originalLines.join("\n")}\n`);
  const tamperCheck = runVerifier(tamperedFile, jwksFile);
  await fs.writeFile(path.join(EVIDENCE_DIR, "verifier-tamper.stdout.txt"), tamperCheck.stdout ?? "");
  await fs.writeFile(path.join(EVIDENCE_DIR, "verifier-tamper.stderr.txt"), tamperCheck.stderr ?? "");
  assert.notEqual(tamperCheck.status, 0, "Published verifier accepted a tampered signature");

  assert.equal(firstKid, lastKid, "Proxy restart changed the receipt signing key unexpectedly");
  assert.equal(jwks.kid, firstKid, "Published JWK does not match receipt signing key");

  const packageManifest = {
    createdAt: new Date().toISOString(),
    node: process.version,
    npmUserAgent: process.env.npm_config_user_agent ?? null,
    gitCommit: process.env.STRIX_GIT_COMMIT ?? null,
    gitBranch: process.env.STRIX_GIT_BRANCH ?? null,
    consumerPath: CONSUMER,
    fixture: "in-memory GitHub-shaped MCP server; no GitHub network calls or credentials",
    upstreamServer: {
      name: "strix-offline-github-fixture",
      version: "1.0.0",
      transport: "MCP InMemoryTransport",
      externalGitHubProcess: false,
    },
    packages: await packageVersions(),
  };
  await fs.writeFile(path.join(EVIDENCE_DIR, "environment-manifest.json"), `${JSON.stringify(packageManifest, null, 2)}\n`);
  const policyEvidence = {
    policies: Object.fromEntries(Object.entries(policyBundle).map(([name, policy]) => [name, {
      policy,
      policyRevision: computePolicyVersion(policy),
    }])),
    capabilities: githubCapabilities.map(({ id, name, risk, mode }) => ({ id, name, risk, mode })),
  };
  await fs.writeFile(path.join(EVIDENCE_DIR, "policy-and-capabilities.json"), `${JSON.stringify(policyEvidence, null, 2)}\n`);
  await fs.writeFile(path.join(EVIDENCE_DIR, "scenario-results.json"), `${JSON.stringify({
    completeAcceptance: false,
    releaseReady: false,
    scenarios: scenarioResults,
    blockers: [
      "Published MCP proxy does not wire Mode-3 execution authorization.",
      "The GitHub merge PEP is source-reference-only and has no production caller.",
      "Official GitHub MCP merge input lacks an atomic head-SHA precondition.",
      "Current published verifier is 1.24.1; repository candidate 1.24.2 is unpublished.",
      "Gateway is in-process; a separate service outage is not applicable to this demo topology.",
    ],
  }, null, 2)}\n`);
  await fs.writeFile(path.join(EVIDENCE_DIR, "fixture-executions.jsonl"), fixtureExecutions.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await fs.writeFile(path.join(EVIDENCE_DIR, "fixture-outcomes.jsonl"), fixtureOutcomes.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await fs.writeFile(path.join(EVIDENCE_DIR, "approval-requests.jsonl"), approvalRequests.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await fs.writeFile(path.join(EVIDENCE_DIR, "approval-responses-and-consumption.jsonl"), approvalRecords.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await fs.writeFile(path.join(EVIDENCE_DIR, "verifier-results.json"), `${JSON.stringify({ intactChainExitCode: verification.status, tamperedChainExitCode: tamperCheck.status, executionOutcomeCount: outcomeChecks.length, executionOutcomesVerified: outcomeChecks.length }, null, 2)}\n`);
  await fs.writeFile(path.join(EVIDENCE_DIR, "run-boundary.txt"), [
    "Synthetic local MCP fixture only. No GitHub credentials, server process, API call, repository access, or merge.",
    `Receipts verified by published @strixgov/verifier@${(await packageVersions()).find((p) => p.name === "@strixgov/verifier").version}.`,
    "A signed DENY receipt is interception evidence. A fixture execution log is only evidence of the in-memory fixture handler.",
    "The fixture does not establish a GitHub merge or a production single-use execution grant.",
  ].join("\n") + "\n");

  const evidenceFiles = (await fs.readdir(EVIDENCE_DIR)).filter((name) => name !== "sha256sums.txt").sort();
  const sums = [];
  for (const name of evidenceFiles) {
    const bytes = await fs.readFile(path.join(EVIDENCE_DIR, name));
    sums.push(`${crypto.createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  await fs.writeFile(path.join(EVIDENCE_DIR, "sha256sums.txt"), sums.join("\n") + "\n");
  console.log(`Evidence directory: ${EVIDENCE_DIR}`);
  console.log(`Published verifier chain check: PASS (${originalLines.length} receipts); tampered check: REJECTED as expected.`);
  return { receipts: originalLines.length, evidenceDir: EVIDENCE_DIR };
}

async function main() {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strix-github-reference-"));
  const storePath = path.join(runtimeRoot, "proxy-store");
  const guardHome = path.join(runtimeRoot, "guard-home");
  const guardEnv = { ...process.env, STRIX_GUARD_HOME: guardHome };
  const guardPathSet = guardPaths(guardHome);
  const approver = await createApproverKey({
    passphrase: PASS_PHRASE,
    label: APPROVER_LABEL,
    env: guardEnv,
  });
  const guardConfig = buildProxyConfig({
    serverId: "github",
    entry: { command: "@modelcontextprotocol/server-github", args: [] },
    paths: { ...guardPathSet, receiptsDir: path.join(runtimeRoot, "guard-receipts") },
    approver,
  });
  assert.equal(guardConfig.policy.riskOverrides.LOW, "ALLOW");
  assert.equal(guardConfig.policy.default, "APPROVAL_REQUIRED");
  guardConfig.approval.timeoutMs = APPROVAL_TIMEOUT_MS;
  guardConfig.approval.pollIntervalMs = POLL_INTERVAL_MS;
  guardConfig.approval.requestDir = guardPathSet.approvalsDir;

  let firstKid;
  let lastKid;
  let initial;
  try {
    // GH-01/02/08: use Guard's GitHub pack and the published proxy/gateway.
    initial = await buildFixtureStack({
      policy: {
        rules: {
          "mcp.github.get_file_contents": "ALLOW",
          "mcp.github.merge_pull_request": "DENY",
        },
        default: "DENY",
      },
      storagePath: storePath,
    });
    const readResult = await initial.consumer.callTool({
      name: "get_file_contents",
      arguments: { owner: FIXTURE_OWNER, repo: FIXTURE_REPO, path: "README.md", ref: "main" },
      _meta: { strix_actor_id: TEST_ACTOR, strix_actor_role: "demo" },
    });
    assert.match(readResult.content?.[0]?.text ?? "", /FIXTURE README/);
    assert.equal(fixtureExecutions.filter((x) => x.name === "get_file_contents").length, 1);
    record("GH-01", "PASS_FIXTURE_ONLY", "published proxy allowed a read and returned local fixture contents");

    const mergeArgs = { owner: FIXTURE_OWNER, repo: FIXTURE_REPO, pull_number: 47, merge_method: "squash" };
    await expectDenied(initial.consumer.callTool({ name: "merge_pull_request", arguments: mergeArgs }), "GH-02 merge");
    assert.equal(fixtureExecutions.filter((x) => x.name === "merge_pull_request").length, 0);
    record("GH-02", "PASS_INTERCEPTED", "explicit DENY; signed proxy receipt emitted; zero fake-upstream merge invocations");

    await expectDenied(initial.consumer.callTool({
      name: "delete_repository",
      arguments: { owner: FIXTURE_OWNER, repo: FIXTURE_REPO },
    }), "GH-08 unclassified delete");
    assert.equal(fixtureExecutions.filter((x) => x.name === "delete_repository").length, 0);
    record("GH-08", "PASS_INTERCEPTED", "unclassified destructive tool denied by default; zero fake-upstream calls");
    firstKid = initial.handle.signingKey.kid;
    await initial.close();
    initial = null;

    // GH-03/05/06/07: signed Guard file approvals, still fixture-only.
    let gated = await buildFixtureStack({
      policy: guardConfig.policy,
      approval: guardConfig.approval,
      storagePath: storePath,
    });
    const baselineMergeArgs = { owner: FIXTURE_OWNER, repo: FIXTURE_REPO, pull_number: 47, merge_method: "squash" };
    const mergePending = gated.consumer.callTool({ name: "merge_pull_request", arguments: baselineMergeArgs });
    const [mergeRequestId] = await waitForRequests(guardEnv, 1);
    const mergeRequest = await readRequest(guardEnv, mergeRequestId);
    assert.equal(mergeRequest.capability.id, "mcp.github.merge_pull_request");
    assert.deepEqual(mergeRequest.invocation.args, baselineMergeArgs);
    assert.equal(fixtureExecutions.filter((x) => x.name === "merge_pull_request").length, 0);
    await denyRequest(guardEnv, mergeRequestId);
    await expectDenied(mergePending, "GH-03 denied pending merge");
    await markApprovalConsumed(guardEnv, mergeRequestId, "DENIED_BEFORE_DISPATCH");
    record("GH-03", "PASS_HELD_AND_DENIED", "exact owner/repo/PR/method request was held; zero merge invocations; synthetic reviewer denied it");

    const changedMergeRequests = [
      { ...baselineMergeArgs, repo: "different-fixture" },
      { ...baselineMergeArgs, pull_number: 48 },
      { ...baselineMergeArgs, merge_method: "rebase" },
    ];
    let changedRequestIds = [];
    for (const changedArgs of changedMergeRequests) {
      const pending = gated.consumer.callTool({ name: "merge_pull_request", arguments: changedArgs });
      const [requestId] = await waitForRequests(guardEnv, 1);
      const request = await readRequest(guardEnv, requestId);
      assert.deepEqual(request.invocation.args, changedArgs);
      assert.notEqual(requestId, mergeRequestId);
      changedRequestIds.push(requestId);
      await denyRequest(guardEnv, requestId, "CHANGED_PAYLOAD_REQUIRES_NEW_DECISION");
      await expectDenied(pending, "GH-05 changed merge request");
      await markApprovalConsumed(guardEnv, requestId, "DENIED_BEFORE_DISPATCH");
    }
    assert.equal(fixtureExecutions.filter((x) => x.name === "merge_pull_request").length, 0);
    record("GH-05", "PARTIAL_BLOCKED", "changed repo/PR/method calls obtained fresh request IDs; official tool has no target-branch/head-SHA argument and no integrated execution grant");

    const branchArgs = {
      owner: FIXTURE_OWNER,
      repo: FIXTURE_REPO,
      branch: "demo-only/created-once",
      from_branch: "main",
    };
    const branchPending = gated.consumer.callTool({ name: "create_branch", arguments: branchArgs });
    const [branchRequestId] = await waitForRequests(guardEnv, 1);
    const branchRequest = await readRequest(guardEnv, branchRequestId);
    assert.equal(branchRequest.capability.id, "mcp.github.create_branch");
    await approveRequest(guardEnv, branchRequestId);
    const branchResult = await branchPending;
    await markApprovalConsumed(guardEnv, branchRequestId, "APPROVED_AND_FIXTURE_DISPATCHED");
    assert.match(branchResult.content?.[0]?.text ?? "", /FIXTURE_WRITE_SUCCEEDED/);
    const afterOneBranch = fixtureExecutions.filter((x) => x.name === "create_branch").length;
    assert.equal(afterOneBranch, 1);
    record("GH-06", "PARTIAL_APPROVAL_FILE_LAYER", "one exact signed Guard approval released one in-memory create_branch fixture call; fixture outcome only");

    const replayPending = gated.consumer.callTool({ name: "create_branch", arguments: branchArgs });
    const [replayRequestId] = await waitForRequests(guardEnv, 1);
    assert.notEqual(replayRequestId, branchRequestId);
    assert.equal(fixtureExecutions.filter((x) => x.name === "create_branch").length, afterOneBranch);
    await denyRequest(guardEnv, replayRequestId, "REPLAY_REQUIRES_NEW_APPROVAL");
    await expectDenied(replayPending, "GH-06 replay request");
    await markApprovalConsumed(guardEnv, replayRequestId, "DENIED_REPLAY_REQUIRES_NEW_APPROVAL");
    assert.equal(fixtureExecutions.filter((x) => x.name === "create_branch").length, afterOneBranch);

    const raceArgs = { ...branchArgs, branch: "demo-only/race" };
    const beforeRace = fixtureExecutions.filter((x) => x.name === "create_branch").length;
    const raceOne = gated.consumer.callTool({ name: "create_branch", arguments: raceArgs });
    const raceTwo = gated.consumer.callTool({ name: "create_branch", arguments: raceArgs });
    const raceIds = await waitForRequests(guardEnv, 2);
    assert.equal(new Set(raceIds).size, 2, "Concurrent requests must have distinct request IDs");
    await Promise.all([
      approveRequest(guardEnv, raceIds[0]),
      denyRequest(guardEnv, raceIds[1], "ONLY_ONE_SYNTHETIC_APPROVAL"),
    ]);
    const raceOutcomes = await Promise.all([waitSettled(raceOne), waitSettled(raceTwo)]);
    assert.equal(raceOutcomes.filter((x) => x.state === "fulfilled").length, 1);
    assert.equal(fixtureExecutions.filter((x) => x.name === "create_branch").length - beforeRace, 1);
    await markApprovalConsumed(guardEnv, raceIds[0], "APPROVED_AND_FIXTURE_DISPATCHED");
    await markApprovalConsumed(guardEnv, raceIds[1], "DENIED_BEFORE_DISPATCH");
    record("GH-07", "PARTIAL_APPROVAL_FILE_LAYER", "two concurrent fixture calls received distinct signed-approval request IDs; one approved, one denied, exactly one fixture invocation");
    lastKid = gated.handle.signingKey.kid;
    await gated.close();
    gated = null;

    // GH-09: invalid policy fails before a call can be dispatched.
    let invalidPolicyStack;
    let invalidPolicyRejected = false;
    try {
      invalidPolicyStack = await buildFixtureStack({
        policy: { rules: {}, default: "NOT_A_POLICY_DECISION" },
        storagePath: storePath,
      });
    } catch {
      invalidPolicyRejected = true;
    } finally {
      if (invalidPolicyStack) await invalidPolicyStack.close();
    }
    assert.ok(invalidPolicyRejected, "Invalid policy must fail closed at proxy startup");
    record("GH-09-policy", "PASS_FAIL_CLOSED", "invalid policy rejected at startup before downstream dispatch");

    const blockedApprovalPath = path.join(runtimeRoot, "not-a-directory");
    await fs.writeFile(blockedApprovalPath, "not a directory");
    const failedStoreConfig = {
      ...guardConfig.approval,
      requestDir: blockedApprovalPath,
      timeoutMs: 200,
      pollIntervalMs: POLL_INTERVAL_MS,
    };
    const failedStore = await buildFixtureStack({
      policy: { default: "APPROVAL_REQUIRED" },
      approval: failedStoreConfig,
      storagePath: storePath,
    });
    try {
      await expectDenied(failedStore.consumer.callTool({
        name: "create_branch",
        arguments: { ...branchArgs, branch: "demo-only/store-unavailable" },
      }), "GH-09 unavailable approval store");
      assert.equal(fixtureExecutions.filter((x) => x.args?.branch === "demo-only/store-unavailable").length, 0);
    } finally {
      await failedStore.close();
    }
    record("GH-09-approval-store", "PASS_FAIL_CLOSED", "unwritable approval request path refused the call before the fixture handler");
    record("GH-09-gateway", "NOT_APPLICABLE_TO_LOCAL_TOPOLOGY", "the gateway executes in-process; this architecture has no separate remote gateway service to disconnect");

    // GH-11 restart: re-open the same receipt store and key, then read again.
    const restarted = await buildFixtureStack({
      policy: { rules: { "mcp.github.get_file_contents": "ALLOW" }, default: "DENY" },
      storagePath: storePath,
    });
    try {
      const restartRead = await restarted.consumer.callTool({
        name: "get_file_contents",
        arguments: { owner: FIXTURE_OWNER, repo: FIXTURE_REPO, path: "README.md", ref: "main" },
      });
      assert.match(restartRead.content?.[0]?.text ?? "", /FIXTURE README/);
      lastKid = restarted.handle.signingKey.kid;
    } finally {
      await restarted.close();
    }
    record("GH-11", "PASS_LOCAL_PERSISTENCE", "proxy restarted with the same storage and key; earlier receipts were retained for independent verification");

    // GH-12 direct-route limitation: bypass only the local fixture proxy.
    const direct = await buildFixtureStack({ policy: { default: "DENY" }, storagePath: storePath });
    try {
      const receiptCountBefore = direct.receipts.length;
      const beforeDirect = fixtureExecutions.length;
      await direct.upstreamClient.callTool({
        name: "merge_pull_request",
        arguments: { owner: FIXTURE_OWNER, repo: FIXTURE_REPO, pull_number: 47, merge_method: "squash" },
      });
      assert.equal(fixtureExecutions.length, beforeDirect + 1);
      assert.equal(direct.receipts.length, receiptCountBefore);
    } finally {
      await direct.close();
    }
    record("GH-12", "LIMITATION_DEMONSTRATED", "direct test client invoked the in-memory upstream without a proxy receipt; no credentials or live route exist in this test estate");

    record("GH-04", "BLOCKED", "no merge was approved or executed: published MCP mode 3 is unwired, PEP is reference-only, and the official merge surface lacks an atomic full-head-SHA parameter");
    assert.equal(fixtureExecutions.filter((x) => x.name === "merge_pull_request").length, 1,
      "The only merge fixture invocation should be the explicit GH-12 direct-route coverage demonstration");

    const files = await walkFiles(storePath);
    const receiptFile = files.find((file) => path.basename(file) === "receipts.jsonl");
    assert.ok(receiptFile);
    const receiptRows = (await fs.readFile(receiptFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(receiptRows.length >= 6, `Expected several signed receipt records, got ${receiptRows.length}`);
    assert.ok(receiptRows.every((row) => row.signature), "Every stored proxy receipt must have a signature");
    await writeEvidenceFiles({
      storagePath: storePath,
      firstKid,
      lastKid,
      policyBundle: {
        explicitDeny: {
          rules: { "mcp.github.get_file_contents": "ALLOW", "mcp.github.merge_pull_request": "DENY" },
          default: "DENY",
        },
        guardApproval: guardConfig.policy,
      },
    });
    record("GH-10", "PASS_TAMPER_DETECTED", "published verifier 1.24.1 accepted the intact chain and rejected the altered signature");
  } finally {
    if (initial) await initial.close();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }

  const summary = {
    completeAcceptance: false,
    releaseReady: false,
    scenarioCount: scenarioResults.length,
    results: scenarioResults,
    evidenceDir: EVIDENCE_DIR,
    executionBoundary: "All upstream operations were in-memory synthetic fixtures. No real GitHub merge or API operation occurred.",
  };
  await fs.writeFile(path.join(EVIDENCE_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(EVIDENCE_DIR, "scenario-results.json"), `${JSON.stringify({
    completeAcceptance: false,
    releaseReady: false,
    scenarios: scenarioResults,
    blockers: [
      "Published MCP proxy does not wire Mode-3 execution authorization.",
      "The GitHub merge PEP is source-reference-only and has no production caller.",
      "Official GitHub MCP merge input lacks an atomic head-SHA precondition.",
      "Current published verifier is 1.24.1; repository candidate 1.24.2 is unpublished.",
      "Gateway is in-process; a separate service outage is not applicable to this demo topology.",
    ],
  }, null, 2)}\n`);
  const finalEvidenceFiles = (await fs.readdir(EVIDENCE_DIR)).filter((name) => name !== "sha256sums.txt").sort();
  const finalSums = [];
  for (const name of finalEvidenceFiles) {
    const bytes = await fs.readFile(path.join(EVIDENCE_DIR, name));
    finalSums.push(`${crypto.createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  await fs.writeFile(path.join(EVIDENCE_DIR, "sha256sums.txt"), finalSums.join("\n") + "\n");
  console.log(`Summary: ${EVIDENCE_DIR}/summary.json`);
  console.log("FULL ACCEPTANCE: BLOCKED — this fixture verifies only the existing published Mode-1/2 proxy path.");
}

await main();
