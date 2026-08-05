/**
 * Agent-session bundle verification — cross-implementation conformance.
 *
 * `test/fixtures/agent-session-golden-bundle.json` is the PRODUCER's locked
 * golden vector, emitted by
 * solo-builder-core/tests/agent-navigation-evidence-v1.test.ts. This suite
 * replays it through the verifier's zero-shared-code re-implementation of
 * the canonicalization, the per-event content addressing, the chain walk,
 * and the RFC 6962 Merkle root. Any drift between the two implementations
 * fails here first (the conformance-program discipline).
 *
 * Locked values are never updated to make a failing test pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  AGENT_SESSION_REASONS,
  FINDING_BINDING_REASONS,
  computeSessionRoot,
  verifyAgentSessionBundle,
} from "../src/agent-session.mjs";

// TEST-ONLY key (seed = 32×0x07) — same as the producer goldens, never a prod key.
const TEST_PKCS8_B64 = "MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
const testPub = createPublicKey(
  createPrivateKey({ key: Buffer.from(TEST_PKCS8_B64, "base64"), format: "der", type: "pkcs8" }),
);
const JWKS = {
  keys: [{ ...testPub.export({ format: "jwk" }), kid: "strix-test-golden-v1" }],
};

// ── Producer-locked golden values (mirrored from the producer suite) ────
const GOLDEN_ROOT = "632ad908389f0fd246f584a102d0c0842594fc294053340e7d941bad6c752bd0";
const GOLDEN_CHAIN_HEAD = "59dad144c0118db48e51f658bda3ccba1882a195e1dbf21bb10824e5defda72e";
const GOLDEN_FIRST_EVENT_HASH =
  "5962203146228865d9b70854b74b06369e20ed1a25e510ce1993a25425036fef";

const FIXTURE = new URL("./fixtures/agent-session-golden-bundle.json", import.meta.url);

function golden() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

// ── Conformance: the independent implementation agrees byte-for-byte ────

test("re-derives the producer's locked root from the fixture's event hashes", () => {
  const b = golden();
  assert.equal(b.events.length, 7);
  assert.equal(b.events[0].eventHash, GOLDEN_FIRST_EVENT_HASH);
  assert.equal(b.events[b.events.length - 1].eventHash, GOLDEN_CHAIN_HEAD);
  assert.equal(b.commitment.payload.rootHash, GOLDEN_ROOT);
  // The verifier's own Merkle walk must reproduce the producer's root.
  assert.equal(
    computeSessionRoot(b.events.map((e) => e.eventHash)),
    GOLDEN_ROOT,
  );
});

test("re-derives every event content address from its canonical payload", () => {
  // Proven indirectly but decisively: any canonicalization drift would make
  // at least one address fail to re-derive, which surfaces as
  // EVENT_HASH_MISMATCH rather than a clean VERIFIED.
  const r = verifyAgentSessionBundle(golden(), { jwks: JWKS });
  assert.equal(r.verdict, "VERIFIED");
  assert.deepEqual(r.reasons, [AGENT_SESSION_REASONS.OK]);
  assert.equal(r.chainHead, GOLDEN_CHAIN_HEAD);
  assert.equal(r.eventCount, 7);
  assert.equal(r.integrityAnchoredBy, "SIGNED_SESSION_COMMITMENT");
});

test("verifies the fixture's finding binding", () => {
  const r = verifyAgentSessionBundle(golden(), { jwks: JWKS });
  assert.equal(r.findingsBinding.verdict, "VERIFIED");
  assert.deepEqual(r.findingsBinding.reasons, [FINDING_BINDING_REASONS.OK]);
  assert.equal(r.findingsBinding.perFinding.length, 1);
  assert.equal(r.findingsBinding.perFinding[0].findingId, "F-14");
});

// ── NAV-3 / NAV-4: structural honesty pins on every result ─────────────

test("every result carries completeness NOT_PROVEN and provesReviewCorrectness false", () => {
  const inputs = [
    golden(),
    null,
    { bundleVersion: 1 },
    { bundleVersion: 99, commitment: {}, events: [] },
  ];
  for (const input of inputs) {
    for (const opts of [{ jwks: JWKS }, {}]) {
      const r = verifyAgentSessionBundle(input, opts);
      assert.equal(r.completeness, "NOT_PROVEN");
      assert.equal(r.provesReviewCorrectness, false);
    }
  }
});

// ── NAV-7: cannot verify is not proven wrong ───────────────────────────

test("caps at UNVERIFIABLE with no JWKS, never INVALID (NAV-7)", () => {
  const r = verifyAgentSessionBundle(golden());
  assert.equal(r.verdict, "UNVERIFIABLE");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.COMMITMENT_KEY_UNRESOLVED));
  assert.equal(r.integrityAnchoredBy, "NONE");
});

test("caps at UNVERIFIABLE when the kid does not resolve", () => {
  const r = verifyAgentSessionBundle(golden(), {
    jwks: { keys: [{ ...JWKS.keys[0], kid: "some-other-kid" }] },
  });
  assert.equal(r.verdict, "UNVERIFIABLE");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.COMMITMENT_KEY_UNRESOLVED));
});

test("reports INVALID for a tampered event even with no JWKS supplied", () => {
  const b = golden();
  b.events[3].payload.screen = "Payments";
  const r = verifyAgentSessionBundle(b);
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.EVENT_HASH_MISMATCH));
});

test("reports INVALID when the commitment signature does not verify", () => {
  const b = golden();
  b.commitment.payload.committedAt = "2026-07-30T04:00:00Z";
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.COMMITMENT_SIGNATURE_INVALID));
});

test("reports INVALID for a foreign signing key", () => {
  const other = createPublicKey(
    createPrivateKey({
      key: Buffer.from(
        "MC4CAQAwBQYDK2VwBCIEIAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
        "base64",
      ),
      format: "der",
      type: "pkcs8",
    }),
  );
  const r = verifyAgentSessionBundle(golden(), {
    jwks: { keys: [{ ...other.export({ format: "jwk" }), kid: "strix-test-golden-v1" }] },
  });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.COMMITMENT_SIGNATURE_INVALID));
});

// ── The tamper classes the demo claims to detect ───────────────────────

test("detects an EDITED event", () => {
  const b = golden();
  b.events[4].payload.screen = "Checkout";
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.EVENT_HASH_MISMATCH));
});

test("detects a REMOVED trailing event", () => {
  const b = golden();
  b.events.pop();
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.LEAF_COUNT_MISMATCH));
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.ROOT_MISMATCH));
});

test("detects a REMOVED middle event", () => {
  const b = golden();
  b.events.splice(3, 1);
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.CHAIN_LINK_BROKEN));
});

test("detects REORDERED events", () => {
  const b = golden();
  const tmp = b.events[2];
  b.events[2] = b.events[3];
  b.events[3] = tmp;
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.STEP_INDEX_BROKEN));
});

test("detects a DUPLICATED event", () => {
  const b = golden();
  b.events.splice(3, 0, JSON.parse(JSON.stringify(b.events[3])));
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.LEAF_COUNT_MISMATCH));
});

test("rejects a commitment sealed under a different run kind", () => {
  const b = golden();
  b.commitment.payload.runKind = "swarm_run";
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.COMMITMENT_RUN_KIND_MISMATCH));
});

test("rejects a session re-pointed at another session's commitment", () => {
  const b = golden();
  b.commitment.payload.runId = "agentsess_someone_else";
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.COMMITMENT_SESSION_MISMATCH));
});

test("ignores a planted verified field anywhere in the bundle", () => {
  const b = golden();
  b.events[2].payload.screen = "Payments";
  b.events[2].verified = true;
  b.commitment.verified = true;
  b.verified = true;
  b.verdict = "VERIFIED";
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
});

test("rejects a malformed bundle version", () => {
  const r = verifyAgentSessionBundle({ ...golden(), bundleVersion: 2 }, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.SCHEMA_INVALID));
});

test("rejects an empty session", () => {
  const b = golden();
  b.events = [];
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.NO_EVENTS));
});

test("rejects a non-digest screenshotHash smuggled into a payload", () => {
  const b = golden();
  b.events[1].payload.screenshotHash = "data:image/png;base64,iVBORw0KGgo=";
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.ok(r.reasons.includes(AGENT_SESSION_REASONS.SCHEMA_INVALID));
});

// ── Findings never launder a bad session, and never rescue one ──────────

test("an unbound finding is reported without changing the session verdict (FND-6)", () => {
  const b = golden();
  b.findings[0].observedEventHash = "d".repeat(64);
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  // Session integrity is untouched by a bogus finding...
  assert.equal(r.verdict, "VERIFIED");
  // ...but the binding failure is surfaced, never swallowed.
  assert.equal(r.findingsBinding.verdict, "INVALID");
  assert.ok(r.findingsBinding.reasons.includes(FINDING_BINDING_REASONS.UNBOUND_EVENT));
});

test("detects a finding citing the wrong screen for its event", () => {
  const b = golden();
  b.findings[0].screen = "Dashboard";
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.findingsBinding.verdict, "INVALID");
  assert.ok(r.findingsBinding.reasons.includes(FINDING_BINDING_REASONS.SCREEN_MISMATCH));
});

test("detects a finding citing the wrong screenshot digest", () => {
  const b = golden();
  b.findings[0].screenshotHash = "e".repeat(64);
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.findingsBinding.verdict, "INVALID");
  assert.ok(r.findingsBinding.reasons.includes(FINDING_BINDING_REASONS.SCREENSHOT_MISMATCH));
});

test("detects a findings set re-pointed at another session root", () => {
  const b = golden();
  b.findings[0].sessionRootHash = "f".repeat(64);
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.findingsBinding.verdict, "INVALID");
  assert.ok(r.findingsBinding.reasons.includes(FINDING_BINDING_REASONS.ROOT_MISMATCH));
});

test("a session with no findings is not treated as a binding failure", () => {
  const b = golden();
  delete b.findings;
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "VERIFIED");
  assert.equal(r.findingsBinding.verdict, "VERIFIED");
  assert.deepEqual(r.findingsBinding.reasons, [FINDING_BINDING_REASONS.NO_FINDINGS]);
});

test("findings cannot rescue a tampered session", () => {
  const b = golden();
  b.events[4].payload.screen = "Checkout";
  b.findings = [];
  const r = verifyAgentSessionBundle(b, { jwks: JWKS });
  assert.equal(r.verdict, "INVALID");
  assert.equal(r.findingsBinding.verdict, "VERIFIED");
});
