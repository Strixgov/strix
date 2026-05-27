/**
 * Filesystem pack — risk classification invariants.
 *
 * The filesystem MCP is the highest-blast-radius wrap in the bundle:
 * every operation runs against the agent's persistence layer, and a
 * mis-classified write tool can clobber state with no undo path. This
 * test pins the risk model documented in `src/filesystem.mjs` so any
 * future re-classification has to be deliberate.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { filesystemCapabilities } from "../src/filesystem.mjs";

const byName = new Map(filesystemCapabilities.map((c) => [c.name, c]));

test("every classification has the canonical shape (matches registry-wide invariant)", () => {
  for (const cap of filesystemCapabilities) {
    assert.match(cap.id, /^mcp\.filesystem\./);
    assert.equal(typeof cap.name, "string");
    assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(cap.risk));
    assert.ok(["READ", "WRITE", "EXECUTE"].includes(cap.mode));
    assert.equal(typeof cap.description, "string");
    assert.ok(cap.description.length > 0);
  }
});

test("read-shaped tools are LOW READ", () => {
  const reads = [
    "read_file",
    "read_multiple_files",
    "list_directory",
    "directory_tree",
    "search_files",
    "get_file_info",
    "list_allowed_directories",
  ];
  for (const name of reads) {
    const cap = byName.get(name);
    assert.ok(cap, `expected pack to classify '${name}'`);
    assert.equal(cap.mode, "READ", `${name} must be READ`);
    assert.equal(cap.risk, "LOW", `${name} must be LOW`);
  }
});

test("write_file is MEDIUM WRITE — overwrite is operator-policy concern, not classification escalation", () => {
  // Rationale: write_file silently overwrites. Operators who need
  // strict overwrite protection elevate the rule in their policy
  // (`"mcp.filesystem.write_file": "DENY"`) rather than relying on
  // the pack to be conservative for them. Pinning this at MEDIUM
  // protects against well-intentioned drift toward HIGH that would
  // gate every agent code-write through approval.
  const cap = byName.get("write_file");
  assert.equal(cap.risk, "MEDIUM");
  assert.equal(cap.mode, "WRITE");
});

test("edit_file and create_directory are MEDIUM WRITE", () => {
  for (const name of ["edit_file", "create_directory"]) {
    const cap = byName.get(name);
    assert.equal(cap.risk, "MEDIUM", `${name} risk`);
    assert.equal(cap.mode, "WRITE", `${name} mode`);
  }
});

test("move_file is HIGH WRITE — clobber-on-collision is hard to undo", () => {
  const cap = byName.get("move_file");
  assert.equal(cap.risk, "HIGH");
  assert.equal(cap.mode, "WRITE");
});

test("delete-style ops are intentionally absent (reference server doesn't ship them) — heuristic must catch any fork that adds them", () => {
  // This is a discipline test, not a code test. The reference
  // @modelcontextprotocol/server-filesystem does not expose
  // delete_* / remove_* / unlink. If a fork adds them, the heuristic
  // in @strixgov/tool-gateway/src/adapters/mcp.mjs classifies any tool
  // starting with delete/remove/drop/destroy as CRITICAL WRITE and
  // a fail-closed policy blocks it. This test pins the explicit
  // ABSENCE so anyone adding a delete to the pack has to deliberately
  // remove this assertion and explain why in their PR.
  const deletes = filesystemCapabilities.filter((c) =>
    /(^|\.|_)(delete|remove|destroy|drop|unlink)/i.test(c.name),
  );
  assert.equal(
    deletes.length,
    0,
    "filesystem pack must not classify delete-style ops — they are heuristic-handled at CRITICAL",
  );
});

test("symlink / chmod / chown deliberately absent — same heuristic discipline as deletes", () => {
  const dangerous = filesystemCapabilities.filter((c) =>
    /(symlink|chmod|chown|sudo|exec)/i.test(c.name),
  );
  assert.equal(
    dangerous.length,
    0,
    "filesystem pack must not classify symlink/chmod/chown — they belong at CRITICAL EXECUTE via heuristic, not LOW/MEDIUM by accident",
  );
});
