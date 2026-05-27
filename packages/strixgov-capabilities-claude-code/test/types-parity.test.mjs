/**
 * .d.ts ↔ runtime parity smoke test.
 *
 * TypeScript users only see what types.d.ts declares; node only ships
 * what index.mjs exports. If the two drift, IDE intellisense lies. This
 * test parses both as text and asserts:
 *
 *   1. Every named runtime export has a matching declaration in types.d.ts.
 *   2. Every declaration in types.d.ts maps to a real runtime export
 *      (no phantom types pointing at nothing).
 *   3. The `types` field in package.json points at a file that exists.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");

const RUNTIME_PATH = path.join(pkgRoot, "src/index.mjs");
const DTS_PATH = path.join(pkgRoot, "src/types.d.ts");
const PKG_JSON_PATH = path.join(pkgRoot, "package.json");

// Names that are types/interfaces only — they exist in .d.ts and are not
// expected to surface as runtime exports.
const TYPE_ONLY_NAMES = new Set([
  "RiskLevel",
  "Mode",
  "Decision",
  "ClaudeCodeCapability",
]);

test("package.json `types` field points at an existing file", async () => {
  const pkg = JSON.parse(await fs.readFile(PKG_JSON_PATH, "utf8"));
  const typesFromExports = pkg.exports?.["."]?.types;
  assert.ok(typesFromExports, "exports['.'].types missing");
  const resolved = path.resolve(pkgRoot, typesFromExports);
  await fs.access(resolved); // throws if missing
});

test("every runtime named export has a .d.ts declaration", async () => {
  const runtimeExports = await collectRuntimeExports(RUNTIME_PATH);
  const dtsNames = await collectDtsNames(DTS_PATH);

  for (const name of runtimeExports) {
    assert.ok(
      dtsNames.has(name),
      `runtime export "${name}" has no declaration in types.d.ts`,
    );
  }
});

test("every .d.ts declaration maps to a real runtime export", async () => {
  const runtimeExports = await collectRuntimeExports(RUNTIME_PATH);
  const dtsNames = await collectDtsNames(DTS_PATH);

  for (const name of dtsNames) {
    if (TYPE_ONLY_NAMES.has(name)) continue;
    assert.ok(
      runtimeExports.has(name),
      `types.d.ts declares "${name}" but runtime does not export it`,
    );
  }
});

/* helpers */

async function collectRuntimeExports(filePath) {
  const url = pathToFileURL(filePath).href;
  const mod = await import(url);
  return new Set(Object.keys(mod).filter((k) => k !== "default"));
}

async function collectDtsNames(filePath) {
  const src = await fs.readFile(filePath, "utf8");
  const names = new Set();
  // Match: export const NAME, export function NAME(, export class NAME,
  // export interface NAME, export type NAME =
  const re =
    /^export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(re)) names.add(m[1]);
  return names;
}
