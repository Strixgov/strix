#!/usr/bin/env node
/**
 * Tool-agnostic redaction benchmark over the committed synthetic corpora.
 *
 *   node accuracy/benchmark.mjs --strix [--pack id ...]  # this package's pipeline
 *   node accuracy/benchmark.mjs --cmd "your-redactor"    # any tool: text on stdin,
 *                                                        # redacted text on stdout
 *   ... [--json]
 *
 * For each document the tool returns the text it would release. A non-zero
 * exit is counted as a REFUSAL (safe, but not a correct redaction). Scored
 * per category:
 *   - survived: a labelled identifier still appears (case-insensitive) in the
 *     released text. This is the number that matters for privacy.
 *   - refused: the tool released nothing for that document.
 * And for decoys (codes, ticket numbers, facility names that are NOT
 * identifiers): kept, i.e. still present. Destroying them costs the answer.
 *
 * LIMITS. The corpora are synthetic and written by this package's author,
 * so this is a comparison harness, not an independent benchmark. A tool that
 * rewrites surrounding text can hide a survival from a substring check only
 * by also changing the value, which still counts as removed. See
 * docs/strategy/specs/phi-billing-detection-benchmark-v1.md.
 */
import { spawnSync } from 'node:child_process';
import { DOCS, CORPUS_VERSION } from './corpus.mjs';
import { HELD_OUT, HELD_OUT_VERSION } from './corpus-heldout.mjs';

export async function strixRedactor({ packs = [] } = {}) {
  const { prepareDocumentForEgress } = await import('../src/pipeline.mjs');
  const { createPatternDetector } = await import('../src/detection/pattern-detector.mjs');
  const { createTokenizingTransformer } = await import('../src/transformation/tokenizing-transformer.mjs');
  const { HEALTHCARE_REFERENCE_POLICY } = await import('../src/policy/healthcare-reference-policy.mjs');
  return async (text) => {
    const p = await prepareDocumentForEgress({
      source: { text },
      prompt: 'Summarize the document.',
      destination: { provider: 'anthropic', service: 'claude' },
      purpose: 'benchmark',
      policy: HEALTHCARE_REFERENCE_POLICY,
      deps: { detector: createPatternDetector({ packs }), transformer: createTokenizingTransformer() },
    });
    return p.outcome === 'PREPARED' ? { released: p.releaseText } : { refused: true };
  };
}

export function commandRedactor(cmd) {
  return async (text) => {
    const r = spawnSync(cmd, { shell: true, input: text, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    // A tool that exits before reading its input (EPIPE) still ran and gave an
    // answer: its exit status. Only a tool that could not run at all is an error.
    if (r.error && !(r.error.code === 'EPIPE' && r.status !== null)) {
      throw new Error(`command failed to run: ${r.error.message}`);
    }
    return r.status === 0 ? { released: r.stdout } : { refused: true };
  };
}

export async function runBenchmark(redact, corpora = [['main', DOCS], ['held-out', HELD_OUT]]) {
  const sets = [];
  for (const [name, docs] of corpora) {
    const byCat = new Map();
    let decoys = 0;
    let decoysKept = 0;
    let providerIds = 0;
    let providerKept = 0;
    for (const doc of docs) {
      const out = await redact(doc.text);
      const released = out.refused ? null : String(out.released).toLowerCase();
      for (const t of doc.truth ?? []) {
        const c = byCat.get(t.category) ?? { category: t.category, identifiers: 0, survived: 0, refused: 0 };
        c.identifiers += 1;
        if (released === null) c.refused += 1;
        else if (released.includes(t.span.toLowerCase())) c.survived += 1;
        byCat.set(t.category, c);
      }
      for (const d of doc.decoys ?? []) {
        const s = typeof d === 'string' ? d : d.span;
        decoys += 1;
        if (released !== null && released.includes(s.toLowerCase())) decoysKept += 1;
      }
      // Provider identifiers (Q1): kept by default, replaced only when the
      // deployment opts in with the provider-ids pack. Reported, never scored
      // as survival or as utility loss, because the right answer is a policy.
      for (const s of doc.providerIds ?? []) {
        providerIds += 1;
        if (released !== null && released.includes(s.toLowerCase())) providerKept += 1;
      }
    }
    const rows = [...byCat.values()].sort((a, b) => a.category.localeCompare(b.category));
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    sets.push({ corpus: name, rows, identifiers: sum('identifiers'), survived: sum('survived'), refused: sum('refused'), decoys, decoysKept, providerIds, providerKept });
  }
  return { corpusVersion: CORPUS_VERSION, heldOutVersion: HELD_OUT_VERSION, sets };
}

function render(result, label) {
  const lines = [`tool: ${label} · corpus ${result.corpusVersion} · held-out ${result.heldOutVersion}`];
  for (const s of result.sets) {
    lines.push('', `${s.corpus}: ${s.survived}/${s.identifiers} identifiers survived, ${s.refused} in refused documents, decoys kept ${s.decoysKept}/${s.decoys}${s.providerIds ? `, provider ids kept ${s.providerKept}/${s.providerIds}` : ''}`);
    for (const r of s.rows) lines.push(`  ${r.category.padEnd(20)} ${String(r.survived).padStart(3)}/${String(r.identifiers).padEnd(3)} survived  ${r.refused} refused`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--cmd');
  let redact;
  let label;
  const packs = args.flatMap((a, j) => (a === '--pack' ? [args[j + 1]] : []));
  if (args.includes('--strix')) { redact = await strixRedactor({ packs }); label = `strix governed-egress pipeline${packs.length ? ` + packs ${packs.join(', ')}` : ''}`; }
  else if (i > -1 && args[i + 1]) { redact = commandRedactor(args[i + 1]); label = args[i + 1]; }
  else { process.stderr.write('usage: benchmark.mjs --strix | --cmd "<command>" [--json]\n'); process.exit(2); }
  const result = await runBenchmark(redact);
  process.stdout.write(args.includes('--json') ? `${JSON.stringify({ tool: label, ...result }, null, 2)}\n` : `${render(result, label)}\n`);
}
