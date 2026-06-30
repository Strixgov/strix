/**
 * capture.mjs — render the visual/*.html pages to PNG stills and a step-by-step
 * reveal GIF for the lead package.
 *
 * Run locally (needs a browser):
 *   npm run visualize           # produce visual/*.html
 *   npx playwright install chromium
 *   npm run shots               # writes shots/<id>.png and shots/<id>.gif
 *
 * Deps (devDependencies): playwright, pngjs, gifenc. They are intentionally
 * optional — this in-CI/sandbox container has no browser, so the durable
 * artifact is the HTML; this script is the convenience layer for ready-made
 * images. All three imports fail with a clear message if not installed.
 *
 * SAFETY: renders local HTML only (file://). No network, no live endpoints.
 */

import { readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.cwd());
const VISUAL_DIR = join(ROOT, 'visual');
const OUT_DIR = join(ROOT, 'shots');

const WIDTH = Number(process.env.SHOT_WIDTH ?? 1180);
const FRAME_DELAY = Number(process.env.SHOT_FRAME_MS ?? 650); // per reveal step
const HOLD_DELAY = Number(process.env.SHOT_HOLD_MS ?? 2200); // final frame hold
const wantGif = !process.argv.includes('--no-gif');
const wantPng = !process.argv.includes('--no-png');

async function load(name) {
  try {
    return await import(name);
  } catch {
    throw new Error(
      `Missing dependency "${name}". Install the capture deps locally:\n` +
        `  npm install -D playwright pngjs gifenc\n` +
        `  npx playwright install chromium\n` +
        `Then re-run: npm run shots`
    );
  }
}

function scenarioPages() {
  if (!existsSync(VISUAL_DIR)) {
    throw new Error(`No visual/ directory. Run "npm run visualize" first.`);
  }
  return readdirSync(VISUAL_DIR)
    .filter((f) => f.endsWith('.html') && f !== 'index.html')
    .map((f) => ({ id: f.replace(/\.html$/, ''), file: join(VISUAL_DIR, f) }));
}

async function captureStill(page, file, outPng) {
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
  await page.screenshot({ path: outPng, fullPage: true });
}

async function captureGif(page, file, outGif, PNG, gifenc) {
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });

  // Hide everything that should "reveal", keeping the framing context visible.
  await page.addStyleTag({ content: '.card,.summary{visibility:hidden!important}' });

  // Reveal order: top-to-bottom across both columns so the two runs progress
  // in parallel and the contrast reads naturally.
  const handles = await page.$$('.card, .summary');
  const items = [];
  for (const h of handles) {
    const box = await h.boundingBox();
    if (box) items.push({ h, top: box.y, left: box.x });
  }
  items.sort((a, b) => a.top - b.top || a.left - b.left);

  const { GIFEncoder, quantize, applyPalette } = gifenc;
  const gif = GIFEncoder();
  let width = 0;
  let height = 0;

  const addFrame = async (delay) => {
    const buf = await page.screenshot({ fullPage: true });
    const png = PNG.sync.read(buf);
    width = png.width;
    height = png.height;
    const palette = quantize(png.data, 256);
    const index = applyPalette(png.data, palette);
    gif.writeFrame(index, width, height, { palette, delay });
  };

  await addFrame(FRAME_DELAY); // opening frame: context only
  for (let i = 0; i < items.length; i++) {
    await items[i].h.evaluate((el) => (el.style.visibility = 'visible'));
    const last = i === items.length - 1;
    await addFrame(last ? HOLD_DELAY : FRAME_DELAY);
  }
  gif.finish();
  writeFileSync(outGif, Buffer.from(gif.bytes()));
}

async function main() {
  const { chromium } = await load('playwright');
  const pngMod = wantGif ? await load('pngjs') : null;
  const gifencRaw = wantGif ? await load('gifenc') : null;
  // gifenc ships CJS; under ESM dynamic import the named exports can land on
  // `.default` rather than the namespace root. Pick whichever actually carries
  // GIFEncoder so the destructure in captureGif() works on every Node/npm combo.
  const gifenc = gifencRaw
    ? (typeof gifencRaw.GIFEncoder === 'function' ? gifencRaw : gifencRaw.default)
    : null;
  const PNG = pngMod?.PNG ?? pngMod?.default?.PNG;

  const pages = scenarioPages();
  if (pages.length === 0) throw new Error('No scenario pages found in visual/.');
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  for (const { id, file } of pages) {
    if (wantPng) {
      const outPng = join(OUT_DIR, `${id}.png`);
      await captureStill(page, file, outPng);
      console.log(`wrote shots/${id}.png`);
    }
    if (wantGif) {
      const outGif = join(OUT_DIR, `${id}.gif`);
      await captureGif(page, file, outGif, PNG, gifenc);
      console.log(`wrote shots/${id}.gif`);
    }
  }

  await browser.close();
  console.log(`\nDone. Stills + GIFs in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('\n' + (err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
});
