import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const covered = (rel) =>
  pkg.files.some((f) => rel === f || (f.endsWith("/") && rel.startsWith(f)));

test("every script file the `test` script runs ships in the tarball", () => {
  const refs = [...pkg.scripts.test.matchAll(/\b(scripts\/[\w./-]+\.mjs)\b/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, "test script should reference a script file");
  for (const rel of refs) {
    assert.ok(existsSync(path.join(root, rel)), `${rel} is missing from the repo`);
    assert.ok(covered(rel), `${rel} is used by \`npm test\` but excluded by package.json "files"`);
  }
});

test("Strix dependencies are pinned exactly, so Guard's pinned proxy version fixes the whole Strix stack", () => {
  // In this repository they are `workspace:*`, which pnpm publishes as the exact
  // current version; in an installed copy they must already be exact versions.
  // A range here means a new tool-gateway release changes what an existing Guard
  // install runs (finding 1 of the #2810 evidence run).
  const strix = Object.entries(pkg.dependencies).filter(([n]) => n.startsWith("@strixgov/"));
  assert.ok(strix.length >= 3, "expected the Strix runtime dependencies");
  for (const [name, spec] of strix) {
    assert.ok(spec === "workspace:*" || /^\d+\.\d+\.\d+$/.test(spec), `${name} is "${spec}"; pin it exactly (workspace:*)`);
  }
});
