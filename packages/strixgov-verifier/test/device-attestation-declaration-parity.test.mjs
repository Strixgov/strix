/**
 * AA-2 — the `.d.ts` must describe the `.mjs`.
 *
 * ## Why this file exists
 *
 * `device-attestation.d.ts` is hand-written alongside `device-attestation.mjs`
 * and, until 2026-09-06, declared `renderDeviceClassBlock` as returning
 * `{ attested, verified, reason, deviceClass, attestationProtocol }`. The
 * implementation has never returned that. It returns
 * `{ claimedClass, verified, verificationReason, attestationProtocol }` — two
 * fields under different names and no `attested` at all.
 *
 * Nothing in this package could catch that. The tests exercise the `.mjs`, so
 * they were right; the type tests did not exist, so the declaration was free
 * to say anything. TypeScript then repeated the declaration to every consumer
 * as fact, and strix-platform's console wrote a badge against it — correctly,
 * given what the types said — that read `attested` as `undefined` at runtime
 * and reported a VERIFIED device attestation as "No device attestation."
 *
 * A hand-written declaration for an untyped module is a claim about code, and
 * a claim about code needs a check. This is that check: it reads the field
 * names out of the DECLARATION and compares them to the field names the
 * IMPLEMENTATION actually emits. It is intentionally shallow — it verifies
 * the property that was wrong, not the whole type system.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { renderDeviceClassBlock } from "../src/device-attestation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DTS = path.join(HERE, "../src/device-attestation.d.ts");

/** Field names declared on `interface DeviceClassBlock` in the `.d.ts`. */
function declaredFields() {
  const src = readFileSync(DTS, "utf8");
  const m = src.match(/export interface DeviceClassBlock \{([\s\S]*?)\n\}/);
  assert.ok(m, "interface DeviceClassBlock not found in device-attestation.d.ts");
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*") && !l.startsWith("/") && !l.startsWith("//"))
    .map((l) => l.split(/[?:]/)[0].trim())
    .filter(Boolean)
    .sort();
}

/**
 * Field names the implementation emits. Every branch is exercised, because a
 * declaration that matches one branch and not another is still a lie — and
 * this function has four.
 */
function emittedFields() {
  const record = {
    payload: { device_class: "browser", attestation_protocol: "webauthn" },
    kid: "k",
    signature: "ff",
  };
  const branches = [
    renderDeviceClassBlock(null, null), // no record
    renderDeviceClassBlock(record, null), // record, no verification
    renderDeviceClassBlock(record, { valid: true }), // valid
    renderDeviceClassBlock(record, { valid: false, reason: "aa2_tenant_mismatch" }), // invalid
    renderDeviceClassBlock(record, {
      valid: false,
      reason: "aa2_revocation_check_unavailable",
    }), // substrate error
  ];

  const shapes = branches.map((b) => Object.keys(b).sort().join(","));
  assert.equal(
    new Set(shapes).size,
    1,
    `renderDeviceClassBlock returns different shapes per branch: ${[...new Set(shapes)].join(" | ")}`,
  );
  return Object.keys(branches[0]).sort();
}

test("the declared DeviceClassBlock fields are the fields the implementation emits", () => {
  assert.deepEqual(declaredFields(), emittedFields());
});

test("the declaration does not carry fields the implementation cannot produce", () => {
  const declared = declaredFields();
  // Named explicitly because these three are the exact fields the wrong
  // declaration carried, and re-adding any of them is how the defect returns.
  for (const absent of ["attested", "reason", "deviceClass"]) {
    assert.ok(
      !declared.includes(absent),
      `device-attestation.d.ts declares '${absent}', which renderDeviceClassBlock never emits. ` +
        `'attested' in particular cannot be derived here at all — this function renders the same ` +
        `all-null block for "no record" and for "a record with nothing resolvable", so only a caller ` +
        `holding the record can distinguish them.`,
    );
  }
});
