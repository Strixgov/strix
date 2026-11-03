/**
 * Claude Code UserPromptSubmit hook — run the governed-egress detector over a
 * prompt LOCALLY, before Claude Code sends it anywhere.
 *
 * Contract (Claude Code hooks): the hook reads one JSON object on stdin whose
 * `prompt` field is the text the user submitted. Exit code 2 blocks the
 * prompt; Claude Code shows stderr to the user and the prompt is not sent.
 * Exit code 0 lets it through. On exit 0, plain stdout from a UserPromptSubmit
 * hook is ADDED TO THE MODEL'S CONTEXT, so the warn path writes a JSON object
 * whose `systemMessage` is shown to the user instead — nothing about the
 * finding is injected into the conversation.
 *
 * What this module will never do: echo a matched value, echo the prompt, or
 * write anything to disk. The report carries categories and counts only —
 * the same discipline as the evidence records (evidence-no-phi.test.mjs).
 *
 * Fail-closed choices, each deliberate:
 *   - stdin that is not a JSON object with a string `prompt` BLOCKS. A hook
 *     that cannot read the prompt cannot say the prompt is clean, and a
 *     silent pass would read exactly like "scanned, nothing found".
 *   - a detector that throws BLOCKS, for the same reason.
 *   - an unrecognised STRIX_EGRESS_HOOK_MODE BLOCKS (it falls back to the
 *     default, which is block). A typo must never turn enforcement off.
 *
 * Honest ceiling: a clean result means NO FINDINGS BY THIS DETECTOR, never
 * "contains no sensitive data". The detector finds labelled identifiers and
 * pattern-shaped values; a name with no label and no marker word can pass.
 *
 * The detector is imported from its own module, not the package index, so
 * the hook does not load the PDF runtime on every prompt.
 */
import { scanText, DETECTOR_INFO } from '../detection/pattern-detector.mjs';

export const PROMPT_HOOK_MODES = Object.freeze(['block', 'warn']);
export const PROMPT_HOOK_CEILING = 'NO_FINDINGS_BY_DETECTOR';
export const PROMPT_HOOK_MARKER = 'strix-egress-prompt-hook';

/** Resolve the mode from the environment. Anything unrecognised is `block`. */
export function resolveHookMode(env = process.env) {
  const raw = env.STRIX_EGRESS_HOOK_MODE;
  if (raw === undefined || raw === '') return { mode: 'block', recognised: true };
  const v = String(raw).trim().toLowerCase();
  if (PROMPT_HOOK_MODES.includes(v)) return { mode: v, recognised: true };
  return { mode: 'block', recognised: false };
}

/** Count findings per category. Values are read for nothing but the tally. */
export function summarizeFindings(findings) {
  const counts = {};
  for (const f of findings) counts[f.category] = (counts[f.category] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function describeCounts(counts) {
  return Object.entries(counts)
    .map(([c, n]) => `${c} x${n}`)
    .join(', ');
}

/**
 * Pure decision: raw stdin text + env in, { exitCode, stdout, stderr } out.
 * Never throws.
 */
export function evaluatePromptHookInput(stdinText, env = process.env) {
  const { mode, recognised } = resolveHookMode(env);
  const modeNote = recognised
    ? ''
    : ' (STRIX_EGRESS_HOOK_MODE was not "block" or "warn"; defaulting to block)';

  let prompt;
  try {
    const parsed = JSON.parse(stdinText);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.prompt !== 'string') {
      throw new Error('no string "prompt" field');
    }
    prompt = parsed.prompt;
  } catch {
    return {
      exitCode: 2,
      stdout: '',
      stderr:
        'Strix egress hook: could not read the prompt from the hook input, so it cannot say the prompt ' +
        'is clean. Blocked (fail-closed).' + modeNote + '\n',
    };
  }

  let result;
  try {
    result = scanText(prompt);
  } catch {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'Strix egress hook: the detector failed on this prompt. Blocked (fail-closed).' + modeNote + '\n',
    };
  }

  if (!result.detected || result.findings.length === 0) {
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  const counts = summarizeFindings(result.findings);
  const total = result.findings.length;
  const detail =
    `${total} possible identifier${total === 1 ? '' : 's'} (${describeCounts(counts)}) ` +
    `found by ${DETECTOR_INFO.name} ${DETECTOR_INFO.version}. Values are not shown.`;

  if (mode === 'warn') {
    const message =
      `Strix egress hook (warn mode): this prompt contains ${detail} It was sent anyway because ` +
      'STRIX_EGRESS_HOOK_MODE=warn.';
    return { exitCode: 0, stdout: JSON.stringify({ systemMessage: message }) + '\n', stderr: '' };
  }

  return {
    exitCode: 2,
    stdout: '',
    stderr:
      `Strix egress hook: blocked. This prompt contains ${detail} Remove or replace them, or route the ` +
      'content through the governed egress proxy, which tokenizes it before release.' + modeNote + '\n',
  };
}

/**
 * Merge the hook into a Claude Code settings object. Idempotent: an entry
 * whose command already names this hook is replaced, never duplicated, and
 * every other hook is kept. Returns a new object; the input is not mutated.
 */
export function installHookIntoSettings(settings, command) {
  if (typeof command !== 'string' || command.trim() === '') throw new TypeError('command must be a non-empty string');
  if (settings !== undefined && (settings === null || typeof settings !== 'object' || Array.isArray(settings))) {
    throw new TypeError('settings must be a JSON object');
  }
  const next = structuredClone(settings ?? {});
  if (next.hooks === undefined) next.hooks = {};
  if (next.hooks === null || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) {
    throw new TypeError('settings.hooks must be a JSON object');
  }
  const groups = Array.isArray(next.hooks.UserPromptSubmit) ? next.hooks.UserPromptSubmit : [];
  const kept = [];
  for (const g of groups) {
    const hooks = Array.isArray(g?.hooks)
      ? g.hooks.filter((h) => !String(h?.command ?? '').includes(PROMPT_HOOK_MARKER))
      : [];
    if (hooks.length > 0) kept.push({ ...g, hooks });
  }
  kept.push({ hooks: [{ type: 'command', command }] });
  next.hooks.UserPromptSubmit = kept;
  return next;
}
