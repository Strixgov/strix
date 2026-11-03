#!/usr/bin/env node
/**
 * Detector latency, MEASURED on the machine that runs it.
 *
 *   node accuracy/latency.mjs [--runs 200]
 *
 * Times the pattern detector over the committed synthetic corpora. Output is
 * not committed: it depends on the CPU and Node version, so a number copied
 * into a document without its machine would be a claim nobody can check.
 * Quote it with the machine line this script prints. It measures detection
 * only, not a provider call, the optional signal worker, or the network.
 */
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { scanText } from '../src/detection/pattern-detector.mjs';
import { DOCS } from './corpus.mjs';
import { HELD_OUT } from './corpus-heldout.mjs';

const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg > -1 ? Number(process.argv[runsArg + 1]) : 200;
if (!Number.isInteger(RUNS) || RUNS < 10) throw new Error('--runs must be an integer of at least 10');

const base = [...DOCS, ...HELD_OUT].map((d) => d.text);
const sizes = [
  ['single document', base[0]],
  ['all corpus documents joined', base.join('\n\n')],
  ['10x corpus (large paste)', Array(10).fill(base.join('\n\n')).join('\n\n')],
];

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
process.stdout.write(`machine: ${os.cpus()[0]?.model ?? 'unknown'} · node ${process.version} · runs ${RUNS}\n`);
for (const [label, text] of sizes) {
  for (let i = 0; i < 10; i += 1) scanText(text); // warm-up
  const t = [];
  for (let i = 0; i < RUNS; i += 1) {
    const s = performance.now();
    scanText(text);
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  process.stdout.write(`${label.padEnd(30)} ${String(text.length).padStart(8)} chars  p50 ${pct(t, 50).toFixed(2)} ms  p95 ${pct(t, 95).toFixed(2)} ms  max ${t.at(-1).toFixed(2)} ms\n`);
}
