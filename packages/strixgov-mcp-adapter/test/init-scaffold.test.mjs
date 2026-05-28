/**
 * Tests for the `npx @strixgov/mcp-adapter init` scaffolder.
 *
 * Two layers:
 *   1. Unit tests against `renderScaffold(...)` — pure string in/out.
 *   2. CLI tests that spawn `bin/strix-mcp-adapter.mjs` end-to-end and
 *      then `node`-execute the generated file to prove it runs clean.
 *
 * The end-to-end "scaffold and run" test is the one that protects the
 * "magic moment" claim — if a future refactor breaks the runnability of
 * the generated file, this catches it before publish.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import url from "node:url";

import {
  renderScaffold,
  detectCompanionPack,
  listKnownCompanionPacks,
} from "../src/scaffold.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ADAPTER_DIR = path.resolve(__dirname, "..");
// Unified CLI — `init` is a subcommand on the same entry as `demo`,
// dispatched by `bin/demo.mjs`. There is no separate `strix-mcp-adapter`
// binary; npx looks up @strixgov/mcp-adapter's single bin.
const BIN_PATH = path.join(ADAPTER_DIR, "bin", "demo.mjs");
// All CLI invocations below prepend `init` to mirror what
// `npx @strixgov/mcp-adapter init <name>` actually executes.

// ─── 1. detectCompanionPack ──────────────────────────────────────────────────

test("detectCompanionPack: known names match (case-insensitive)", () => {
  assert.equal(detectCompanionPack("notion"), "notion");
  assert.equal(detectCompanionPack("Notion"), "notion");
  assert.equal(detectCompanionPack("  GITHUB  "), "github");
});

test("detectCompanionPack: unknown name returns null", () => {
  assert.equal(detectCompanionPack("my-internal-server"), null);
  assert.equal(detectCompanionPack(""), null);
  assert.equal(detectCompanionPack(null), null);
});

test("listKnownCompanionPacks: returns the canonical 7", () => {
  const packs = listKnownCompanionPacks();
  assert.deepEqual([...packs].sort(), [
    "email",
    "filesystem",
    "github",
    "linear",
    "notion",
    "postgres",
    "slack",
  ]);
});

// ─── 2. renderScaffold: companion-pack branch ────────────────────────────────

test("renderScaffold: companion pack auto-imports the right module", () => {
  const out = renderScaffold({ serverName: "notion" });
  assert.match(out, /from "@strixgov\/capabilities-mcp-common\/notion"/);
  assert.match(out, /notionCapabilities/);
  assert.match(out, /serverId: "notion"/);
});

test("renderScaffold: GitHub pack picks GitHub-shaped sample tools", () => {
  const out = renderScaffold({ serverName: "github" });
  assert.match(out, /get_file_contents/);
  assert.match(out, /create_issue/);
  // Make sure we didn't leak the Notion sample by accident:
  assert.doesNotMatch(out, /notion-fetch/);
});

test("renderScaffold: no-pack branch inlines a starter capabilities array", () => {
  const out = renderScaffold({ serverName: "my-internal-server" });
  assert.doesNotMatch(out, /@strixgov\/capabilities-mcp-common\//);
  // Hyphens converted to underscores for the JS identifier.
  assert.match(out, /const my_internal_serverCapabilities = Object\.freeze\(\[/);
  assert.match(out, /example_read/);
  assert.match(out, /example_write/);
});

test("renderScaffold: explicit companionPack=null forces the no-pack branch even on a known name", () => {
  const out = renderScaffold({ serverName: "notion", companionPack: null });
  assert.doesNotMatch(out, /@strixgov\/capabilities-mcp-common\/notion/);
  assert.match(out, /const notionCapabilities = Object\.freeze\(\[/);
});

// ─── 3. renderScaffold: TODO discipline (the "5 blocks to fill in" promise) ──

test("renderScaffold: emits exactly 5 TODO(strix) numbered blocks in the pack branch", () => {
  const out = renderScaffold({ serverName: "notion" });
  const numbered = [...out.matchAll(/TODO\(strix\) (\d+)\/5/g)].map((m) => m[1]);
  // Each scaffold has the 5 numbered blocks; 4b is optional and connected-mode-gated.
  assert.deepEqual(numbered.sort(), ["1", "2", "3", "5"]);
});

test("renderScaffold: with-connected-mode adds the 4b block and the connectedMode constant", () => {
  const out = renderScaffold({ serverName: "notion", withConnectedMode: true });
  assert.match(out, /TODO\(strix\) 4b\/5 — connected mode/);
  assert.match(out, /process\.env\.STRIX_API_KEY/);
  assert.match(out, /process\.env\.STRIX_TENANT_ID/);
  assert.match(out, /connectedMode,/);
});

test("renderScaffold: without --with-connected-mode says so explicitly", () => {
  const out = renderScaffold({ serverName: "notion", withConnectedMode: false });
  assert.match(out, /Connected mode is off/);
  assert.doesNotMatch(out, /process\.env\.STRIX_API_KEY/);
});

// ─── 4. renderScaffold: input validation ─────────────────────────────────────

test("renderScaffold: rejects empty server name", () => {
  assert.throws(() => renderScaffold({ serverName: "" }), /serverName is required/);
});

test("renderScaffold: rejects shell-unsafe server names", () => {
  assert.throws(() => renderScaffold({ serverName: "foo; rm -rf /" }), /must match/);
  assert.throws(() => renderScaffold({ serverName: "foo bar" }), /must match/);
  assert.throws(() => renderScaffold({ serverName: "../escape" }), /must match/);
});

// ─── 5. CLI integration ──────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "strix-init-test-"));
  return dir;
}

function runCli(args, opts = {}) {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
  });
  return result;
}

test("cli: init with known pack writes a file in the cwd", () => {
  const tmp = makeTmpDir();
  try {
    const result = runCli(["init", "notion"], { cwd: tmp });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const outFile = path.join(tmp, "notion-governed.mjs");
    assert.ok(existsSync(outFile), "expected scaffold file to exist");
    const contents = readFileSync(outFile, "utf8");
    assert.match(contents, /serverId: "notion"/);
    assert.match(result.stdout, /scaffolded/);
    assert.match(result.stdout, /next:/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cli: init refuses to overwrite without --force", () => {
  const tmp = makeTmpDir();
  try {
    writeFileSync(path.join(tmp, "notion-governed.mjs"), "// pre-existing\n");
    const result = runCli(["init", "notion"], { cwd: tmp });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/);
    // File untouched
    assert.equal(readFileSync(path.join(tmp, "notion-governed.mjs"), "utf8"), "// pre-existing\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cli: init --force overwrites", () => {
  const tmp = makeTmpDir();
  try {
    writeFileSync(path.join(tmp, "notion-governed.mjs"), "// pre-existing\n");
    const result = runCli(["init", "notion", "--force"], { cwd: tmp });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const contents = readFileSync(path.join(tmp, "notion-governed.mjs"), "utf8");
    assert.doesNotMatch(contents, /pre-existing/);
    assert.match(contents, /serverId: "notion"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cli: init --out= writes to the given path", () => {
  const tmp = makeTmpDir();
  try {
    const outPath = path.join(tmp, "subdir", "g.mjs");
    // No subdir creation — the CLI does not auto-create dirs; user-error case.
    // We'll write to a path whose parent exists:
    const result = runCli(["init", "notion", `--out=${path.join(tmp, "custom.mjs")}`], { cwd: tmp });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(existsSync(path.join(tmp, "custom.mjs")));
    assert.ok(!existsSync(path.join(tmp, "notion-governed.mjs")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Regression for the Codex P2: --companion-pack=none ──────────────────────
//
// Before the fix, `--companion-pack=none` against a known server name (e.g.
// `notion`) produced a scaffold that imported a non-existent
// `@strixgov/capabilities-mcp-common/none` and failed at runtime with
// ERR_PACKAGE_PATH_NOT_EXPORTED. Pin both the static shape AND the e2e
// runnability — the static check alone wouldn't catch a future refactor
// that re-broke the no-pack branch dispatch.

test("cli: --companion-pack=none on a known server name uses the no-pack branch (static)", () => {
  const tmp = makeTmpDir();
  try {
    const result = runCli(
      ["init", "notion", "--companion-pack=none"],
      { cwd: tmp },
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const contents = readFileSync(path.join(tmp, "notion-governed.mjs"), "utf8");
    // The no-pack branch inlines a starter capabilities array and must NOT
    // import any companion pack — the bug was importing
    // `@strixgov/capabilities-mcp-common/none` (which doesn't exist).
    assert.doesNotMatch(contents, /@strixgov\/capabilities-mcp-common\//);
    assert.match(contents, /const notionCapabilities = Object\.freeze\(\[/);
    // Status line should reflect the no-pack outcome, not a fake "none" pack.
    assert.match(result.stdout, /companion pack: none \(inlined starter capabilities\)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("e2e: --companion-pack=none scaffold runs clean and prints signed receipts", () => {
  // The static check above pins the shape; this one pins runnability.
  // If a future refactor reintroduces the broken import, `node <file>` exits
  // non-zero with ERR_PACKAGE_PATH_NOT_EXPORTED and this test catches it.
  const outPath = path.join(ADAPTER_DIR, ".tmp-scaffold-none-e2e.mjs");
  try {
    const gen = runCli(
      ["init", "notion", `--out=${outPath}`, "--companion-pack=none", "--force"],
    );
    assert.equal(gen.status, 0, `stderr: ${gen.stderr}`);

    const run = spawnSync(process.execPath, [outPath], {
      cwd: ADAPTER_DIR,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(run.status, 0,
      `scaffold failed to run.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.match(run.stdout, /signed receipts/);
    assert.match(run.stdout, /sig=/);
  } finally {
    rmSync(outPath, { force: true });
  }
});

test("cli: --companion-pack help text mentions the `none` escape hatch", () => {
  const result = runCli(["init", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /none/);
  // Known list in the error path should also mention `none`.
  const tmp = makeTmpDir();
  try {
    const errResult = runCli(["init", "x", "--companion-pack=banana"], { cwd: tmp });
    assert.equal(errResult.status, 1);
    assert.match(errResult.stderr, /none/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cli: init rejects unknown --companion-pack with a useful message", () => {
  const tmp = makeTmpDir();
  try {
    const result = runCli(["init", "my-server", "--companion-pack=banana"], { cwd: tmp });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown --companion-pack 'banana'/);
    assert.match(result.stderr, /Known: /);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cli: init rejects missing server name", () => {
  const result = runCli(["init"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a <server-name> argument/);
});

test("cli: --help exits 0 and prints unified usage including init", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  // Top-level help advertises both subcommands now that the CLI is unified.
  assert.match(result.stdout, /demo/);
  assert.match(result.stdout, /init/);
});

test("cli: init --help exits 0 and prints init-specific usage", () => {
  const result = runCli(["init", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--companion-pack/);
  assert.match(result.stdout, /Known companion packs:/);
});

// ─── 6. End-to-end: scaffold and run ─────────────────────────────────────────
//
// The most important test in this file. Generates a scaffold, then runs
// it with `node` and asserts it prints signed receipts. This is what
// catches a future refactor that breaks the "magic moment" promise.

test("e2e: scaffold for unknown server runs clean and prints signed receipts", () => {
  const tmp = makeTmpDir();
  try {
    // Generate into the adapter dir's own examples-shaped sibling so the
    // workspace symlinks resolve `@strixgov/mcp-adapter` for the spawned
    // node process. Simplest reliable cwd is the adapter package dir.
    const outPath = path.join(ADAPTER_DIR, ".tmp-scaffold-e2e.mjs");
    try {
      const genResult = runCli(["init", "myserver", `--out=${outPath}`, "--force"]);
      assert.equal(genResult.status, 0, `stderr: ${genResult.stderr}`);
      assert.ok(existsSync(outPath));

      const runResult = spawnSync(process.execPath, [outPath], {
        cwd: ADAPTER_DIR,
        encoding: "utf8",
        timeout: 15000,
      });

      assert.equal(runResult.status, 0,
        `scaffolded file failed to run.\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`);
      assert.match(runResult.stdout, /signed receipts/);
      // At least one ALLOW (the example_read sample) and one DENY (unknown tool):
      assert.match(runResult.stdout, /ALLOW/);
      assert.match(runResult.stdout, /sig=/);
    } finally {
      rmSync(outPath, { force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("e2e: scaffold for known pack (notion) runs clean and prints signed receipts", () => {
  const outPath = path.join(ADAPTER_DIR, ".tmp-scaffold-e2e-notion.mjs");
  try {
    const genResult = runCli(["init", "notion", `--out=${outPath}`, "--force"]);
    assert.equal(genResult.status, 0, `stderr: ${genResult.stderr}`);

    const runResult = spawnSync(process.execPath, [outPath], {
      cwd: ADAPTER_DIR,
      encoding: "utf8",
      timeout: 15000,
    });

    assert.equal(runResult.status, 0,
      `scaffolded file failed to run.\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`);
    assert.match(runResult.stdout, /signed receipts/);
    assert.match(runResult.stdout, /sig=/);
  } finally {
    rmSync(outPath, { force: true });
  }
});
