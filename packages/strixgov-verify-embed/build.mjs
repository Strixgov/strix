// Single-file bundler for the embed.
//
// Produces `dist/embed.js` — a self-contained script that, when added
// to any HTTPS page via <script src="…">, registers the <strix-verify>
// custom element.
//
// No external bundler dep (esbuild/rollup) — we just concatenate the
// four source modules (the dep graph is small + acyclic) and strip
// the inter-module import/export statements. Output is plain ES2020
// that all modern browsers run natively. Loadable as a classic script
// or as a module.
//
// Run: `node build.mjs`
// Output: dist/embed.js + dist/embed.min.js (gzipped size estimate logged)

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "src");
const DIST = join(here, "dist");

// Concatenation order: stuff that exports first, stuff that consumes last.
const MODULES = [
  "verifier-browser.mjs",
  "styles.mjs",
  "templates.mjs",
  "web-component.mjs",
];

function stripImportsAndExports(src) {
  // Strip `import { … } from "./…";` and `export ` keywords. Multi-line
  // imports / exports both supported.
  return src
    // Drop relative imports between our own files.
    .replace(/^import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']\.\/.+?["'];?\s*$/gm, "")
    // Drop `export ` keyword from declarations (function / const / class).
    .replace(/^export\s+(default\s+)?/gm, "")
    // Drop `export { … };` re-export blocks.
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "");
}

async function main() {
  await mkdir(DIST, { recursive: true });

  const banner = `/*! @strixgov/verify-embed — MIT — https://verify.strixgov.com/embed
   <strix-verify evidence-id="..."></strix-verify>
   Self-contained client-side WebCrypto verifier. No backend in the trust path.
   Built ${new Date().toISOString()}
*/
(function () {
  "use strict";
`;

  const footer = `
})();
`;

  const sources = await Promise.all(
    MODULES.map(async (m) => {
      const p = join(SRC, m);
      const text = await readFile(p, "utf8");
      return { name: m, code: stripImportsAndExports(text) };
    }),
  );

  // Assemble.
  const body = sources.map((s) => `\n  // ── ${s.name} ─────────────────────────────────────\n${s.code}\n`).join("");
  const bundle = banner + body + footer;

  // Write unminified bundle.
  const outPath = join(DIST, "embed.js");
  await writeFile(outPath, bundle, "utf8");

  // Compute size budget for visibility.
  const raw = await stat(outPath);
  const gz = gzipSync(Buffer.from(bundle, "utf8")).length;

  console.log(`[verify-embed/build] dist/embed.js`);
  console.log(`  raw : ${raw.size.toLocaleString()} bytes`);
  console.log(`  gz  : ${gz.toLocaleString()} bytes (~${(gz / 1024).toFixed(1)} KB)`);
  console.log(`  budget: <15 KB gz (HTTPS / single round trip / under 100ms parse)`);
  if (gz > 15 * 1024) {
    console.warn(`  WARNING: bundle exceeds 15 KB gz budget. Consider minifying.`);
  }
}

main().catch((err) => {
  console.error("[verify-embed/build] failed:", err);
  process.exit(1);
});
