#!/usr/bin/env node
/**
 * strix-egress-prompt-hook — Claude Code UserPromptSubmit hook.
 *
 *   (as a hook)   reads the hook JSON on stdin, scans `prompt` locally.
 *                 Blocks (exit 2) when identifiers are found; reports
 *                 categories and counts only, never values.
 *                 STRIX_EGRESS_HOOK_MODE=warn reports without blocking.
 *
 *   strix-egress-prompt-hook init [--user] [--project-dir DIR] [--command CMD] [--print]
 *                 merges the hook into .claude/settings.json (project, the
 *                 default) or ~/.claude/settings.json (--user). Idempotent.
 *                 --print writes the merged JSON to stdout instead of the file.
 *
 * Nothing is sent anywhere: the detector runs in this process.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loaded dynamically so that a broken install (a missing or unreadable
// module) still ends in the fail-closed exit 2 below. A static import that
// fails would exit 1, which Claude Code treats as a non-blocking error and
// lets the prompt through.
const loadHook = () => import('../src/hooks/prompt-hook.mjs');

const MAX_STDIN_BYTES = 10 * 1024 * 1024;

function readStdin() {
  return new Promise((resolveP) => {
    const chunks = [];
    let size = 0;
    let over = false;
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN_BYTES) over = true;
      else chunks.push(c);
    });
    process.stdin.on('end', () => resolveP(over ? null : Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolveP(null));
  });
}

async function runInit(argv) {
  const { installHookIntoSettings } = await loadHook();
  let user = false;
  let projectDir = process.cwd();
  let command;
  let print = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--user') user = true;
    else if (a === '--project-dir') projectDir = resolve(next());
    else if (a === '--command') command = next();
    else if (a === '--print') print = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (command === undefined) {
    const self = realpathSync(fileURLToPath(import.meta.url));
    if (/[\\/]_npx[\\/]/.test(self)) {
      throw new Error(
        'this copy is running from the npx cache, which can be cleared at any time; install the package ' +
          '(npm install -g @strixgov/governed-egress) and re-run init, or pass --command',
      );
    }
    command = `node ${JSON.stringify(self)}`;
  }
  const settingsPath = user ? join(homedir(), '.claude', 'settings.json') : join(projectDir, '.claude', 'settings.json');
  let current = {};
  if (existsSync(settingsPath)) {
    try {
      current = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      throw new Error(`${settingsPath} is not valid JSON; fix it before installing the hook`);
    }
  }
  const merged = installHookIntoSettings(current, command);
  const text = JSON.stringify(merged, null, 2) + '\n';
  if (print) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, text);
  process.stderr.write(
    `strix-egress-prompt-hook: installed UserPromptSubmit hook in ${settingsPath}\n` +
      '  mode: block (set STRIX_EGRESS_HOOK_MODE=warn to report without blocking)\n' +
      '  restart Claude Code for the change to take effect\n',
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'init') {
    try {
      await runInit(argv.slice(1));
      process.exitCode = 0;
    } catch (e) {
      process.stderr.write(`strix-egress-prompt-hook init: ${e.message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (argv.length > 0) {
    process.stderr.write('usage: strix-egress-prompt-hook [init [--user] [--project-dir DIR] [--command CMD] [--print]]\n');
    process.exitCode = 1;
    return;
  }
  const { evaluatePromptHookInput } = await loadHook();
  const input = await readStdin();
  const out =
    input === null
      ? {
          exitCode: 2,
          stdout: '',
          stderr: 'Strix egress hook: the hook input could not be read in full. Blocked (fail-closed).\n',
        }
      : evaluatePromptHookInput(input, process.env);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}

main().catch(() => {
  process.stderr.write('Strix egress hook: unexpected failure. Blocked (fail-closed).\n');
  process.exitCode = 2;
});
