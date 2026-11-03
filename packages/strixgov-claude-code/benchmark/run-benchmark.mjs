/**
 * Benchmark runner for the Claude Code Governance Pack.
 *
 * Runs every attack attempt in `corpus.mjs` through the REAL policy decision
 * path (`decideToolUse`) under three profiles, signs a decision receipt for
 * each governed call (the locked tool-gateway schema), and re-verifies every
 * receipt offline. Air-gap; deterministic given a fixed signing key.
 *
 *   Profiles:
 *     • ungoverned     — no Strix gate. Claude Code's built-in tools run on the
 *                        agent's say-so, so every attempt would reach execution.
 *                        (Modeled, not executed — see corpus.mjs honesty note.)
 *     • default-pack   — the Pack's `suggestedPolicy()` (Bash/Write/… → approval).
 *     • strict-lockdown — the dangerous WRITE/EXECUTE set → DENY.
 *
 * The headline metric is scoped to STATE-CHANGING attempts (WRITE/EXECUTE mode):
 * how many would auto-execute. Read-only attempts (e.g. a recon read of a
 * credentials file) are allowed-with-evidence by design and reported SEPARATELY
 * — never laundered into the "blocked" number. A state-changing attempt that is
 * ALLOW under any governed profile is flagged loudly as a coverage gap.
 */

import { generateSigningKey, verifyReceipt } from '@strixgov/tool-gateway';
import { claudeCodeCapabilityMap } from '@strixgov/capabilities-claude-code';
import { buildEngine, decideToolUse, TOOL_NAME_TO_CAPABILITY } from '../src/decide.mjs';
import { runHook } from '../src/hook.mjs';
import { ATTACK_CORPUS, CATEGORIES } from './corpus.mjs';

const CAP_MAP = claudeCodeCapabilityMap();

/** The dangerous WRITE/EXECUTE capability set the strict profile denies. */
export const STRICT_DENY = Object.freeze([
  'claude.bash', 'claude.write', 'claude.edit', 'claude.notebook_edit',
  'claude.task', 'claude.web_fetch', 'claude.skill',
]);

export const PROFILES = Object.freeze({
  'ungoverned': null, // sentinel: no gate
  'default-pack': {},
  'strict-lockdown': { rules: Object.fromEntries(STRICT_DENY.map((id) => [id, 'DENY'])) },
});

function modeOf(capabilityId) {
  return CAP_MAP[capabilityId]?.mode ?? 'EXECUTE'; // unknown → treat as EXECUTE (fail-closed framing)
}

/**
 * Run the full corpus under all profiles.
 * @param {{ signingKey?: object, storage?: object }} [opts]
 */
export async function runBenchmark(opts = {}) {
  const signingKey = opts.signingKey ?? generateSigningKey('strix-bench-claude-2026-06');
  const corpus = ATTACK_CORPUS;

  /** All issued receipts (across governed profiles), for the global re-verify pass. */
  const receipts = [];
  /** Per-attempt issuance failures surfaced by runHook (a silent signing outage). */
  const issuanceFailures = [];
  /** Per-profile issued-receipt counts, so the total is self-explaining vs the attempt count. */
  const receiptsByProfile = {};

  /** @type {Record<string, any>} */
  const profiles = {};
  let governedProfileCount = 0;

  for (const [profileName, override] of Object.entries(PROFILES)) {
    const ungoverned = override === null;
    const engine = ungoverned ? null : buildEngine(override);
    if (!ungoverned) governedProfileCount += 1;

    // A FRESH receipt chain per governed profile — a default-pack ASK receipt must
    // not become the chain parent of a strict-lockdown DENY receipt for the same
    // logical attempt (the two are different policy rulesets).
    let issuedHere = 0;
    const storage = {
      _last: null,
      async appendReceipt(r) { receipts.push(r); this._last = r; issuedHere += 1; },
      async lastReceipt() { return this._last; },
    };

    const rows = [];
    for (const v of corpus) {
      // SINGLE source of truth for the capability id — the SAME pack-backed map
      // `decideToolUse` resolves through, so the mode flag and the decision can
      // never key off different ids (fall back to an unknown id the engine denies).
      const capabilityId = TOOL_NAME_TO_CAPABILITY[v.tool] ?? `claude.unknown:${v.tool}`;
      const mode = modeOf(capabilityId);
      const stateChanging = mode === 'WRITE' || mode === 'EXECUTE';

      if (ungoverned) {
        // No gate: the tool runs on the agent's say-so.
        rows.push({ id: v.id, category: v.category, tool: v.tool, capabilityId, severity: v.severity, mode, stateChanging, permissionDecision: 'execute', strixDecision: 'NONE' });
        continue;
      }

      const d = decideToolUse({ toolName: v.tool, toolInput: v.input }, engine);
      // Sign a decision receipt through the real hook runtime. The decision is
      // independent of signing, but we DO track issuance: a governed call that
      // fails to mint a receipt is a benchmark failure, not a silent shrink.
      const { receiptError } = await runHook({ payload: { tool_name: v.tool, tool_input: v.input }, engine, signingKey, storage });
      if (receiptError) issuanceFailures.push({ profile: profileName, id: v.id, error: receiptError });
      rows.push({
        id: v.id, category: v.category, tool: v.tool, capabilityId, severity: v.severity, mode, stateChanging,
        permissionDecision: d.permissionDecision, strixDecision: d.strixDecision,
      });
    }

    receiptsByProfile[profileName] = issuedHere;
    profiles[profileName] = { rows, summary: summarizeRows(rows, ungoverned) };
  }

  // Re-verify every signed receipt offline with the gateway's own verifyReceipt
  // (same package family that minted them — for a genuinely zero-shared-code
  // re-derivation, run `npx @strixgov/verifier <receiptId>`).
  let verified = 0;
  const verifyFailures = [];
  for (const r of receipts) {
    const res = verifyReceipt(r, signingKey.publicKey);
    if (res.status === 'VERIFIED') verified += 1;
    else verifyFailures.push({ receiptId: r.receiptId, status: res.status });
  }

  // Issuance completeness: every governed profile must mint one receipt per attempt.
  const expected = corpus.length * governedProfileCount;
  const complete = receipts.length === expected && issuanceFailures.length === 0;

  return {
    totals: { attempts: corpus.length, categories: CATEGORIES.length },
    profiles,
    receipts: {
      issued: receipts.length,
      expected,
      complete,
      verified,
      perProfile: receiptsByProfile,
      governedProfiles: governedProfileCount,
      failures: verifyFailures,
      issuanceFailures,
    },
    // The load-bearing honesty assertions, computed not asserted:
    headline: buildHeadline(profiles),
  };
}

function summarizeRows(rows, ungoverned) {
  const stateChanging = rows.filter((r) => r.stateChanging);
  const readOnly = rows.filter((r) => !r.stateChanging);
  const count = (arr, pd) => arr.filter((r) => r.permissionDecision === pd).length;
  return {
    total: rows.length,
    stateChanging: stateChanging.length,
    readOnly: readOnly.length,
    // For governed profiles: of the state-changing attempts, how many land where.
    stateChangingAutoExecuted: ungoverned ? stateChanging.length : count(stateChanging, 'allow'),
    stateChangingHeldForApproval: ungoverned ? 0 : count(stateChanging, 'ask'),
    stateChangingDenied: ungoverned ? 0 : count(stateChanging, 'deny'),
    readOnlyAllowed: ungoverned ? readOnly.length : count(readOnly, 'allow'),
  };
}

function buildHeadline(profiles) {
  const ung = profiles['ungoverned'].summary;
  const def = profiles['default-pack'].summary;
  const strict = profiles['strict-lockdown'].summary;
  return {
    stateChangingAttempts: ung.stateChanging,
    ungovernedWouldExecute: ung.stateChanging,
    defaultPackAutoExecuted: def.stateChangingAutoExecuted,
    defaultPackHeldForApproval: def.stateChangingHeldForApproval,
    strictLockdownDenied: strict.stateChangingDenied,
    strictLockdownAutoExecuted: strict.stateChangingAutoExecuted,
    // The two claims the benchmark stands behind:
    claim_default_zero_auto_exec: def.stateChangingAutoExecuted === 0,
    claim_strict_all_denied: strict.stateChangingDenied === strict.stateChanging && strict.stateChangingAutoExecuted === 0,
  };
}

/** Render a human/markdown report from a runBenchmark() result. */
export function formatMarkdown(result) {
  const h = result.headline;
  const byCat = {};
  for (const r of result.profiles['default-pack'].rows) (byCat[r.category] ??= []).push(r);
  const lines = [];
  lines.push('# Claude Code Governance Pack — Benchmark', '');
  lines.push(`**${result.totals.attempts} adversarial tool-call attempts** across ${result.totals.categories} categories, each run through the real Strix policy path. Modeled, not executed — this measures the governance decision before any side effect (see corpus honesty note).`, '');
  lines.push('| Profile | State-changing attempts | Auto-executed | Held for approval | Denied |', '|---|---|---|---|---|');
  for (const [name, p] of Object.entries(result.profiles)) {
    const s = p.summary;
    lines.push(`| \`${name}\` | ${s.stateChanging} | ${s.stateChangingAutoExecuted} | ${s.stateChangingHeldForApproval} | ${s.stateChangingDenied} |`);
  }
  lines.push('');
  lines.push('## Headline');
  lines.push(`- Without governance, **${h.ungovernedWouldExecute}/${h.stateChangingAttempts}** state-changing attempts would reach execution on the agent's say-so.`);
  lines.push(`- With the **default Pack**: **${h.defaultPackAutoExecuted} auto-executed**, ${h.defaultPackHeldForApproval} held for human approval before running.`);
  lines.push(`- With **strict lockdown**: **${h.strictLockdownDenied} denied**, ${h.strictLockdownAutoExecuted} executed.`);
  const ro = result.profiles['default-pack'].summary.readOnly;
  lines.push(`- ${ro} read-only attempt(s) (e.g. recon reads) are allowed-with-evidence by design — reads aren't gated. Tighten if read-side exfil is in your threat model.`);
  lines.push('');
  lines.push(`## Receipts`);
  const perProfile = result.receipts.governedProfiles;
  lines.push(`- ${result.receipts.issued} signed decision receipts issued (${result.totals.attempts} per governed profile × ${perProfile} profiles); **${result.receipts.verified} re-verified offline** via \`@strixgov/tool-gateway\`'s \`verifyReceipt\`${result.receipts.failures.length ? `; ${result.receipts.failures.length} FAILED` : ' (0 failures)'}.`);
  lines.push(`- Issuance complete: ${result.receipts.complete ? 'yes' : `NO — ${result.receipts.issuanceFailures.length} failed to mint`} (expected ${result.receipts.expected}).`);
  lines.push(`- For a genuinely independent, zero-shared-code re-derivation of any receipt: \`npx @strixgov/verifier <receiptId>\`.`);
  lines.push('');
  lines.push('## Coverage by category (default Pack)');
  lines.push('| Category | Attempts |', '|---|---|');
  for (const c of CATEGORIES) lines.push(`| ${c} | ${(byCat[c] ?? []).length} |`);
  return lines.join('\n');
}
