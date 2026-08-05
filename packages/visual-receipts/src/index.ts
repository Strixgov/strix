/**
 * @strixgov/visual-receipts — the human-readable projection of a verification
 * result. MIT (verification-side surface; sits with the open verifier).
 *
 * Visual Receipts render *from* signed evidence after it is verified; they are
 * never the source of truth (docs/specs/visual-receipt-v1.md). The only path to
 * a VERIFIED label is a real verifier verdict with `valid === true`.
 */

export * from "./schema.js";
export { deriveProofState, scrubKid, type Verdict, type ProofStateInput } from "./proofState.js";
export {
  mapMc1ToVisualReceipt,
  type McpProofRecordView,
  type MapMc1Options,
} from "./mapMc1ToVisualReceipt.js";
export {
  mapSignedEvidenceToVisualReceipt,
  type SignedEvidenceView,
  type SignedEvidenceVerdict,
  type MapSignedEvidenceOptions,
} from "./mapSignedEvidenceToVisualReceipt.js";
export { renderVisualReceiptSvg } from "./renderSvg.js";
export { renderVisualReceiptHtml } from "./renderHtml.js";
export { renderVisualReceiptPng, type Rasterizer, type RenderPngOptions } from "./renderPng.js";
export { verifyAndRenderMc1, type VerifyAndRenderResult } from "./verifyAndRender.js";
export {
  emitMc1VisualReceipt,
  InMemoryVisualReceiptStore,
  type VisualReceiptStore,
  type EmitResult,
} from "./emit.js";
