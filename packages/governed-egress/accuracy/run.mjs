#!/usr/bin/env node
/**
 * Per-entity accuracy report, GENERATED — never typed.
 *
 *   node accuracy/run.mjs          # regenerate REPORT.md + report.json
 *   node accuracy/run.mjs --check  # exit 1 if the committed report differs
 *
 * For every labelled identifier in the corpus it records, using the real
 * detector and the real release pipeline:
 *   - detected as its own category / detected under any category;
 *   - survived: the document was released and the value still appears in the
 *     released text. A refused document is SAFE (nothing left) but is counted
 *     separately, because a refusal is not a correct redaction.
 * For every decoy it records whether the detector flagged it (a false
 * positive costs a correct answer, not privacy).
 *
 * A second section replays the recall experiment's adversarial corpora
 * (experiments/jev-recall), which exist to show the detector's documented
 * gaps. Those numbers are meant to look bad.
 *
 * The report carries no timestamp, so regeneration is byte-stable and
 * `--check` can pin it. Numbers only change when the detector, the pipeline,
 * or the corpus changes, and then the diff shows exactly which.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { scanText, DETECTOR_INFO } from '../src/detection/pattern-detector.mjs';
import { prepareDocumentForEgress } from '../src/pipeline.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../src/transformation/tokenizing-transformer.mjs';
import { VERIFICATION_INFO } from '../src/verification/verify.mjs';
import { HEALTHCARE_REFERENCE_POLICY } from '../src/policy/healthcare-reference-policy.mjs';
import { DETECTION_CATEGORIES } from '../src/detection/categories.mjs';
import { DOCS, CORPUS_VERSION } from './corpus.mjs';
import { HELD_OUT, HELD_OUT_VERSION } from './corpus-heldout.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXP = join(HERE, '..', '..', '..', 'experiments', 'jev-recall');

const HARD_CATEGORY = Object.freeze({ person_name: 'PATIENT_NAME', account_number: 'FINANCIAL_ACCOUNT' });

function locate(text, span, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i += 1) {
    at = text.indexOf(span, at + 1);
    if (at === -1) throw new Error(`corpus error: span "${span}" (nth ${nth}) not in document`);
  }
  return { start: at, end: at + span.length };
}

const covers = (f, s) => f.start <= s.start && f.end >= s.end;
const overlaps = (f, s) => f.start < s.end && s.start < f.end;

async function release(text) {
  return prepareDocumentForEgress({
    source: { text },
    prompt: 'Summarize the document.',
    destination: { provider: 'anthropic', service: 'claude' },
    purpose: 'accuracy_report',
    policy: HEALTHCARE_REFERENCE_POLICY,
    deps: { detector: createPatternDetector(), transformer: createTokenizingTransformer() },
  });
}

async function measure(docs, categoryOf) {
  const rows = [];
  const decoyRows = [];
  for (const doc of docs) {
    const findings = scanText(doc.text).findings;
    const prepared = await release(doc.text);
    const released = prepared.outcome === 'PREPARED';
    const releasedLower = released ? prepared.releaseText.toLowerCase() : '';
    for (const t of doc.truth ?? []) {
      const span = locate(doc.text, t.span, t.nth ?? 0);
      const category = categoryOf(t.category);
      rows.push({
        doc: doc.id,
        span: t.span,
        category,
        detectedAsCategory: findings.some((f) => covers(f, span) && f.category === category),
        detectedAny: findings.some((f) => covers(f, span)),
        refused: !released,
        survived: released && releasedLower.includes(t.span.toLowerCase()),
      });
    }
    for (const d of doc.decoys ?? []) {
      const s = typeof d === 'string' ? d : d.span;
      const span = locate(doc.text, s, typeof d === 'string' ? 0 : d.nth ?? 0);
      decoyRows.push({ doc: doc.id, flagged: findings.some((f) => overlaps(f, span)) });
    }
  }
  return { rows, decoyRows };
}

function tally(rows, keys) {
  const out = [];
  for (const key of keys) {
    const r = rows.filter((x) => x.category === key);
    if (r.length === 0) continue;
    out.push({
      category: key,
      identifiers: r.length,
      detectedAsCategory: r.filter((x) => x.detectedAsCategory).length,
      detectedAny: r.filter((x) => x.detectedAny).length,
      survivedRelease: r.filter((x) => x.survived).length,
      inRefusedDocuments: r.filter((x) => x.refused).length,
    });
  }
  return out;
}

async function loadHardCorpora() {
  const out = [];
  for (const file of ['corpus-round1.mjs', 'corpus-round2.mjs', 'corpus-long.mjs']) {
    // A file URL, not a path: on Windows `C:` in a bare path is read as a URL scheme.
    const mod = await import(pathToFileURL(join(EXP, file)).href);
    out.push({ round: String(mod.ROUND), docs: mod.DOCS });
  }
  return out;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

async function build() {
  const main = await measure(DOCS, (c) => c);
  const hard = [];
  for (const { round, docs } of await loadHardCorpora()) {
    const m = await measure(docs, (c) => {
      const mapped = HARD_CATEGORY[c];
      if (!mapped) throw new Error(`unmapped hard-corpus category ${c}`);
      return mapped;
    });
    hard.push({ round, documents: docs.length, byCategory: tally(m.rows, DETECTION_CATEGORIES), decoys: m.decoyRows.length, decoysFlagged: m.decoyRows.filter((d) => d.flagged).length, misses: m.rows.filter((r) => r.survived).map((r) => r.doc) });
  }
  const held = await measure(HELD_OUT, (c) => c);
  return {
    reportVersion: 1,
    detector: DETECTOR_INFO,
    verification: VERIFICATION_INFO,
    corpus: { version: CORPUS_VERSION, documents: DOCS.length, sha256: sha(JSON.stringify(DOCS)) },
    byCategory: tally(main.rows, DETECTION_CATEGORIES),
    decoys: main.decoyRows.length,
    decoysFlagged: main.decoyRows.filter((d) => d.flagged).length,
    flaggedDecoyDocs: main.decoyRows.filter((d) => d.flagged).map((d) => d.doc),
    // Corpus values are invented, so naming them is safe and makes each gap exact.
    survivedIn: main.rows.filter((r) => r.survived).map((r) => ({ doc: r.doc, category: r.category, value: r.span })),
    heldOut: {
      version: HELD_OUT_VERSION,
      documents: HELD_OUT.length,
      sha256: sha(JSON.stringify(HELD_OUT)),
      byCategory: tally(held.rows, DETECTION_CATEGORIES),
      decoys: held.decoyRows.length,
      decoysFlagged: held.decoyRows.filter((d) => d.flagged).length,
      flaggedDecoyDocs: held.decoyRows.filter((d) => d.flagged).map((d) => d.doc),
      survivedIn: held.rows.filter((r) => r.survived).map((r) => ({ doc: r.doc, category: r.category, value: r.span })),
    },
    hardCases: hard,
    proves: 'MEASURED_ON_THIS_CORPUS_ONLY',
  };
}

const pct = (n, d) => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);

function render(r) {
  const lines = [];
  lines.push('# Per-entity accuracy report');
  lines.push('');
  lines.push('> **Generated by `accuracy/run.mjs`; do not edit.** `--check` fails if this file differs from a regeneration.');
  lines.push('>');
  lines.push('> **What this measures, and what it does not.** An invented corpus, written by the author of the detector with knowledge of its rules. It is a regression instrument and a map of known gaps, not an independent benchmark, and nothing here is a guarantee about your documents. A release record still says only `NO_FINDINGS_BY_DETECTOR`.');
  lines.push('');
  lines.push(`Detector \`${r.detector.name}\` ${r.detector.version} · verification \`${r.verification.name}\` ${r.verification.version} · corpus ${r.corpus.version} (${r.corpus.documents} documents, sha256 \`${r.corpus.sha256.slice(0, 16)}…\`)`);
  lines.push('');
  lines.push('## By category');
  lines.push('');
  lines.push('"Survived release" is the number that matters for privacy: the document was released and the value was still in the released text. A value in a refused document left nothing behind, but a refusal is not a correct redaction, so it is counted apart.');
  lines.push('');
  lines.push('| category | identifiers | detected as this category | detected (any category) | survived release | in refused documents |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const c of r.byCategory) {
    lines.push(`| ${c.category} | ${c.identifiers} | ${c.detectedAsCategory} (${pct(c.detectedAsCategory, c.identifiers)}) | ${c.detectedAny} (${pct(c.detectedAny, c.identifiers)}) | **${c.survivedRelease}** | ${c.inRefusedDocuments} |`);
  }
  const total = r.byCategory.reduce((a, c) => a + c.identifiers, 0);
  const survived = r.byCategory.reduce((a, c) => a + c.survivedRelease, 0);
  lines.push('');
  lines.push(`**${survived} of ${total}** labelled identifiers survived into released text.`);
  if (survived) {
    lines.push('');
    lines.push('| document | category | value that survived (invented) |');
    lines.push('|---|---|---|');
    for (const m of r.survivedIn) lines.push(`| ${m.doc} | ${m.category} | \`${m.value}\` |`);
  }
  lines.push('');
  lines.push(`Decoys (look like identifiers, are not): ${r.decoysFlagged} of ${r.decoys} flagged${r.decoysFlagged ? ` (${[...new Set(r.flaggedDecoyDocs)].join(', ')})` : ''}.`);
  lines.push('');
  const h = r.heldOut;
  const hTotal = h.byCategory.reduce((a, c) => a + c.identifiers, 0);
  const hSurv = h.byCategory.reduce((a, c) => a + c.survivedRelease, 0);
  lines.push('## Held-out cases');
  lines.push('');
  lines.push(`\`accuracy/corpus-heldout.mjs\` ${h.version} (${h.documents} documents, sha256 \`${h.sha256.slice(0, 16)}…\`) was committed before the rules meant to cover its forms were written, so those rules could not be fitted to its sentences. Its author still knew which forms the rules would target; it is a check against over-fitting, not an independent benchmark.`);
  lines.push('');
  lines.push(`**${hSurv} of ${hTotal}** held-out identifiers survived into released text. Decoys: ${h.decoysFlagged} of ${h.decoys} flagged${h.decoysFlagged ? ` (${[...new Set(h.flaggedDecoyDocs)].join(', ')})` : ''}.`);
  if (hSurv) {
    lines.push('');
    lines.push('| document | category | value that survived (invented) |');
    lines.push('|---|---|---|');
    for (const m of h.survivedIn) lines.push(`| ${m.doc} | ${m.category} | \`${m.value}\` |`);
  }
  lines.push('');
  lines.push('## Known hard cases');
  lines.push('');
  lines.push('The recall experiment\'s adversarial corpora (`experiments/jev-recall`) target the gaps the detector documents and does not claim to cover: lone surnames, unlisted names, non-Latin names, unlabelled account numbers, names deep in long records. These numbers are expected to be poor; they are the case for the local detection signal (see `docs/architecture/governed-egress-local-signal-design-review-v1.md`), which is not enabled. Since detector 0.8.0 a doctor\'s name is kept by default (a provider, not the patient; operator decision Q1, 2026-10-06), so four labelled names in these corpora (Dr. Varga, Dr. Lincoln, Dr. Mayo, Dr. Ambrose) now count as survived by design, and two clinic names they used to drag along are no longer flagged.');
  lines.push('');
  lines.push('| round | documents | identifiers | survived release | decoys flagged |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const h of r.hardCases) {
    const ids = h.byCategory.reduce((a, c) => a + c.identifiers, 0);
    const surv = h.byCategory.reduce((a, c) => a + c.survivedRelease, 0);
    lines.push(`| ${h.round} | ${h.documents} | ${ids} | **${surv}** | ${h.decoysFlagged} of ${h.decoys} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const report = await build();
const json = `${JSON.stringify(report, null, 2)}\n`;
const md = render(report);
const jsonPath = join(HERE, 'report.json');
const mdPath = join(HERE, 'REPORT.md');

if (process.argv.includes('--check')) {
  let ok = true;
  for (const [p, want] of [[jsonPath, json], [mdPath, md]]) {
    let have = '';
    try { have = readFileSync(p, 'utf8'); } catch { /* missing counts as different */ }
    if (have !== want) { ok = false; console.error(`accuracy: ${p} differs from a regeneration; run node accuracy/run.mjs`); }
  }
  process.exit(ok ? 0 : 1);
}
writeFileSync(jsonPath, json);
writeFileSync(mdPath, md);
console.log(md);
