/**
 * Contract tests. The load-bearing one is the planted-undisclosed-path proof:
 * W0-A's critical test is not that a good manifest validates, but that a
 * manifest which LOOKS complete and is not gets refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateManifest, REFUSAL } from "../src/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = () =>
  JSON.parse(readFileSync(resolve(HERE, "../examples/openclaw-a99317ef.manifest.json"), "utf-8"));

test("the real pinned-subject manifest validates", () => {
  const r = validateManifest(load());
  assert.equal(r.valid, true, JSON.stringify(r.refusals));
});

test("RPF-2: a planted undisclosed relevant path is REFUSED", () => {
  const m = load();
  // The manifest claims its ungoverned set is enumerated. Introduce a relevant
  // path that is disclosed in neither governed nor ungoverned — exactly the
  // shape of an integration that governs the documented path while an
  // undocumented one stays open.
  m.paths.relevant.push({
    path: "apps/server/src/outbound/undisclosed-sender.ts",
    reason: "planted by the W0-A critical test",
    capabilityId: "email.send",
  });
  const r = validateManifest(m);
  assert.equal(r.valid, false, "a manifest hiding a relevant path must not validate");
  const codes = r.refusals.map((x) => x.code);
  assert.ok(codes.includes(REFUSAL.UNDISCLOSED_PATH), `expected RPF-2 refusal, got ${codes.join(",")}`);
  assert.match(r.refusals.find((x) => x.code === REFUSAL.UNDISCLOSED_PATH).detail, /undisclosed-sender\.ts/);
});

test("RPF-2: disclosing the same path as ungoverned makes it valid again", () => {
  const m = load();
  const p = { path: "apps/server/src/outbound/undisclosed-sender.ts", reason: "planted", capabilityId: "email.send" };
  m.paths.relevant.push(p);
  m.paths.ungoverned.push({ ...p, reason: "disclosed: reachable and not governed" });
  assert.equal(validateManifest(m).valid, true);
});

test("RPF-2: 'enumerated' without derivedFrom is REFUSED", () => {
  const m = load();
  delete m.paths.ungovernedCompleteness.derivedFrom;
  const r = validateManifest(m);
  assert.ok(r.refusals.map((x) => x.code).includes(REFUSAL.COMPLETENESS_UNSUPPORTED));
});

test("RPF-2: 'not-established' never renders as complete coverage, and does not gate", () => {
  const m = load();
  m.paths.ungovernedCompleteness = { state: "not-established" };
  m.paths.relevant.push({ path: "x.ts", reason: "undisclosed but completeness not claimed" });
  // Honest non-claim is permitted; it simply cannot be read as enumeration.
  assert.equal(validateManifest(m).valid, true);
});

test("Acceptance 2: a tag or short SHA is not identity", () => {
  for (const bad of ["v2026.1", "a99317e", "main", ""]) {
    const m = load();
    m.subject.commitSha = bad;
    const r = validateManifest(m);
    assert.equal(r.valid, false, `'${bad}' must not be accepted as identity`);
    assert.ok(r.refusals.map((x) => x.code).includes(REFUSAL.SUBJECT_NOT_PINNED));
  }
});

test("Acceptance 2: a bare project name is not a resolvable origin", () => {
  const m = load();
  m.subject.origin = "openclaw";
  assert.ok(validateManifest(m).refusals.map((x) => x.code).includes(REFUSAL.SUBJECT_ORIGIN));
});

test("§9.3: a derived mapping may not be asserted 'exact' (anti-aliasing)", () => {
  const m = load();
  m.capabilityReconciliation[0] = {
    discoverySignal: { namespace: "gsd1", id: "email.send", occurrences: 3 },
    governedEffect: { namespace: "specimen-declared", id: "communication.email.send" },
    enforcementAction: null,
    disposition: "exact",
    provenance: "derived",
  };
  const r = validateManifest(m);
  assert.equal(r.valid, false, "nearest-name matching must not become a governed-effect claim");
  assert.ok(r.refusals.map((x) => x.code).includes(REFUSAL.DERIVED_EXACT));
});

test("§9.3: the same mapping is permitted once a human has reviewed it", () => {
  const m = load();
  m.capabilityReconciliation[0] = {
    discoverySignal: { namespace: "gsd1", id: "email.send", occurrences: 3 },
    governedEffect: { namespace: "specimen-declared", id: "communication.email.send" },
    enforcementAction: null,
    disposition: "exact",
    provenance: "manually-reviewed",
  };
  assert.equal(validateManifest(m).valid, true);
});

test("§9.3: the three namespaces stay separate — no collapsed single id", () => {
  const e = load().capabilityReconciliation[0];
  for (const k of ["discoverySignal", "governedEffect", "enforcementAction"]) {
    assert.ok(k in e, `${k} must be present even when null`);
  }
  assert.ok(e.governedEffect.namespace, "an id is always namespaced, never bare");
});

test("RPF-3: an in-process hook may not be declared unbypassable", () => {
  const m = load();
  m.enforcementBoundary = { kind: "in-process-hook", description: "x", unbypassableClaimed: true };
  assert.ok(validateManifest(m).refusals.map((x) => x.code).includes(REFUSAL.HOOK_UNBYPASSABLE));
});

test("validation reports refusals and never repairs the manifest", () => {
  const m = load();
  m.paths.relevant.push({ path: "z.ts", reason: "planted" });
  const before = JSON.stringify(m);
  validateManifest(m);
  assert.equal(JSON.stringify(m), before, "the validator must not mutate its input");
});
