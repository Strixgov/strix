/**
 * verifyAndRender (docs/specs/visual-receipt-v1.md §5).
 *
 * The composition that guarantees the architecture rule:
 *   visual receipt = render(proofState);  proofState = verify(record)
 *
 * The caller supplies the verifier function (e.g. `verifyMcpProof` from
 * `@strixgov/sdk/mcp-proof`); this helper runs it and feeds the resulting
 * verdict to the mapper. There is no path here that produces a manifest without
 * first running the verifier, so a `VERIFIED` label can only come from a real
 * `valid === true` verdict (VR-2).
 */

import type { VisualReceiptV1 } from "./schema.js";
import type { Verdict } from "./proofState.js";
import {
  mapMc1ToVisualReceipt,
  type McpProofRecordView,
  type MapMc1Options,
} from "./mapMc1ToVisualReceipt.js";
import { renderVisualReceiptSvg } from "./renderSvg.js";
import { renderVisualReceiptHtml } from "./renderHtml.js";

export interface VerifyAndRenderResult {
  manifest: VisualReceiptV1;
  svg: string;
  html: string;
}

/** Verify an MC-1 record with the supplied verifier, then map + render it. */
export function verifyAndRenderMc1(
  record: McpProofRecordView,
  verify: (record: McpProofRecordView) => Verdict,
  opts: MapMc1Options,
): VerifyAndRenderResult {
  const verdict = verify(record); // the verdict is produced HERE, never assumed
  const manifest = mapMc1ToVisualReceipt(record, verdict, opts);
  return {
    manifest,
    svg: renderVisualReceiptSvg(manifest),
    html: renderVisualReceiptHtml(manifest),
  };
}
