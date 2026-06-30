// HTML template generators for each verification state.
// Pure functions; return strings to be injected into the shadow DOM.

import { LOGO_SVG, ICONS } from "./styles.mjs";

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function head(evidenceId) {
  return /* html */ `
    <div class="head">
      <div class="head-left">
        ${LOGO_SVG}
        <span>strix-verify</span>
      </div>
      <div class="head-id">#${esc(evidenceId)}</div>
    </div>
  `;
}

function footer(evidenceId) {
  return /* html */ `
    <div class="footer">
      <span>verify any record at <a href="https://verify.strixgov.com/" target="_blank" rel="noopener">verify.strixgov.com</a></span>
      <a href="https://verify.strixgov.com/?id=${encodeURIComponent(evidenceId)}" target="_blank" rel="noopener">open ↗</a>
    </div>
  `;
}

function complianceBadges(compliance) {
  if (!compliance) return "";
  const flags = [
    { key: "article12_traceable", label: "Art. 12 Traceable" },
    { key: "article12_tamper_resistant", label: "Art. 12 Tamper-Resistant" },
    { key: "article14_oversight_supported", label: "Art. 14 Oversight" },
    { key: "article28_audit_ready", label: "Art. 28 Audit Ready" },
  ];
  return /* html */ `
    <div class="compliance">
      ${flags.map((f) => {
        const ok = !!compliance[f.key];
        return `<span class="pill ${ok ? "ok" : "no"}">${ok ? "✓ " : "✗ "}${esc(f.label)}</span>`;
      }).join("")}
    </div>
  `;
}

function detailsRow(label, value, modifier = "") {
  return /* html */ `
    <div class="details-row">
      <span class="details-label">${esc(label)}</span>
      <span class="details-value ${modifier}">${esc(value)}</span>
    </div>
  `;
}

// ─── Per-state renderers ────────────────────────────────────────────

export function renderLoading(evidenceId) {
  return /* html */ `
    <div class="card loading">
      ${head(evidenceId)}
      <div class="status">
        <span class="spinner"></span>
        <div class="status-text">
          <p class="status-title">Verifying…</p>
          <p class="status-sub">Fetching the evidence record + JWKS, then running Ed25519 verification client-side.</p>
        </div>
      </div>
      ${footer(evidenceId)}
    </div>
  `;
}

export function renderVerified(evidenceId, result) {
  const r = result.record ?? {};
  return /* html */ `
    <div class="card verified">
      ${head(evidenceId)}
      <div class="status">
        ${ICONS.verified}
        <div class="status-text">
          <p class="status-title">VERIFIED</p>
          <p class="status-sub">Ed25519 signature valid · canonical hash matched · key resolved from public JWKS.</p>
        </div>
      </div>
      <div class="details">
        ${detailsRow("Decision", String(r.action ?? "—").toUpperCase(), "verified")}
        ${detailsRow("Capability", r.capabilityId ?? "—")}
        ${detailsRow("Actor role", r.actorRole ?? "—")}
        ${detailsRow("Signed by", result.resolvedKey?.kid ?? r.signingKeyId ?? "—", "accent")}
        ${detailsRow("Environment", r.environment ?? "—")}
        ${detailsRow("Tenant", r.tenantId ?? "—")}
        ${detailsRow("Signed at", r.createdAt ?? "—")}
        ${detailsRow("Verified at", result.verifiedAt)}
        ${complianceBadges(result.compliance)}
      </div>
      ${footer(evidenceId)}
    </div>
  `;
}

export function renderViolation(evidenceId, result) {
  const r = result.record ?? {};
  return /* html */ `
    <div class="card violation">
      ${head(evidenceId)}
      <div class="status">
        ${ICONS.violation}
        <div class="status-text">
          <p class="status-title">COMPLIANCE VIOLATION</p>
          <p class="status-sub">Signature did NOT verify against the resolved public key. Record is either tampered or signed with the wrong key.</p>
        </div>
      </div>
      <div class="details">
        ${detailsRow("Decision", String(r.action ?? "—").toUpperCase(), "violation")}
        ${detailsRow("Claimed signer", r.signingKeyId ?? "—")}
        ${detailsRow("Capability", r.capabilityId ?? "—")}
        ${result.error ? detailsRow("Detail", result.error, "violation") : ""}
        ${detailsRow("Verified at", result.verifiedAt)}
      </div>
      ${footer(evidenceId)}
    </div>
  `;
}

export function renderLegacyUnsigned(evidenceId, result) {
  const r = result.record ?? {};
  return /* html */ `
    <div class="card legacy">
      ${head(evidenceId)}
      <div class="status">
        ${ICONS.legacy}
        <div class="status-text">
          <p class="status-title">LEGACY UNSIGNED</p>
          <p class="status-sub">Record from a pre-Signed-Evidence-v1 cohort. Audit-trail-only; cryptographic verification is not applicable to records signed before the v1 rollout.</p>
        </div>
      </div>
      <div class="details">
        ${detailsRow("Decision", String(r.action ?? "—").toUpperCase())}
        ${detailsRow("Capability", r.capabilityId ?? "—")}
        ${detailsRow("Verified at", result.verifiedAt)}
      </div>
      ${footer(evidenceId)}
    </div>
  `;
}

export function renderUnsigned(evidenceId, result) {
  const r = result.record ?? {};
  return /* html */ `
    <div class="card unsigned">
      ${head(evidenceId)}
      <div class="status">
        ${ICONS.unsigned}
        <div class="status-text">
          <p class="status-title">UNSIGNED</p>
          <p class="status-sub">Record exists but carries no signature. Cannot be cryptographically verified.</p>
        </div>
      </div>
      <div class="details">
        ${detailsRow("Decision", String(r.action ?? "—").toUpperCase())}
        ${detailsRow("Verified at", result.verifiedAt)}
      </div>
      ${footer(evidenceId)}
    </div>
  `;
}

export function renderNotFound(evidenceId, result) {
  return /* html */ `
    <div class="card notfound">
      ${head(evidenceId)}
      <div class="status">
        ${ICONS.notfound}
        <div class="status-text">
          <p class="status-title">NOT FOUND</p>
          <p class="status-sub">No evidence record with that ID exists in the public proof API.</p>
        </div>
      </div>
      <div class="details">
        ${detailsRow("Verified at", result.verifiedAt)}
      </div>
      ${footer(evidenceId)}
    </div>
  `;
}

export function renderError(evidenceId, result) {
  return /* html */ `
    <div class="card error">
      ${head(evidenceId)}
      <div class="status">
        ${ICONS.error}
        <div class="status-text">
          <p class="status-title">VERIFICATION ERROR</p>
          <p class="status-sub">${esc(result.error ?? "Unknown error")}</p>
        </div>
      </div>
      <div class="details">
        ${detailsRow("Verified at", result.verifiedAt)}
      </div>
      ${footer(evidenceId)}
    </div>
  `;
}

export function render(evidenceId, result) {
  switch (result.verificationStatus) {
    case "VERIFIED": return renderVerified(evidenceId, result);
    case "COMPLIANCE_VIOLATION": return renderViolation(evidenceId, result);
    case "LEGACY_UNSIGNED": return renderLegacyUnsigned(evidenceId, result);
    case "UNSIGNED": return renderUnsigned(evidenceId, result);
    case "NOT_FOUND": return renderNotFound(evidenceId, result);
    case "ERROR":
    default:
      return renderError(evidenceId, result);
  }
}
