/**
 * strix-guard pending/approve/deny — the human side of the file-approver
 * contract. Pins: listing reads request files, approve/deny write the
 * response shape the gateway's fileApprover consumes, vanished requests
 * error (never a retroactive approval), request-id input is validated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { listPending, respond } from "../src/approvals.mjs";
import { guardPaths } from "../src/paths.mjs";

const REQUEST_ID = "a1b2c3d4e5f60718a1b2c3d4e5f60718";

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strix-guard-appr-"));
  const home = path.join(dir, "guard-home");
  const paths = guardPaths(home);
  await fs.mkdir(paths.approvalsDir, { recursive: true });
  await fs.writeFile(
    path.join(paths.approvalsDir, `${REQUEST_ID}.request.json`),
    JSON.stringify({
      requestId: REQUEST_ID,
      requestedAt: "2026-07-06T12:00:00.000Z",
      capability: { id: "notion.pages.create", risk: "MEDIUM" },
      invocation: { capabilityId: "notion.pages.create", action: "call", args: { title: "x" } },
    }),
  );
  return { dir, paths, env: { STRIX_GUARD_HOME: home } };
}

test("listPending surfaces waiting requests", async () => {
  const f = await fixture();
  try {
    const pending = await listPending({ env: f.env });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].requestId, REQUEST_ID);
    assert.equal(pending[0].capabilityId, "notion.pages.create");
    assert.equal(pending[0].risk, "MEDIUM");
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test("approve writes the fileApprover response shape", async () => {
  const f = await fixture();
  try {
    const result = await respond(REQUEST_ID, { approved: true, by: "alice", env: f.env });
    assert.equal(result.approved, true);
    const resp = JSON.parse(
      await fs.readFile(path.join(f.paths.approvalsDir, `${REQUEST_ID}.response.json`), "utf8"),
    );
    assert.deepEqual(resp, { approved: true, approvedBy: "alice", reason: "USER_APPROVED" });
    // First-approval activation moment recorded, local only.
    const state = JSON.parse(await fs.readFile(f.paths.statePath, "utf8"));
    assert.ok(state.firstApprovalAt);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test("deny writes approved:false", async () => {
  const f = await fixture();
  try {
    await respond(REQUEST_ID, { approved: false, by: "bob", env: f.env });
    const resp = JSON.parse(
      await fs.readFile(path.join(f.paths.approvalsDir, `${REQUEST_ID}.response.json`), "utf8"),
    );
    assert.equal(resp.approved, false);
    assert.equal(resp.reason, "USER_DENIED");
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test("responding to a vanished request errors — never a retroactive approval", async () => {
  const f = await fixture();
  try {
    const gone = "0123456789abcdef0123456789abcdef";
    await assert.rejects(
      () => respond(gone, { approved: true, env: f.env }),
      /no pending request/,
    );
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test("request-id input is validated (no path traversal via id)", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => respond("../../etc/passwd", { approved: true, env: f.env }),
      /does not look like a request id/,
    );
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});
