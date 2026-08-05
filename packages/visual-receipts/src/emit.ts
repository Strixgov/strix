/**
 * Visual Receipt emission + store (docs/specs/visual-receipt-v1.md §10, slice 4).
 *
 * The "governed-action → manifest emission" path. After a governed action has
 * produced evidence and a verdict, the runtime calls `emitMc1VisualReceipt` to
 * project + persist a manifest, which the public routes then serve. This makes
 * every governed MC-1 action able to produce a postable, verifiable artifact.
 *
 * Gate G (reliability): emission is derived and non-side-effecting on the
 * evidence. Rendering happens lazily/separately; if a render ever fails the
 * manifest is still stored and the failure is an EXPLICIT recorded state — a
 * render failure must never look like a control success, and must never mutate
 * or fail the governed action. Persisting the manifest never touches the source
 * record (it is read-only input).
 */

import type { VisualReceiptV1, VisualRenderStatus } from "./schema.js";
import type { Verdict } from "./proofState.js";
import {
  mapMc1ToVisualReceipt,
  type McpProofRecordView,
  type MapMc1Options,
} from "./mapMc1ToVisualReceipt.js";
import { renderVisualReceiptSvg } from "./renderSvg.js";

/** A place persisted manifests live so the public routes can serve them.
 *  The runtime supplies a DB-backed impl; `InMemoryVisualReceiptStore` is the
 *  reference (mirrors the EvidenceStore Protocol + InMemory pattern). */
export interface VisualReceiptStore {
  put(manifest: VisualReceiptV1): Promise<void> | void;
  get(sourceId: string): Promise<VisualReceiptV1 | null> | (VisualReceiptV1 | null);
}

export class InMemoryVisualReceiptStore implements VisualReceiptStore {
  private readonly byId = new Map<string, VisualReceiptV1>();
  put(manifest: VisualReceiptV1): void {
    this.byId.set(manifest.sourceId, manifest);
  }
  get(sourceId: string): VisualReceiptV1 | null {
    return this.byId.get(sourceId) ?? null;
  }
  /** Test/inspection helper. */
  size(): number {
    return this.byId.size;
  }
}

export interface EmitResult {
  manifest: VisualReceiptV1;
  /** Explicit render lifecycle (Gate G) — a failed render is recorded, not silent. */
  renderStatus: VisualRenderStatus;
  /** Present on VISUAL_RENDER_FAILED; the manifest is still persisted. */
  renderError?: string;
}

/**
 * Emit a Visual Receipt for a governed MC-1 action: map the (record, verdict)
 * to a manifest, persist it, and attempt a render to surface render health.
 *
 * The verdict MUST come from the verifier (the caller runs `verifyMcpProof`);
 * this function never decides verification — a VERIFIED manifest can only come
 * from a `valid === true` verdict (VR-2). The source record is not mutated.
 */
export async function emitMc1VisualReceipt(
  record: McpProofRecordView,
  verdict: Verdict | null | undefined,
  opts: MapMc1Options,
  store?: VisualReceiptStore,
): Promise<EmitResult> {
  const manifest = mapMc1ToVisualReceipt(record, verdict, opts);

  // Persisting is independent of rendering: store first so the manifest exists
  // even if a renderer later fails (the evidence/verdict are unaffected either way).
  if (store) await store.put(manifest);

  let renderStatus: VisualRenderStatus = "VISUAL_RENDERED";
  let renderError: string | undefined;
  try {
    renderVisualReceiptSvg(manifest); // health check; bytes are produced on demand by the routes
  } catch (e) {
    renderStatus = "VISUAL_RENDER_FAILED";
    renderError = e instanceof Error ? e.message : String(e);
  }

  return renderError ? { manifest, renderStatus, renderError } : { manifest, renderStatus };
}
