/**
 * Deterministic SVG renderer (docs/specs/visual-receipt-v1.md §10, slice 1).
 *
 * Pure display: a function of the manifest only — no clock, no randomness — so
 * output is stable for snapshot tests and reproducible (VR-9). It renders
 * exactly the proof state it is handed and adds no labels of its own (VR-8); a
 * SAMPLE_LOCAL manifest gets a visible watermark (VR-6).
 */

import type { VisualReceiptV1, TriStateColor } from "./schema.js";

const FILL: Record<TriStateColor, string> = {
  GREEN: "#1a7f37",
  RED: "#c0392b",
  YELLOW: "#b58105",
  SLATE: "#57606a",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] as string),
  );
}

export function renderVisualReceiptSvg(receipt: VisualReceiptV1): string {
  const c = FILL[receipt.proof.color];
  const status = receipt.proof.verificationStatus;
  const watermark =
    status === "SAMPLE_LOCAL"
      ? `<text x="300" y="150" text-anchor="middle" font-family="Arial" font-size="48" fill="#57606a" opacity="0.18" transform="rotate(-18 300 150)">SAMPLE · LOCAL</text>`
      : "";

  // Decision and execution rendered separately (VR-5).
  const lines = [
    `Decision: ${receipt.decisionStatus}`,
    `Execution: ${receipt.executionStatus}`,
    `Capability: ${receipt.capabilityId}`,
    receipt.proof.kid ? `Key: ${receipt.proof.kid}` : "",
    receipt.proof.failingRule ? `Failing rule: ${receipt.proof.failingRule}` : "",
  ].filter(Boolean);

  const body = lines
    .map((t, i) => `<text x="24" y="${120 + i * 24}" font-family="Arial" font-size="14" fill="#1f2328">${esc(t)}</text>`)
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300" role="img" aria-label="${esc(status)} tool action receipt">`,
    `<rect width="600" height="300" fill="#ffffff" stroke="#d0d7de"/>`,
    watermark,
    `<rect x="0" y="0" width="600" height="56" fill="${c}"/>`,
    `<text x="24" y="36" font-family="Arial" font-size="22" font-weight="bold" fill="#ffffff">${esc(receipt.title)}</text>`,
    `<text x="576" y="36" text-anchor="end" font-family="Arial" font-size="18" font-weight="bold" fill="#ffffff">${esc(status)}</text>`,
    `<text x="24" y="92" font-family="Arial" font-size="14" fill="#57606a">${esc(receipt.summary)}</text>`,
    body,
    `<text x="24" y="276" font-family="Arial" font-size="12" fill="#0969da">Verify: ${esc(receipt.verificationUrl)}</text>`,
    `</svg>`,
  ].join("");
}
