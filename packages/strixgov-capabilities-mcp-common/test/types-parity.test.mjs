/**
 * .d.ts ↔ runtime parity smoke test.
 *
 * Mirrors the same check in @strixgov/capabilities-claude-code: catches
 * the case where types.d.ts and index.mjs drift, since TypeScript users
 * only see one and node only ships the other.
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

const TYPE_ONLY_NAMES = new Set([
  "RiskLevel",
  "Mode",
  "Decision",
  "McpCapability",
]);

test("every subpath in package.json `exports` points at a real .mjs", async () => {
  const pkg = JSON.parse(await fs.readFile(PKG_JSON_PATH, "utf8"));
  for (const [key, entry] of Object.entries(pkg.exports ?? {})) {
    assert.ok(entry.types, `exports[${key}].types missing`);
    assert.ok(entry.import, `exports[${key}].import missing`);
    await fs.access(path.resolve(pkgRoot, entry.types));
    await fs.access(path.resolve(pkgRoot, entry.import));
  }
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
  const re =
    /^export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(re)) names.add(m[1]);
  return names;
}
