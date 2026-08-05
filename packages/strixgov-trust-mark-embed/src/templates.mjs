// HTML template generators for the four trust-mark badge states. Pure functions.
// Render-only: these consume the verdict reduced from the status route; they
// never compute it.

const LABELS = {
  GREEN: "Governed by Strix — verified live",
  RED: "Trust mark not valid",
  YELLOW: "Cannot verify right now",
  SLATE: "No trust mark",
};

// Semantic color tokens (ADR-017 tri-state family). The host page may override
// via CSS custom properties; these are the defaults.
const COLORS = {
  GREEN: { fg: "#0b6b3a", bg: "#e7f6ec", dot: "#1a9d57", token: "positive" },
  RED: { fg: "#8a1c1c", bg: "#fdeaea", dot: "#d23a3a", token: "negative" },
  YELLOW: { fg: "#7a5b00", bg: "#fdf6e3", dot: "#d9a400", token: "caution" },
  SLATE: { fg: "#475569", bg: "#f1f5f9", dot: "#94a3b8", token: "neutral" },
};

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function badgeColors(badge) {
  return COLORS[badge] ?? COLORS.YELLOW;
}

export function badgeLabel(badge) {
  return LABELS[badge] ?? LABELS.YELLOW;
}

export function renderLoading() {
  return /* html */ `
    <div class="tm-badge tm-loading" role="status" aria-live="polite">
      <span class="tm-dot tm-dot-loading"></span>
      <span class="tm-label">Checking trust mark…</span>
    </div>
  `;
}

/**
 * Render a resolved badge state.
 * @param {ReturnType<import('./badge.mjs').reduceTrustMarkResponse>} state
 * @param {object} [opts]
 * @param {string} [opts.proofBase]
 * @param {boolean} [opts.compact]
 */
export function render(state, opts = {}) {
  const proofBase = opts.proofBase ?? "https://www.strixgov.com";
  const c = badgeColors(state.badge);
  const label = badgeLabel(state.badge);
  const grantId = state.grantId;
  const proofUrl = grantId ? `${proofBase}/proof/trustmark/${encodeURIComponent(grantId)}` : null;

  const scopeLine =
    state.surfaceOrigin || state.markClass
      ? /* html */ `<div class="tm-scope">${esc(state.markClass ?? "")}${
          state.markClass && state.surfaceOrigin ? " · " : ""
        }${esc(state.surfaceOrigin ?? "")}</div>`
      : "";

  // The reason line is shown for non-GREEN so a consumer sees WHY (honest).
  const reason = state.note ?? state.verificationReason ?? null;
  const reasonLine =
    state.badge !== "GREEN" && reason ? /* html */ `<div class="tm-reason">${esc(reason)}</div>` : "";

  const verifyCmd = grantId
    ? /* html */ `<div class="tm-verify">verify it yourself: <code>npx @strixgov/verifier trustmark ${esc(grantId)}</code></div>`
    : "";

  const inner = /* html */ `
    <span class="tm-dot" style="background:${c.dot}"></span>
    <span class="tm-label">${esc(label)}</span>
  `;

  if (opts.compact) {
    const badge = /* html */ `<span class="tm-badge tm-${state.badge.toLowerCase()}" style="color:${c.fg};background:${c.bg}" data-token="${c.token}">${inner}</span>`;
    return proofUrl
      ? `<a class="tm-link" href="${esc(proofUrl)}" target="_blank" rel="noopener" title="${esc(label)}">${badge}</a>`
      : badge;
  }

  return /* html */ `
    <div class="tm-card tm-${state.badge.toLowerCase()}" style="border-color:${c.dot}">
      <div class="tm-badge" style="color:${c.fg};background:${c.bg}" data-token="${c.token}">
        ${inner}
      </div>
      ${scopeLine}
      ${reasonLine}
      ${
        proofUrl
          ? `<a class="tm-proof" href="${esc(proofUrl)}" target="_blank" rel="noopener">View proof ↗</a>`
          : ""
      }
      ${verifyCmd}
    </div>
  `;
}
