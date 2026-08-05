// @strixgov/trust-mark-embed — pure verdict-reduce + render tests.
// The custom element shell (DOM) is not exercised here; the load-bearing logic
// (route response → badge state → label) is, including never-fake-GREEN.

import test from "node:test";
import assert from "node:assert/strict";
import { reduceTrustMarkResponse, fetchTrustMarkState } from "../src/badge.mjs";
import { render, badgeLabel } from "../src/templates.mjs";

const GREEN_BODY = {
  schemaVersion: "trust_mark_grant_status_v1",
  grantId: "tm-grant-0001",
  verification_status: "VERIFIED",
  verification_reason: "tm1_ok",
  lifecycle: "ACTIVE",
  coverage: "PASS",
  coverage_reason: "COVERAGE_OK",
  badge: "GREEN",
  payload: { mark_class: "governed_agent", surface_origin: "https://app.example" },
};

test("404 → SLATE (no grant; dormant/miss, no existence leak)", () => {
  const s = reduceTrustMarkResponse({ httpStatus: 404, body: { error: "not_found" } });
  assert.equal(s.badge, "SLATE");
});

test("network error → YELLOW (unknowable, never RED/GREEN)", () => {
  const s = reduceTrustMarkResponse({ networkError: true });
  assert.equal(s.badge, "YELLOW");
});

test("501 → YELLOW verifier-pending (never a fabricated GREEN)", () => {
  const s = reduceTrustMarkResponse({ httpStatus: 501, body: { verification_status: "UNVERIFIABLE" } });
  assert.equal(s.badge, "YELLOW");
  assert.equal(s.note, "verifier pending");
});

test("200 GREEN body → GREEN + scope extracted", () => {
  const s = reduceTrustMarkResponse({ httpStatus: 200, body: GREEN_BODY });
  assert.equal(s.badge, "GREEN");
  assert.equal(s.grantId, "tm-grant-0001");
  assert.equal(s.markClass, "governed_agent");
  assert.equal(s.surfaceOrigin, "https://app.example");
});

test("200 RED body (revoked/expired/coverage-fail) → RED", () => {
  const s = reduceTrustMarkResponse({ httpStatus: 200, body: { ...GREEN_BODY, badge: "RED", verification_reason: "tm1_revoked" } });
  assert.equal(s.badge, "RED");
  assert.equal(s.verificationReason, "tm1_revoked");
});

test("never-fake-GREEN: unrecognized/missing badge degrades to YELLOW, never GREEN", () => {
  assert.equal(reduceTrustMarkResponse({ httpStatus: 200, body: { ...GREEN_BODY, badge: "MAGENTA" } }).badge, "YELLOW");
  assert.equal(reduceTrustMarkResponse({ httpStatus: 200, body: { ...GREEN_BODY, badge: undefined } }).badge, "YELLOW");
});

test("render maps each state to its label; GREEN omits a reason line", () => {
  const green = render(reduceTrustMarkResponse({ httpStatus: 200, body: GREEN_BODY }), {});
  assert.match(green, /Governed by Strix — verified live/);
  assert.doesNotMatch(green, /tm-reason/); // GREEN shows no failure reason
  assert.match(green, /npx @strixgov\/verifier trustmark tm-grant-0001/); // skeptic CLI offered

  const red = render(reduceTrustMarkResponse({ httpStatus: 200, body: { ...GREEN_BODY, badge: "RED", verification_reason: "tm1_revoked" } }), {});
  assert.match(red, /Trust mark not valid/);
  assert.match(red, /tm1_revoked/);

  const slate = render({ badge: "SLATE", grantId: null }, {});
  assert.match(slate, /No trust mark/);
});

test("compact render is a single inline pill, linked to the proof page when a grant resolved", () => {
  const html = render(reduceTrustMarkResponse({ httpStatus: 200, body: GREEN_BODY }), { compact: true, proofBase: "https://x.example" });
  assert.match(html, /tm-link/);
  assert.match(html, /https:\/\/x\.example\/proof\/trustmark\/tm-grant-0001/);
});

test("fetchTrustMarkState reduces an injected fetch; network throw → YELLOW", async () => {
  const okFetch = async () => ({ status: 200, json: async () => GREEN_BODY });
  const s = await fetchTrustMarkState("tm-grant-0001", { proofBase: "https://x.example", fetchImpl: okFetch });
  assert.equal(s.badge, "GREEN");

  const throwFetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const s2 = await fetchTrustMarkState("tm-grant-0001", { fetchImpl: throwFetch });
  assert.equal(s2.badge, "YELLOW");
});

test("badgeLabel is total over the four states", () => {
  for (const b of ["GREEN", "RED", "YELLOW", "SLATE"]) assert.equal(typeof badgeLabel(b), "string");
});
