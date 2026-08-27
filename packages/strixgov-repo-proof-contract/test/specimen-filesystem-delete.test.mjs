/**
 * Second specimen — same pinned subject, an effect it ACTUALLY has.
 *
 * The first specimen's manifest had zero relevant paths, so RPF-2's planted
 * test ran against an empty set. This one carries 534 real enumerated sites,
 * which is where the rule has to work: a bypass hides among real data, not in
 * an empty list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateManifest, REFUSAL } from "../src/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = () =>
  JSON.parse(readFileSync(resolve(HERE, "../examples/openclaw-a99317ef-filesystem-delete.manifest.json"), "utf-8"));

test("the populated manifest validates", () => {
  const m = load();
  assert.equal(m.paths.relevant.length, 534, "enumeration must be complete, not sampled");
  assert.equal(m.paths.ungoverned.length, 534);
  assert.equal(m.paths.governed.length, 0);
  assert.equal(validateManifest(m).valid, true);
});

test("RPF-2: 533 of 534 — dropping ONE disclosed path is REFUSED", () => {
  // The realistic shape. Not an obviously empty bypass list: a manifest that
  // enumerates almost everything, with the one reachable path that matters
  // quietly absent. This is how a real bypass would look.
  const m = load();
  const dropped = m.paths.ungoverned.pop();
  const r = validateManifest(m);
  assert.equal(r.valid, false, "a 533-of-534 enumeration must not read as complete");
  const hit = r.refusals.find((x) => x.code === REFUSAL.UNDISCLOSED_PATH);
  assert.ok(hit, "expected RPF-2 refusal");
  assert.ok(hit.detail.includes(dropped.path), "the refusal must name the omitted path, not just count");
});

test("RPF-2: planting an undisclosed path AMONG real data is REFUSED and named", () => {
  const m = load();
  m.paths.relevant.push({
    path: "src/gateway/worker-environments/undisclosed-purge.ts:1",
    reason: "planted among 534 real sites",
    capabilityId: "filesystem.delete",
  });
  const r = validateManifest(m);
  assert.equal(r.valid, false);
  assert.match(
    r.refusals.find((x) => x.code === REFUSAL.UNDISCLOSED_PATH).detail,
    /undisclosed-purge\.ts/,
  );
});

test("the three namespaces stay separate when only ONE of them is populated", () => {
  // Discovery is real (534); governed effect and enforcement action are both
  // null. A collapsing model would have had to invent one of the two.
  const e = load().capabilityReconciliation[0];
  assert.equal(e.discoverySignal.namespace, "gsd1");
  assert.equal(e.discoverySignal.occurrences, 534);
  assert.equal(e.governedEffect, null);
  assert.equal(e.enforcementAction, null);
  assert.equal(e.disposition, "unresolved");
});

test("anti-aliasing: the plausible kernel match must not be assertable as derived+exact", () => {
  // filesystem.delete vs the kernel's 7 business-domain *_delete actions is a
  // more dangerous alias than the email case, because BOTH sides exist.
  const m = load();
  m.capabilityReconciliation[0] = {
    ...m.capabilityReconciliation[0],
    enforcementAction: { namespace: "governed-action-types", id: "vault_item_delete" },
    disposition: "exact",
    provenance: "derived",
  };
  assert.ok(validateManifest(m).refusals.map((x) => x.code).includes(REFUSAL.DERIVED_EXACT));
});

test("claim ceiling stays below governed execution while nothing is governed", () => {
  const m = load();
  assert.equal(m.paths.governed.length, 0);
  assert.ok(m.claimCeiling.rung <= 1, "no governed path can support a governed-execution rung");
  assert.ok(m.claimCeiling.barred.some((b) => /governs filesystem deletion/i.test(b)));
});

test("every attack result is NOT_ESTABLISHED, never PASSED, with nothing governed", () => {
  for (const a of load().attackApplicability) {
    assert.equal(a.applicable, false);
    assert.equal(a.result, "NOT_ESTABLISHED");
  }
});
