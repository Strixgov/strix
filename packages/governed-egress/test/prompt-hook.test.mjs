/**
 * The Claude Code prompt hook. Driven through the real bin as a child
 * process (async spawn, so nothing blocks), plus the pure decision function.
 *
 * The property every test here protects: the hook reports categories and
 * counts and NEVER a matched value or the prompt text, and anything it
 * cannot read is a block, never a pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluatePromptHookInput,
  installHookIntoSettings,
  resolveHookMode,
  PROMPT_HOOK_CEILING,
} from '../src/hooks/prompt-hook.mjs';

const BIN = fileURLToPath(new URL('../bin/strix-egress-prompt-hook.mjs', import.meta.url));

// Synthetic values only.
const NAME = 'Jane Testcase';
const MRN = '00012345';
const PHONE = '555-201-4477';
const DIRTY = `Summarize this. Patient: ${NAME}\nMRN: ${MRN}\nCall back at ${PHONE}.`;
const VALUES = [NAME, 'Testcase', MRN, PHONE];

function runHook(stdin, env = {}) {
  return new Promise((resolve, reject) => {
    const baseEnv = { ...process.env };
    delete baseEnv.STRIX_EGRESS_HOOK_MODE;
    const child = spawn(process.execPath, [BIN], { env: { ...baseEnv, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const hookInput = (prompt) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt });

function assertNoValues(text) {
  for (const v of VALUES) assert.equal(text.includes(v), false, `output leaked "${v}"`);
}

test('a prompt with identifiers is blocked with exit 2, categories and counts on stderr', async () => {
  const r = await runHook(hookInput(DIRTY));
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /blocked/);
  assert.match(r.stderr, /PATIENT_NAME x1/);
  assert.match(r.stderr, /MRN x1/);
  assert.match(r.stderr, /Values are not shown/);
  assertNoValues(r.stderr);
});

test('warn mode lets the prompt through (exit 0) with a user-facing systemMessage only', async () => {
  const r = await runHook(hookInput(DIRTY), { STRIX_EGRESS_HOOK_MODE: 'warn' });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  assert.match(out.systemMessage, /warn mode/);
  assert.match(out.systemMessage, /PATIENT_NAME x1/);
  assertNoValues(r.stdout);
});

test('a clean prompt passes silently (exit 0, nothing added to context)', async () => {
  const r = await runHook(hookInput('Refactor the retry loop in the uploader to use exponential backoff.'));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

for (const [label, stdin] of [
  ['not JSON', 'Patient: Jane Testcase'],
  ['empty', ''],
  ['JSON without prompt', JSON.stringify({ session_id: 's' })],
  ['prompt not a string', JSON.stringify({ prompt: 42 })],
  ['JSON array', JSON.stringify([DIRTY])],
  ['JSON null', 'null'],
]) {
  test(`malformed hook input (${label}) fails closed: exit 2, nothing echoed`, async () => {
    const r = await runHook(stdin);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /fail-closed/);
    assertNoValues(r.stderr + r.stdout);
  });
}

test('malformed input blocks even in warn mode', async () => {
  const r = await runHook('{not json', { STRIX_EGRESS_HOOK_MODE: 'warn' });
  assert.equal(r.code, 2);
});

test('an unrecognised mode blocks (a typo never turns enforcement off)', async () => {
  const r = await runHook(hookInput(DIRTY), { STRIX_EGRESS_HOOK_MODE: 'wran' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /defaulting to block/);
  assertNoValues(r.stderr);
  assert.deepEqual(resolveHookMode({ STRIX_EGRESS_HOOK_MODE: 'off' }), { mode: 'block', recognised: false });
  assert.deepEqual(resolveHookMode({ STRIX_EGRESS_HOOK_MODE: ' WARN ' }), { mode: 'warn', recognised: true });
});

test('the decision function never echoes a value, across many identifier shapes', () => {
  const values = ['123-45-6789', 'jane.testcase@example.com', '4111 1111 1111 1111', '01/02/1970', NAME, MRN];
  const prompt = `Patient: ${NAME}\nSSN: 123-45-6789\nEmail jane.testcase@example.com\nCard 4111 1111 1111 1111\nDOB: 01/02/1970\nMRN: ${MRN}`;
  for (const env of [{}, { STRIX_EGRESS_HOOK_MODE: 'warn' }]) {
    const r = evaluatePromptHookInput(hookInput(prompt), env);
    const all = r.stdout + r.stderr;
    for (const v of values) assert.equal(all.includes(v), false, `leaked "${v}"`);
    assert.equal(all.includes(prompt), false);
  }
  assert.equal(PROMPT_HOOK_CEILING, 'NO_FINDINGS_BY_DETECTOR');
});

test('installHookIntoSettings is idempotent and keeps unrelated hooks', () => {
  const existing = {
    model: 'x',
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-hook' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }],
    },
  };
  const once = installHookIntoSettings(existing, 'node "/opt/strix-egress-prompt-hook.mjs"');
  const twice = installHookIntoSettings(once, 'node "/opt/strix-egress-prompt-hook.mjs"');
  assert.deepEqual(twice, once);
  assert.equal(once.model, 'x');
  assert.deepEqual(once.hooks.PreToolUse, existing.hooks.PreToolUse);
  const commands = once.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(commands, ['other-hook', 'node "/opt/strix-egress-prompt-hook.mjs"']);
  assert.equal(existing.hooks.UserPromptSubmit.length, 1, 'input not mutated');
  assert.throws(() => installHookIntoSettings([], 'c'), TypeError);
});

test('init writes a working project settings file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-hook-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'init', '--project-dir', dir]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(r.code, 0, r.stderr);
  const s = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  const cmd = s.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(cmd, /strix-egress-prompt-hook\.mjs/);
});
