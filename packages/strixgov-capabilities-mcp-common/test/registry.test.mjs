import test from "node:test";
import assert from "node:assert/strict";
import {
  slackCapabilities,
  githubCapabilities,
  linearCapabilities,
  notionCapabilities,
  filesystemCapabilities,
  postgresCapabilities,
  emailCapabilities,
  allMcpCapabilities,
  mcpCapabilityMap,
  suggestedPolicy,
  REGISTRY_NAME,
} from "../src/index.mjs";

test("registry name is mcp-common", () => {
  assert.equal(REGISTRY_NAME, "mcp-common");
});

test("each server has at least one capability", () => {
  assert.ok(slackCapabilities.length > 0);
  assert.ok(githubCapabilities.length > 0);
  assert.ok(linearCapabilities.length > 0);
  assert.ok(notionCapabilities.length > 0);
  assert.ok(filesystemCapabilities.length > 0);
  assert.ok(postgresCapabilities.length > 0);
  assert.ok(emailCapabilities.length > 0);
});

test("aggregate equals sum of parts", () => {
  assert.equal(
    allMcpCapabilities.length,
    slackCapabilities.length +
      githubCapabilities.length +
      linearCapabilities.length +
      notionCapabilities.length +
      filesystemCapabilities.length +
      postgresCapabilities.length +
      emailCapabilities.length,
  );
});

test("every capability id is namespaced and unique", () => {
  const ids = allMcpCapabilities.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate id in registry");
  for (const id of ids) {
    assert.match(id, /^mcp\.(slack|github|linear|notion|filesystem|postgres|email)\./);
  }
});

test("every capability has the canonical shape", () => {
  for (const cap of allMcpCapabilities) {
    assert.equal(typeof cap.id, "string");
    assert.equal(typeof cap.name, "string");
    assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(cap.risk));
    assert.ok(["READ", "WRITE", "EXECUTE"].includes(cap.mode));
    assert.equal(typeof cap.description, "string");
    assert.ok(cap.description.length > 0);
  }
});

test("merge_pull_request is CRITICAL — irreversibility invariant", () => {
  const merge = githubCapabilities.find(
    (c) => c.id === "mcp.github.merge_pull_request",
  );
  assert.ok(merge);
  assert.equal(merge.risk, "CRITICAL");
});

test("delete-style ops are at least HIGH", () => {
  const deletes = allMcpCapabilities.filter((c) =>
    /\.(delete|delete_)/i.test(c.id),
  );
  assert.ok(deletes.length > 0, "expected at least one delete capability");
  for (const cap of deletes) {
    assert.ok(
      ["HIGH", "CRITICAL"].includes(cap.risk),
      `${cap.id} should be HIGH or CRITICAL, got ${cap.risk}`,
    );
  }
});

test("read ops are READ-mode across the board (risk varies per blast-radius)", () => {
  // Most reads are LOW. Some packs (Postgres) deliberately classify
  // reads as MEDIUM or higher because the read itself is the
  // exfiltration vector (`SELECT * FROM users`). The shape we pin is:
  // every `read_*`/`list_*`/`get_*`/`search_*` op is READ-mode. Whether
  // it's LOW vs MEDIUM/HIGH is a per-pack risk-model choice, not a
  // registry-wide invariant.
  const reads = allMcpCapabilities.filter(
    (c) =>
      /\.(get_|list_|read_|search_|fetch|query_)/.test(c.id) ||
      /\.search$/.test(c.id) ||
      /\.fetch$/.test(c.id) ||
      /\.(query|read_query|explain_query|describe_table)$/.test(c.id),
  );
  assert.ok(reads.length > 0);
  for (const cap of reads) {
    assert.equal(cap.mode, "READ", `${cap.id} should be READ`);
  }
});

test("Postgres reads are intentionally MEDIUM (exfiltration discipline)", () => {
  // Pinned so a future re-classification has to be deliberate. The
  // rationale lives in src/postgres.mjs header.
  for (const name of ["query", "read_query", "explain_query"]) {
    const cap = postgresCapabilities.find((c) => c.name === name);
    assert.ok(cap, `expected postgres pack to classify '${name}'`);
    assert.equal(cap.risk, "MEDIUM", `${cap.name} risk`);
    assert.equal(cap.mode, "READ", `${cap.name} mode`);
  }
});

test("mcpCapabilityMap is keyed by id", () => {
  const map = mcpCapabilityMap();
  assert.equal(Object.keys(map).length, allMcpCapabilities.length);
  for (const cap of allMcpCapabilities) assert.deepEqual(map[cap.id], cap);
});

test("suggestedPolicy denies CRITICAL outright", () => {
  const policy = suggestedPolicy();
  for (const cap of allMcpCapabilities) {
    if (cap.risk === "CRITICAL") {
      assert.equal(policy.rules[cap.id], "DENY");
    }
  }
  assert.equal(policy.riskOverrides.CRITICAL, "DENY");
});

test("suggestedPolicy auto-allows LOW READs and gates everything else", () => {
  // Discipline shifted with the Postgres pack: MEDIUM/HIGH reads
  // (e.g. Postgres SELECT — exfiltration vectors) now require approval
  // by default rather than auto-allowing. Operators who want
  // LOW-like behavior for non-prod databases override per-capability.
  const policy = suggestedPolicy();
  for (const cap of allMcpCapabilities) {
    if (cap.risk === "CRITICAL") continue;
    if (cap.mode === "READ" && cap.risk === "LOW") {
      assert.equal(policy.rules[cap.id], "ALLOW", `${cap.id} (LOW READ) should be ALLOW`);
    } else {
      assert.equal(
        policy.rules[cap.id],
        "APPROVAL_REQUIRED",
        `${cap.id} (${cap.risk} ${cap.mode}) should be APPROVAL_REQUIRED`,
      );
    }
  }
});

test("suggestedPolicy gates Postgres MEDIUM reads for approval (regression-pin for the exfiltration discipline)", () => {
  const policy = suggestedPolicy();
  for (const name of ["query", "read_query", "explain_query"]) {
    const cap = postgresCapabilities.find((c) => c.name === name);
    assert.equal(
      policy.rules[cap.id],
      "APPROVAL_REQUIRED",
      `${cap.id} must NOT be auto-allowed — it's a SELECT against the connected DB`,
    );
  }
});
