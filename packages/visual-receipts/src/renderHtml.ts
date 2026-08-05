/**
 * Standalone HTML renderer (docs/specs/visual-receipt-v1.md §10).
 *
 * Pure display — a function of the manifest only (deterministic, no clock/
 * randomness). Renders the proof layers SEPARATELY (hash / chain / signature /
 * execution / decision — VR-5) and adds no labels of its own (VR-8). Inspectable:
 * it embeds the manifest as JSON so a reader can re-verify from the same bytes.
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

function triState(v: boolean | null | undefined): string {
  return v === true ? "VALID" : v === false ? "INVALID" : "UNKNOWN";
}

function yesNo(v: boolean | null | undefined): string {
  return v === true ? "YES" : v === false ? "NO" : "UNKNOWN";
}

export function renderVisualReceiptHtml(receipt: VisualReceiptV1): string {
  const c = FILL[receipt.proof.color];
  const p = receipt.proof;
  const sample = p.verificationStatus === "SAMPLE_LOCAL";

  const rows: Array<[string, string]> = [
    ["Receipt / source ID", receipt.sourceId],
    ["Capability", receipt.capabilityId],
    ["Action requested", receipt.actionLabel],
    ["Decision", receipt.decisionStatus],
    ["Execution", receipt.executionStatus],
    ["Human approval", receipt.control.humanApprovalRequired ? "REQUIRED" : "—"],
    ["Policy reason", receipt.control.reason ?? "—"],
    ["Source hash", receipt.sourceHash],
    ["Issuer", p.issuer ?? "—"],
    ["Signing key", p.kid ?? "—"],
    ["Algorithm", p.algorithm ?? "—"],
    ["Rendered at", receipt.renderedAt],
  ];

  const layers: Array<[string, string]> = [
    ["Hash integrity", triState(p.hashValid)],
    ["Chain integrity", triState(p.chainValid)],
    ["Signature present", yesNo(p.signaturePresent)],
    ["Signature valid", triState(p.signatureValid)],
    ["Execution status", receipt.executionStatus],
    ["Decision status", receipt.decisionStatus],
  ];
  if (p.failingRule) layers.push(["Failing rule", p.failingRule]);

  const row = ([k, v]: [string, string]) =>
    `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strix Visual Receipt — ${esc(receipt.proof.verificationStatus)} — ${esc(receipt.sourceId)}</title>
<style>
  :root { font-family: Arial, system-ui, sans-serif; color: #1f2328; }
  body { margin: 0; background: #f6f8fa; }
  .card { max-width: 680px; margin: 24px auto; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
  .hd { background: ${c}; color: #fff; padding: 16px 20px; display: flex; justify-content: space-between; align-items: baseline; }
  .hd h1 { font-size: 18px; margin: 0; letter-spacing: .04em; }
  .hd .status { font-weight: bold; font-size: 16px; }
  .sub { padding: 8px 20px; color: #57606a; font-size: 13px; }
  ${sample ? ".watermark{position:relative}.watermark::after{content:'SAMPLE \\00B7 LOCAL';position:absolute;top:40%;left:50%;transform:translate(-50%,-50%) rotate(-18deg);font-size:42px;color:#57606a;opacity:.15;pointer-events:none}" : ""}
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 20px; border-top: 1px solid #eaeef2; font-size: 13px; vertical-align: top; }
  th { color: #57606a; font-weight: 600; width: 40%; }
  td { font-family: ui-monospace, Menlo, monospace; word-break: break-all; }
  .layers th { color: #1f2328; }
  .ft { padding: 14px 20px; border-top: 1px solid #eaeef2; }
  .ft a { color: #0969da; text-decoration: none; word-break: break-all; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #57606a; margin: 16px 20px 0; }
</style></head>
<body><main class="card${sample ? " watermark" : ""}">
  <div class="hd"><h1>STRIX VISUAL RECEIPT · Execution Control Proof</h1><span class="status">${esc(receipt.proof.verificationStatus)}</span></div>
  <p class="sub">${esc(receipt.summary)}</p>
  <table><tbody>${rows.map(row).join("")}</tbody></table>
  <h2>Proof layers</h2>
  <table class="layers"><tbody>${layers.map(row).join("")}</tbody></table>
  <div class="ft">Verify: <a href="${esc(receipt.verificationUrl)}">${esc(receipt.verificationUrl)}</a></div>
  <script type="application/json" id="visual-receipt-manifest">${JSON.stringify(receipt).replace(/</g, "\\u003c")}</script>
</main></body></html>`;
}
