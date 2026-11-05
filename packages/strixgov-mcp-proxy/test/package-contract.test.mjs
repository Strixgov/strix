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
