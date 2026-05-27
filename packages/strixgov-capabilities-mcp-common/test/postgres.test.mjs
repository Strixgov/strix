/**
 * Postgres pack — risk classification invariants.
 *
 * Postgres is the highest-stakes wrap in the bundle: reads can
 * exfiltrate sensitive data en masse, writes are usually irreversible,
 * and DDL has broad blast radius. The pack is intentionally
 * conservative — every Postgres op is at least MEDIUM. This test
 * pins the risk model documented in `src/postgres.mjs` so any future
 * re-classification has to be deliberate.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { postgresCapabilities } from "../src/postgres.mjs";

const byName = new Map(postgresCapabilities.map((c) => [c.name, c]));

test("every classification has the canonical shape", () => {
  for (const cap of postgresCapabilities) {
    assert.match(cap.id, /^mcp\.postgres\./);
    assert.equal(typeof cap.name, "string");
    assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(cap.risk));
    assert.ok(["READ", "WRITE", "EXECUTE"].includes(cap.mode));
    assert.equal(typeof cap.description, "string");
    assert.ok(cap.description.length > 0);
  }
});

test("schema introspection (list_tables / list_schemas / describe_table / list_indexes) is LOW READ", () => {
  // Schema metadata is the one Postgres surface that's reasonably
  // safe to auto-allow — it's structural, not row-data.
  const lowReads = ["list_tables", "list_schemas", "describe_table", "list_indexes"];
  for (const name of lowReads) {
    const cap = byName.get(name);
    assert.ok(cap, `expected pack to classify '${name}'`);
    assert.equal(cap.mode, "READ", `${name} mode`);
    assert.equal(cap.risk, "LOW", `${name} risk`);
  }
});

test("query / read_query / explain_query are MEDIUM READ (exfiltration risk)", () => {
  // Rationale: SELECT against a production DB is the most common
  // privacy-incident vector. Pinning MEDIUM here protects against
  // well-intentioned drift toward LOW that would auto-allow agent
  // reads of arbitrary tables.
  for (const name of ["query", "read_query", "explain_query"]) {
    const cap = byName.get(name);
    assert.ok(cap, `expected pack to classify '${name}'`);
    assert.equal(cap.mode, "READ", `${name} mode`);
    assert.equal(cap.risk, "MEDIUM", `${name} risk`);
  }
});

test("write_query / insert / update / delete are HIGH WRITE", () => {
  for (const name of ["write_query", "insert", "update", "delete"]) {
    const cap = byName.get(name);
    assert.ok(cap, `expected pack to classify '${name}'`);
    assert.equal(cap.mode, "WRITE", `${name} mode`);
    assert.equal(cap.risk, "HIGH", `${name} risk`);
  }
});

test("DDL — create_table / alter_table are HIGH WRITE", () => {
  for (const name of ["create_table", "alter_table"]) {
    const cap = byName.get(name);
    assert.ok(cap, `expected pack to classify '${name}'`);
    assert.equal(cap.mode, "WRITE", `${name} mode`);
    assert.equal(cap.risk, "HIGH", `${name} risk`);
  }
});

test("drop / truncate / arbitrary-SQL ops are intentionally absent — heuristic must catch them", () => {
  // Discipline: the reference server gates drop/truncate behind
  // operator config. If your fork exposes them, the heuristic in
  // @strixgov/tool-gateway classifies drop_* / destroy_* / truncate_*
  // as CRITICAL WRITE and the fail-closed default DENYs them.
  // Classifying them at HIGH (or worse, MEDIUM) in the pack would
  // silently weaken the default deployment posture.
  const destructive = postgresCapabilities.filter((c) =>
    /(^|\.|_)(drop|destroy|truncate|wipe|purge)/i.test(c.name),
  );
  assert.equal(
    destructive.length,
    0,
    "postgres pack must not classify drop/truncate ops — they belong at CRITICAL via heuristic",
  );
});

test("arbitrary SQL execution is intentionally absent — too dangerous to classify a priori", () => {
  // Any tool that accepts a raw SQL string is unclassifiable in
  // advance — the SQL itself determines the risk. Operators wrapping
  // such a surface must either gate it at the application level or
  // explicitly classify it CRITICAL in their policy.
  const arbitrary = postgresCapabilities.filter((c) =>
    /execute_arbitrary|run_sql|exec_sql|raw_query/i.test(c.name),
  );
  assert.equal(
    arbitrary.length,
    0,
    "postgres pack must not classify arbitrary-SQL ops — operators classify them per deployment",
  );
});
