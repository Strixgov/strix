/**
 * Repo-to-Proof manifest validator.
 *
 * Structural validation plus the manifest rules that a JSON Schema cannot
 * express — each of which exists because the packet named a way a manifest
 * could look complete while being wrong:
 *
 *   RPF-2  an `enumerated` ungoverned set must actually enumerate. A relevant
 *          path that appears in neither `governed` nor `ungoverned` is an
 *          UNDISCLOSED path, and claiming enumeration over it is the exact
 *          "empty bypass field read as clean coverage" failure. Refused.
 *   RPF-3  an in-process hook may never be declared unbypassable.
 *   §9.3   no capability mapping may be `exact` on `derived` provenance. A
 *          derived mapping is string-similarity or nearest-name matching by
 *          another name, and the acceptance condition bars exactly that from
 *          becoming a governed-effect claim.
 *
 * Validation NEVER repairs. It reports refusals; it does not fill a gap to make
 * a manifest pass.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(
  readFileSync(resolve(HERE, "../schema/repo-proof-manifest-v1.schema.json"), "utf-8"),
);

export const REFUSAL = {
  SCHEMA_VERSION: "SCHEMA_VERSION_UNSUPPORTED",
  MISSING_FIELD: "REQUIRED_FIELD_MISSING",
  SUBJECT_NOT_PINNED: "SUBJECT_NOT_PINNED_TO_FULL_SHA",
  SUBJECT_ORIGIN: "SUBJECT_ORIGIN_NOT_RESOLVABLE",
  UNDISCLOSED_PATH: "RPF2_UNDISCLOSED_RELEVANT_PATH",
  COMPLETENESS_UNSUPPORTED: "RPF2_ENUMERATION_WITHOUT_DERIVATION",
  HOOK_UNBYPASSABLE: "RPF3_IN_PROCESS_HOOK_CLAIMED_UNBYPASSABLE",
  DERIVED_EXACT: "ALIASING_DERIVED_MAPPING_CLAIMED_EXACT",
};

const SHA40 = /^[0-9a-f]{40}$/;
const ORIGIN = /^git\+https:\/\/[^\s#]+\.git$/;

export function validateManifest(m) {
  const refusals = [];
  const refuse = (code, detail) => refusals.push({ code, detail });

  if (!m || typeof m !== "object") {
    return { valid: false, refusals: [{ code: REFUSAL.MISSING_FIELD, detail: "manifest is not an object" }] };
  }
  if (m.schemaVersion !== SCHEMA.properties.schemaVersion.const) {
    refuse(REFUSAL.SCHEMA_VERSION, `expected ${SCHEMA.properties.schemaVersion.const}, got ${String(m.schemaVersion)}`);
    return { valid: false, refusals };
  }
  for (const key of SCHEMA.required) {
    if (m[key] === undefined) refuse(REFUSAL.MISSING_FIELD, key);
  }
  if (refusals.length) return { valid: false, refusals };

  // Acceptance 2 — identity is origin + immutable full SHA.
  if (!ORIGIN.test(m.subject?.origin ?? "")) refuse(REFUSAL.SUBJECT_ORIGIN, String(m.subject?.origin));
  if (!SHA40.test(m.subject?.commitSha ?? "")) {
    refuse(REFUSAL.SUBJECT_NOT_PINNED, `commitSha must be a full 40-hex SHA; a tag or branch is movable and is never identity (got ${String(m.subject?.commitSha)})`);
  }

  // RPF-3.
  if (m.enforcementBoundary?.kind === "in-process-hook" && m.enforcementBoundary?.unbypassableClaimed === true) {
    refuse(REFUSAL.HOOK_UNBYPASSABLE, "an in-process hook is declared as what it is, never as unbypassable");
  }

  // §9.3 anti-aliasing.
  for (const [i, e] of (m.capabilityReconciliation ?? []).entries()) {
    if (e?.provenance === "derived" && e?.disposition === "exact") {
      refuse(
        REFUSAL.DERIVED_EXACT,
        `capabilityReconciliation[${i}]: a derived mapping may not be asserted 'exact'. ` +
          "No discovered capability may become a governed-effect claim through string similarity, " +
          "nearest-name matching or unreviewed aliasing — mark it 'unresolved' until reviewed.",
      );
    }
  }

  // RPF-2 — the load-bearing check.
  const p = m.paths ?? {};
  const listed = new Set([...(p.governed ?? []), ...(p.ungoverned ?? [])].map((x) => x.path));
  const state = p.ungovernedCompleteness?.state;
  if (state === "enumerated") {
    if (!p.ungovernedCompleteness?.derivedFrom) {
      refuse(REFUSAL.COMPLETENESS_UNSUPPORTED, "claiming 'enumerated' requires derivedFrom naming the surface map it was derived from");
    }
    for (const rel of p.relevant ?? []) {
      if (!listed.has(rel.path)) {
        refuse(
          REFUSAL.UNDISCLOSED_PATH,
          `'${rel.path}' is relevant but appears in neither governed nor ungoverned, while the manifest claims the ungoverned set is enumerated. ` +
            "Unknown coverage is never rendered as complete coverage.",
        );
      }
    }
  }

  return { valid: refusals.length === 0, refusals };
}
