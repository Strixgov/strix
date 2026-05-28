/**
 * `init` subcommand for the unified `bin/demo.mjs` CLI.
 *
 * Exported as a pure function so:
 *   - `bin/demo.mjs` dispatches to `runInit(args)` after parsing argv
 *   - Tests can call `runInit(["notion", "--out=..."])` without spawning
 *
 * The scaffold-rendering logic itself lives in `./scaffold.mjs` —
 * this module is the I/O + argv layer wrapping it.
 *
 * Behavior contract (regression-tested in `test/init-scaffold.test.mjs`):
 *   - Refuses to overwrite existing files unless --force
 *   - Unknown --companion-pack values fail with the known list
 *   - Missing <server-name> fails with a useful message
 *   - On success, writes the file and returns a result the caller
 *     formats for stdout
 *
 * Exit codes (when used from the CLI):
 *   0  success
 *   1  caller error (missing args, file exists without --force, bad pack)
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  renderScaffold,
  detectCompanionPack,
  listKnownCompanionPacks,
} from "./scaffold.mjs";

export const INIT_USAGE = `
Usage: npx @strixgov/mcp-adapter init <server-name> [options]

Scaffold a runnable governed-MCP-server file in the current directory.
Generated file runs immediately with \`node <server-name>-governed.mjs\`
and prints 3 signed receipts in stub mode — zero edits required.

Options:
  --companion-pack=<n>     Override pack detection (default: match server-name)
                           Pass \`none\` to force the no-pack branch even on a
                           known server name (e.g. you ship a customised
                           Notion wrap and don't want the built-in pack).
  --with-connected-mode    Scaffold the STRIX_API_KEY / STRIX_TENANT_ID block
  --out=<path>             Output path (default: ./<server-name>-governed.mjs)
  --force                  Overwrite the output file if it exists

Examples:
  npx @strixgov/mcp-adapter init notion
  npx @strixgov/mcp-adapter init my-server --with-connected-mode
  npx @strixgov/mcp-adapter init custom --companion-pack=slack --out=./governed.mjs

Known companion packs: ${listKnownCompanionPacks().join(", ")}
`.trim();

/**
 * Parse + execute the init subcommand. Returns the result; the caller
 * is responsible for formatting it onto stdout.
 *
 * @param {string[]} args  argv after the "init" keyword
 * @returns {{ outPath: string, serverName: string, companionPack: string | null, withConnectedMode: boolean }}
 */
export function runInit(args) {
  const parsed = parseInitArgs(args);

  if (!parsed.serverName) {
    throw userError("init requires a <server-name> argument");
  }

  // Validate `--companion-pack` BEFORE normalising the "none" escape hatch
  // — the escape is only valid for the literal string "none", every other
  // value must be a registered pack name.
  if (parsed.companionPack && parsed.companionPack !== "none" &&
      !listKnownCompanionPacks().includes(parsed.companionPack)) {
    throw userError(
      `unknown --companion-pack '${parsed.companionPack}'. ` +
      `Known: ${listKnownCompanionPacks().join(", ")}, none`,
    );
  }

  // Normalise the CLI-only "none" sentinel to null BEFORE handing off to
  // renderScaffold. The render layer's contract is null = "no pack"; if we
  // pass the literal "none" through, the with-pack branch fires and the
  // scaffold imports a non-existent `@strixgov/capabilities-mcp-common/none`
  // — broken at runtime with ERR_PACKAGE_PATH_NOT_EXPORTED.
  const companionPack =
    parsed.companionPack === "none"
      ? null
      : parsed.companionPack !== undefined
        ? parsed.companionPack
        : detectCompanionPack(parsed.serverName);

  const outPath = resolve(parsed.out ?? `./${parsed.serverName}-governed.mjs`);

  if (existsSync(outPath) && !parsed.force) {
    throw userError(
      `output file already exists: ${outPath}\n` +
      `pass --force to overwrite, or --out=<path> to write somewhere else`,
    );
  }

  const contents = renderScaffold({
    serverName: parsed.serverName,
    companionPack,
    withConnectedMode: parsed.withConnectedMode,
  });

  writeFileSync(outPath, contents, { encoding: "utf8" });

  return {
    outPath,
    serverName: parsed.serverName,
    companionPack,
    withConnectedMode: parsed.withConnectedMode,
  };
}

/**
 * @param {{ outPath: string, serverName: string, companionPack: string | null, withConnectedMode: boolean }} result
 */
export function formatInitSuccess(result) {
  const packLine = result.companionPack
    ? `companion pack: @strixgov/capabilities-mcp-common/${result.companionPack}`
    : `companion pack: none (inlined starter capabilities)`;
  const connectedLine = result.withConnectedMode
    ? `connected mode: scaffolded (reads STRIX_API_KEY + STRIX_TENANT_ID at runtime)`
    : `connected mode: off (pass --with-connected-mode to scaffold it)`;

  return `✓ scaffolded ${result.outPath}
  ${packLine}
  ${connectedLine}

next:
  1. node ${result.outPath}
     → runs in stub mode, prints 3 signed receipts

  2. grep TODO\\(strix\\) ${result.outPath}
     → 5 blocks to fill in before you go to production

  3. npx @strixgov/verifier --help
     → verify the receipts independently of Strix
`;
}

/** @param {string[]} args */
function parseInitArgs(args) {
  /** @type {{ serverName?: string, companionPack?: string, withConnectedMode: boolean, out?: string, force: boolean }} */
  const out = { withConnectedMode: false, force: false };

  for (const raw of args) {
    if (raw.startsWith("--companion-pack=")) {
      out.companionPack = raw.slice("--companion-pack=".length);
    } else if (raw === "--with-connected-mode") {
      out.withConnectedMode = true;
    } else if (raw.startsWith("--out=")) {
      out.out = raw.slice("--out=".length);
    } else if (raw === "--force") {
      out.force = true;
    } else if (raw.startsWith("--")) {
      throw userError(`unknown flag: ${raw}`);
    } else if (out.serverName === undefined) {
      out.serverName = raw;
    } else {
      throw userError(`unexpected positional argument: ${raw}`);
    }
  }

  return out;
}

function userError(message) {
  const e = new Error(message);
  // @ts-expect-error attach exit-code class for the CLI's outer handler
  e.code = "USER";
  return e;
}
