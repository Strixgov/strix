#!/usr/bin/env node
/**
 * Generate the TypeScript and Python bindings FROM the canonical schema.
 *
 * W0-0 Acceptance 1 requires bindings "generated from that source rather than
 * maintained as independent hand-written representations." A generator alone
 * does not make that true — nothing stops someone editing the output. So this
 * script has two modes and the second is the one that matters:
 *
 *   (default)  write the bindings
 *   --check    regenerate in memory and FAIL if the committed bindings differ
 *
 * `--check` runs in CI. It is what converts "generated" from an intention into
 * an enforced property: a hand-edit to a binding, or a schema change without a
 * regenerate, both fail. Neither is detectable by reading the files.
 *
 * Deliberately dependency-free (node:fs + node:crypto only) so the contract
 * package never drags a codegen toolchain into every consumer.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = resolve(ROOT, "schema/repo-proof-manifest-v1.schema.json");
const TS_PATH = resolve(ROOT, "generated/typescript/manifest-v1.ts");
const PY_PATH = resolve(ROOT, "generated/python/manifest_v1.py");

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
const schemaSha = createHash("sha256").update(readFileSync(SCHEMA_PATH)).digest("hex");

const BANNER_LINES = [
  "GENERATED FILE — DO NOT EDIT.",
  "",
  "Source of truth: schema/repo-proof-manifest-v1.schema.json",
  `Schema sha256:   ${schemaSha}`,
  "Regenerate:      node scripts/generate-bindings.mjs",
  "",
  "Hand-editing this file is a contract violation (W0-0 Acceptance 1): the",
  "bindings are generated, never independently maintained. CI runs",
  "`--check`, which fails on any divergence in either direction.",
];

/** Collect the closed enums the schema defines, by property path. */
function collectEnums(node, path, out) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node.enum)) out.push({ path, values: node.enum });
  for (const key of ["properties", "$defs"]) {
    if (node[key]) for (const [k, v] of Object.entries(node[key])) collectEnums(v, [...path, k], out);
  }
  if (node.items) collectEnums(node.items, [...path, "[]"], out);
  return out;
}

function pascal(parts) {
  return parts
    .filter((p) => p !== "[]" && p !== "properties" && p !== "$defs")
    .map((p) => p.replace(/(^|[^a-zA-Z0-9])([a-zA-Z0-9])/g, (_, __, c) => c.toUpperCase()))
    .join("");
}
function snake(parts) {
  return parts
    .filter((p) => p !== "[]")
    .map((p) => p.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase())
    .join("_");
}

const enums = collectEnums(schema, [], []);

function renderTs() {
  const L = [];
  L.push("/**");
  for (const b of BANNER_LINES) L.push(` * ${b}`.trimEnd());
  L.push(" */");
  L.push("");
  L.push(`export const SCHEMA_VERSION = ${JSON.stringify(schema.properties.schemaVersion.const)} as const;`);
  L.push(`export const SCHEMA_SHA256 = ${JSON.stringify(schemaSha)} as const;`);
  L.push("");
  L.push("export const REQUIRED_TOP_LEVEL = [");
  for (const r of schema.required) L.push(`  ${JSON.stringify(r)},`);
  L.push("] as const;");
  L.push("");
  for (const e of enums) {
    const name = pascal(e.path) || "Anon";
    L.push(`export type ${name} =`);
    L.push(e.values.map((v) => `  | ${JSON.stringify(v)}`).join("\n") + ";");
    L.push("");
  }
  return L.join("\n") + "\n";
}

function renderPy() {
  const L = [];
  L.push('"""');
  for (const b of BANNER_LINES) L.push(b);
  L.push('"""');
  L.push("");
  L.push("from typing import Final, Tuple");
  L.push("");
  L.push(`SCHEMA_VERSION: Final[str] = ${JSON.stringify(schema.properties.schemaVersion.const)}`);
  L.push(`SCHEMA_SHA256: Final[str] = ${JSON.stringify(schemaSha)}`);
  L.push("");
  L.push("REQUIRED_TOP_LEVEL: Final[Tuple[str, ...]] = (");
  for (const r of schema.required) L.push(`    ${JSON.stringify(r)},`);
  L.push(")");
  L.push("");
  for (const e of enums) {
    const name = snake(e.path).toUpperCase() || "ANON";
    L.push(`${name}: Final[Tuple[str, ...]] = (`);
    for (const v of e.values) L.push(`    ${JSON.stringify(v)},`);
    L.push(")");
    L.push("");
  }
  return L.join("\n");
}

const ts = renderTs();
const py = renderPy();

if (process.argv.includes("--check")) {
  let bad = 0;
  for (const [path, want] of [[TS_PATH, ts], [PY_PATH, py]]) {
    let got = null;
    try { got = readFileSync(path, "utf-8"); } catch { got = null; }
    if (got !== want) {
      console.error(`DRIFT: ${path.replace(ROOT + "/", "")} does not match the schema.`);
      console.error(got === null ? "  (missing — run the generator)" : "  (regenerate; do not hand-edit)");
      bad += 1;
    }
  }
  if (bad) { console.error(`\n${bad} binding(s) out of sync with schema sha256 ${schemaSha}.`); process.exit(1); }
  console.log(`bindings in sync with schema sha256 ${schemaSha}`);
  process.exit(0);
}

writeFileSync(TS_PATH, ts);
writeFileSync(PY_PATH, py);
console.log(`generated 2 bindings from schema sha256 ${schemaSha}`);
