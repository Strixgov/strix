#!/usr/bin/env node
/**
 * strix-claude — wire Strix governance into Claude Code in one command.
 *
 *   npx @strixgov/claude-code init        # add the PreToolUse hook to .claude/settings.json
 *   npx @strixgov/claude-code hook         # the hook runtime (Claude Code calls this; stdin→stdout)
 *   npx @strixgov/claude-code policy       # print the effective policy
 *
 * `init` touches ONLY .claude/settings.json (and creates a local receipt dir).
 * It never modifies your code, your agent, or your workflow — the whole point
 * of the no-fork adapter.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { buildEngine, coverageReport } from '../src/decide.mjs';
import { runHook } from '../src/hook.mjs';

const HOOK_COMMAND = 'npx -y @strixgov/claude-code hook';
const RECEIPT_DIR_DEFAULT = '.strix/claude-code';

function settingsPathFor({ global, projectDir }) {
  return global
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(projectDir, '.claude', 'settings.json');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Idempotently add our PreToolUse hook to a settings object. Returns {changed}. */
function ensureHook(settings) {
  settings.hooks ??= {};
  const arr = (settings.hooks.PreToolUse ??= []);
  const already = JSON.stringify(arr).includes('@strixgov/claude-code');
  if (already) return { changed: false };
  arr.push({
    matcher: '*', // all built-in tools; the policy decides per-capability
    hooks: [{ type: 'command', command: HOOK_COMMAND }],
  });
  return { changed: true };
}

function cmdInit(args) {
  const global = args.includes('--global');
  const projectDir = process.cwd();
  const file = settingsPathFor({ global, projectDir });
  const existing = (fs.existsSync(file) && readJsonSafe(file)) || {};
  const before = JSON.stringify(existing);
  const { changed } = ensureHook(existing);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');

  const receiptDir = path.join(projectDir, RECEIPT_DIR_DEFAULT);
  fs.mkdirSync(receiptDir, { recursive: true });

  console.log(`Strix governance wired into Claude Code.\n`);
  console.log(`  settings:  ${file}${changed ? ' (PreToolUse hook added)' : ' (hook already present — no change)'}`);
  console.log(`  receipts:  ${receiptDir}/  (signed decision receipts land here)\n`);
  if (before !== JSON.stringify(existing) && fs.existsSync(file)) {
    // (existing settings preserved; we only appended our hook entry)
  }
  console.log(`What this governs now (no changes to your code or workflow):`);
  console.log(`  • Bash / Edit / Write / NotebookEdit / Task / WebFetch / Skill → require approval`);
  console.log(`  • Read / Glob / Grep / WebSearch / … → allowed, with signed evidence`);
  console.log(`  • anything unclassified → denied (fail-closed)\n`);
  console.log(`Tighten any rule by editing the policy (see: npx @strixgov/claude-code policy).`);
  console.log(`Verify a decision receipt offline:  npx @strixgov/verifier <receiptId>\n`);
  console.log(`Also governing external MCP servers Claude Code connects to?`);
  console.log(`  Point them through the proxy:  https://www.npmjs.com/package/@strixgov/mcp-proxy`);
}

async function cmdHook() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Malformed/unknown hook payload (e.g. a Claude Code version change): defer
    // to the human rather than brick the session or silently allow.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'Strix: could not parse the PreToolUse payload; deferring to you.',
        },
      }) + '\n',
    );
    return;
  }

  // Best-effort signing key + storage. Loaded lazily so `init`/`policy` never
  // need the gateway key machinery.
  let signingKey;
  let storage;
  try {
    const { loadOrCreateSigningKey, JsonlStorage } = await import('@strixgov/tool-gateway');
    const keyDir = process.env.STRIX_CLAUDE_KEY_DIR || path.join(process.cwd(), RECEIPT_DIR_DEFAULT, 'keys');
    signingKey = await loadOrCreateSigningKey({ keyPath: keyDir });
    storage = new JsonlStorage({ dir: process.env.STRIX_CLAUDE_STORAGE || path.join(process.cwd(), RECEIPT_DIR_DEFAULT) });
  } catch {
    signingKey = undefined; // decision still emitted without a receipt (fail-open on evidence, not on decision)
  }

  const { hookOutput, receiptError } = await runHook({ payload, signingKey, storage });
  if (receiptError) process.stderr.write(`[strix-claude] receipt note: ${receiptError}\n`);
  process.stdout.write(JSON.stringify(hookOutput) + '\n');
}

function cmdPolicy() {
  const engine = buildEngine();
  console.log(JSON.stringify({ policyVersion: engine.version, ruleset: engine.ruleset }, null, 2));
}

/** True if a Strix PreToolUse hook is wired into the given settings object. */
function hookInstalled(settings) {
  const pre = settings?.hooks?.PreToolUse;
  return Array.isArray(pre) && JSON.stringify(pre).includes('@strixgov/claude-code');
}

function cmdDoctor(args) {
  const asJson = args.includes('--json');
  const global = args.includes('--global');
  const file = settingsPathFor({ global, projectDir: process.cwd() });
  const settings = (fs.existsSync(file) && readJsonSafe(file)) || {};
  const installed = hookInstalled(settings);
  const report = coverageReport(buildEngine());
  // Enforced coverage is the policy coverage ONLY if the hook is actually wired.
  const enforcedPct = installed ? report.coveragePct : 0;

  if (asJson) {
    console.log(JSON.stringify({ hookInstalled: installed, enforcedCoveragePct: enforcedPct, ...report }, null, 2));
    return;
  }

  console.log('Analyzing Claude Code governance…\n');
  console.log(`  PreToolUse hook: ${installed ? 'installed ✓' : 'NOT installed ✗  → run: npx @strixgov/claude-code init'}`);
  console.log(`  settings:        ${file}\n`);
  for (const t of report.tools) {
    const glyph = !installed ? '✗' : t.gated ? '🔒' : t.decision === 'ALLOW' ? '✓' : '✗';
    const label = t.gated ? `governed (${t.decision === 'DENY' ? 'deny' : 'approval'})` : t.decision === 'ALLOW' ? 'allowed + evidence' : t.decision.toLowerCase();
    console.log(`  ${glyph} ${t.name.padEnd(16)} ${t.mode.padEnd(8)} ${label}`);
  }
  const bar = (pct) => { const n = Math.round(pct / 10); return '█'.repeat(n) + '░'.repeat(10 - n); };
  console.log(`\n  Coverage (dangerous tools governed): ${bar(enforcedPct)} ${enforcedPct}%`);
  console.log(`    ${report.consequential.gated}/${report.consequential.total} of Bash/Edit/Write/NotebookEdit/Task/WebFetch/Skill gated`);
  if (!installed) {
    console.log(`\n  Nothing is enforced until the hook is installed. Run: npx @strixgov/claude-code init`);
  } else if (enforcedPct < 100) {
    console.log(`\n  Want 100%? Tighten the remaining tools in your policy (npx @strixgov/claude-code policy).`);
  } else {
    console.log(`\n  Every dangerous tool (Bash/Edit/Write/NotebookEdit/Task/WebFetch/Skill) is governed. Verify any decision: npx @strixgov/verifier <receiptId>`);
  }
}

async function cmdBenchmark(args) {
  const asJson = args.includes('--json');
  const outIdx = args.indexOf('--out');
  const { runBenchmark, formatMarkdown } = await import('../benchmark/run-benchmark.mjs');
  const result = await runBenchmark();
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatMarkdown(result));
  }
  if (outIdx !== -1 && args[outIdx + 1]) {
    const dir = args[outIdx + 1];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'results.md'), formatMarkdown(result) + '\n');
    console.error(`\n[strix-claude] wrote results.json + results.md to ${dir}`);
  }
  // Fail the process if a load-bearing claim is false, a receipt failed to
  // verify, or any governed call failed to mint a receipt (CI-usable).
  if (!result.headline.claim_default_zero_auto_exec || !result.headline.claim_strict_all_denied
      || result.receipts.failures.length || !result.receipts.complete) {
    process.exitCode = 1;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'init':
      return cmdInit(rest);
    case 'hook':
      return cmdHook();
    case 'policy':
      return cmdPolicy();
    case 'doctor':
      return cmdDoctor(rest);
    case 'benchmark':
      return cmdBenchmark(rest);
    case undefined:
    case '--help':
    case '-h':
      console.log('Usage: strix-claude <init|doctor|benchmark|hook|policy> [--global] [--json] [--out DIR]');
      console.log('  init       add the Strix PreToolUse hook to .claude/settings.json (no code changes)');
      console.log('  doctor     report governance coverage over Claude Code\'s tool surface');
      console.log('  benchmark  run the adversarial attack corpus through the policy + verify receipts');
      console.log('  hook       the hook runtime Claude Code invokes (stdin → stdout)');
      console.log('  policy     print the effective governance policy');
      return;
    default:
      console.error(`strix-claude: unknown command "${cmd}". Try: init | hook | policy`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
