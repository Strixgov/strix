/**
 * Unit tests for shadow discovery (GSD-1 Phase 4) — the runtime
 * reconciliation layer over static governed-surface discovery.
 *
 * The two honesty rules under test:
 *   1. Observation only — the recorder never throws into the call path.
 *   2. Unsigned measurement, never proof — every snapshot and every log
 *      line carries the disclaimer and nothing receipt-shaped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createShadowDiscovery,
  SHADOW_LOG_BASENAME,
  SHADOW_MEASUREMENT_DISCLAIMER,
} from "../src/shadow-discovery.mjs";

const CAPS = [
  { id: "mcp.demo.read_thing", name: "read_thing", risk: "LOW", mode: "READ" },
  { id: "mcp.demo.write_thing", name: "write_thing", risk: "MEDIUM", mode: "WRITE" },
];

test("advertised tools split into classified vs unclassified", () => {
  const shadow = createShadowDiscovery({ serverId: "demo", capabilities: CAPS });
  shadow.recordToolList([
    { name: "read_thing", description: "classified" },
    { name: "write_thing", description: "classified" },
    { name: "mystery_tool", description: "nobody classified this" },
  ]);
  const snap = shadow.snapshot();
  assert.equal(snap.advertisedToolCount, 3);
  assert.equal(snap.classifiedCapabilityCount, 2);
  assert.deepEqual(snap.unclassifiedAdvertised, ["mystery_tool"]);
});

test("calls are counted; unclassified calls surface separately", () => {
  const shadow = createShadowDiscovery({ serverId: "demo", capabilities: CAPS });
  shadow.recordCall("read_thing");
  shadow.recordCall("read_thing");
  shadow.recordCall("mystery_tool");
  const snap = shadow.snapshot();
  assert.deepEqual(snap.callCounts, { read_thing: 2, mystery_tool: 1 });
  assert.deepEqual(snap.unclassifiedCallCounts, { mystery_tool: 1 });
});

test("audit events fire once per unclassified tool, not per call", () => {
  const events = [];
  const shadow = createShadowDiscovery({
    serverId: "demo",
    capabilities: CAPS,
    onAudit: (e) => events.push(e),
  });
  shadow.recordCall("mystery_tool");
  shadow.recordCall("mystery_tool");
  shadow.recordCall("mystery_tool");
  const unclassified = events.filter((e) => e.kind === "shadow.unclassified-call");
  assert.equal(unclassified.length, 1);
  assert.equal(unclassified[0].detail.tool, "mystery_tool");
});

test("every snapshot carries the measurement disclaimer and nothing receipt-shaped", () => {
  const shadow = createShadowDiscovery({ serverId: "demo", capabilities: CAPS });
  shadow.recordCall("mystery_tool");
  const snap = shadow.snapshot();
  assert.equal(snap.measurement, SHADOW_MEASUREMENT_DISCLAIMER);
  for (const forbidden of ["signature", "signingKeyId", "kid", "canonical", "receiptId"]) {
    assert.equal(forbidden in snap, false, `snapshot must not carry ${forbidden}`);
  }
});

test("JSONL shadow log is written under storagePath with the disclaimer on every line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strix-shadow-test-"));
  const shadow = createShadowDiscovery({
    serverId: "demo",
    capabilities: CAPS,
    storagePath: dir,
    now: () => "2026-07-12T00:00:00.000Z",
  });
  shadow.recordToolList([{ name: "mystery_tool" }]);
  shadow.recordCall("mystery_tool");

  assert.equal(shadow.logPath, path.join(dir, SHADOW_LOG_BASENAME));
  const lines = (await fs.readFile(shadow.logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  const parsed = lines.map((l) => JSON.parse(l));
  for (const entry of parsed) {
    assert.equal(entry.measurement, SHADOW_MEASUREMENT_DISCLAIMER);
    assert.equal(entry.serverId, "demo");
    assert.equal(entry.at, "2026-07-12T00:00:00.000Z");
  }
  assert.equal(parsed[0].kind, "tool-list");
  assert.deepEqual(parsed[0].unclassified, ["mystery_tool"]);
  assert.equal(parsed[1].kind, "unclassified-call");
  assert.equal(parsed[1].tool, "mystery_tool");

  await fs.rm(dir, { recursive: true, force: true });
});

test("no storagePath → no log file, snapshot still works", () => {
  const shadow = createShadowDiscovery({ serverId: "demo", capabilities: CAPS });
  assert.equal(shadow.logPath, null);
  shadow.recordCall("mystery_tool");
  assert.equal(shadow.snapshot().unclassifiedCallCounts.mystery_tool, 1);
});

test("recorder is defensive: malformed input never throws", () => {
  const shadow = createShadowDiscovery({ serverId: "demo" });
  shadow.recordToolList(undefined);
  shadow.recordToolList([{ notAName: true }, null, { name: "" }]);
  shadow.recordCall(undefined);
  shadow.recordCall("");
  shadow.recordCall(42);
  const snap = shadow.snapshot();
  assert.equal(snap.advertisedToolCount, 0);
  assert.deepEqual(snap.callCounts, {});
});

test("a throwing onAudit handler never propagates into the call path", () => {
  const shadow = createShadowDiscovery({
    serverId: "demo",
    onAudit: () => {
      throw new Error("audit handler bug");
    },
  });
  assert.doesNotThrow(() => shadow.recordCall("mystery_tool"));
});

test("no capabilities configured → every tool reports unclassified", () => {
  const shadow = createShadowDiscovery({ serverId: "demo" });
  shadow.recordToolList([{ name: "a" }, { name: "b" }]);
  assert.deepEqual(shadow.snapshot().unclassifiedAdvertised, ["a", "b"]);
});
