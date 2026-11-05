import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

test("the published tarball ships the tests that `npm test` runs", () => {
  assert.ok(pkg.files.includes("test/"), 'package.json "files" must include test/');
  const tests = readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.mjs"));
  assert.ok(tests.length >= 2, "expected real test files, not an empty glob");
});
