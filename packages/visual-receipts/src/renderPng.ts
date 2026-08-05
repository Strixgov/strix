/**
 * PNG renderer (docs/specs/visual-receipt-v1.md §10).
 *
 * PNG is the shareable format; the SVG/manifest stay the inspectable source.
 * Rasterization needs a real renderer — this package will not pretend. The
 * rasterizer is pluggable (inject one in tests / on the server) and defaults to
 * the optional `@resvg/resvg-js` peer, lazily imported. If no rasterizer is
 * available it fails closed with a clear error rather than emitting a fake image.
 */

import type { VisualReceiptV1 } from "./schema.js";
import { renderVisualReceiptSvg } from "./renderSvg.js";

/** SVG → PNG bytes. Server pipeline injects this; default uses @resvg/resvg-js. */
export type Rasterizer = (svg: string) => Uint8Array | Promise<Uint8Array>;

export interface RenderPngOptions {
  rasterize?: Rasterizer;
}

async function defaultRasterize(svg: string): Promise<Uint8Array> {
  let mod: { Resvg: new (s: string) => { render(): { asPng(): Uint8Array } } };
  try {
    // Optional peer — not a hard dependency of this MIT package. The specifier
    // is assembled at runtime (.join) so a bundler cannot constant-fold it into
    // a static request and try to resolve the (deliberately uninstalled) module
    // at build time. A plain `const peer = "@resvg/resvg-js"` IS folded by
    // Next 16 / Turbopack and hard-fails the build with "Module not found"; the
    // .join keeps it opaque and the ignore comments cover analyzers that still
    // inspect the call. Genuine runtime-only import.
    const peer = ["@resvg", "resvg-js"].join("/");
    mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ peer)) as unknown as typeof mod;
  } catch {
    throw new Error(
      "renderVisualReceiptPng: no rasterizer available. Install @resvg/resvg-js " +
        "or pass opts.rasterize. PNG output requires a real renderer — a placeholder " +
        "image would misrepresent the receipt.",
    );
  }
  return new mod.Resvg(svg).render().asPng();
}

export async function renderVisualReceiptPng(
  receipt: VisualReceiptV1,
  opts: RenderPngOptions = {},
): Promise<Uint8Array> {
  const svg = renderVisualReceiptSvg(receipt);
  const rasterize = opts.rasterize ?? defaultRasterize;
  return rasterize(svg);
}
