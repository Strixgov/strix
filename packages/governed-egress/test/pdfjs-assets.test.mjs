import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolvePdfjsRuntimeAssets,
} from '../src/artifact/pdfjs-text.mjs';

const REQUIRED_ASSETS = Object.freeze({
  cMapPath: ['Adobe-Japan1-UCS2.bcmap'],
  standardFontDataPath: ['FoxitSerif.pfb', 'LiberationSans-Regular.ttf'],
  wasmPath: ['openjpeg.wasm', 'qcms_bg.wasm', 'jbig2.wasm'],
});

test('production PDF.js resolver derives readable local CMaps, standard fonts, and wasm', async () => {
  const assets = resolvePdfjsRuntimeAssets();

  for (const [key, files] of Object.entries(REQUIRED_ASSETS)) {
    const root = assets[key];
    assert.equal(typeof root, 'string', `${key} must be a filesystem path`);
    for (const file of files) {
      await access(resolve(root, file));
    }
  }

  assert.match(assets.cMapUrl, /^file:/);
  assert.match(assets.standardFontDataUrl, /^file:/);
  assert.match(assets.wasmUrl, /^file:/);
});

test('the resolver prefers the Vercel-traced console-local runtime directory when supplied', async () => {
  const deploymentRoot = await mkdtemp(resolve(tmpdir(), 'pdfjs-runtime-'));
  const runtimeRoot = resolve(deploymentRoot, '.pdfjs-runtime');

  try {
    const runtimeDirectories = {
      cMapPath: 'cmaps',
      standardFontDataPath: 'standard_fonts',
      wasmPath: 'wasm',
    };
    for (const [assetPath, files] of Object.entries(REQUIRED_ASSETS)) {
      const directory = runtimeDirectories[assetPath];
      await mkdir(resolve(runtimeRoot, directory), { recursive: true });
      await Promise.all(files.map((file) => writeFile(resolve(runtimeRoot, directory, file), 'asset')));
    }

    const assets = resolvePdfjsRuntimeAssets({ deploymentRoot });
    assert.equal(assets.root, runtimeRoot);
  } finally {
    await rm(deploymentRoot, { recursive: true, force: true });
  }
});

test('PDF.js receives the resolved local assets and stays in its hardened Node configuration', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../src/artifact/pdfjs-text.mjs', import.meta.url), 'utf8'),
  );

  assert.match(source, /resolve\(deploymentRoot, '\.pdfjs-runtime'\)/);
  assert.match(source, /\.\.\.assets/);
  assert.match(source, /useWorkerFetch:\s*false/);
  assert.match(source, /stopAtErrors:\s*false/);
  assert.match(source, /isEvalSupported:\s*false/);
  assert.match(source, /isOffscreenCanvasSupported:\s*false/);
});

test('the extractor has no second PDF.js resolver to drift from the active runtime', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../src/artifact/pdfjs-text.mjs', import.meta.url), 'utf8'),
  );
  assert.doesNotMatch(source, /pdfjs-entry-resolution/);
});
