// Shadow-DOM CSS for <strix-verify>. All styles are scoped to the
// custom element's shadow tree so they never leak into (or get
// overridden by) the host page's CSS.
//
// Color palette + type stack matches verify.strixgov.com so an embed
// on a third-party site reads as "the same product" without needing
// the host page to import any external CSS.

export const STYLES = /* css */ `
  :host {
    /* Tokens — overridable via CSS custom properties on the host */
    --sv-bg: #060B18;
    --sv-surface: #0C1425;
    --sv-surface-lifted: #111B30;
    --sv-border: rgba(255,255,255,0.08);
    --sv-fg: #F0F4F8;
    --sv-fg-muted: #B4C0CC;
    --sv-fg-dim: #7D8590;
    --sv-accent: #00BCD4;
    --sv-verified: #3FB950;
    --sv-violation: #F85149;
    --sv-legacy: #D29922;
    --sv-unsigned: #7D8590;
    --sv-font-mono: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
    --sv-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;

    display: block;
    font-family: var(--sv-font-sans);
    color: var(--sv-fg);
    line-height: 1.5;
    contain: layout style;
  }

  .card {
    background: var(--sv-surface);
    border: 1px solid var(--sv-border);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 4px 14px rgba(0,0,0,0.25);
    max-width: 580px;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--sv-border);
    background: var(--sv-surface-lifted);
  }

  .head-left {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--sv-font-mono);
    font-size: 12px;
    color: var(--sv-fg-muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .head-logo {
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
  }

  .head-id {
    font-family: var(--sv-font-mono);
    font-size: 12px;
    color: var(--sv-fg-dim);
  }

  .status {
    padding: 16px 18px;
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .status-icon {
    width: 24px;
    height: 24px;
    flex: 0 0 24px;
    margin-top: 2px;
  }

  .status-text {
    flex: 1;
  }

  .status-title {
    font-size: 16px;
    font-weight: 700;
    margin: 0 0 2px 0;
    letter-spacing: -0.01em;
  }

  .status-sub {
    font-size: 13px;
    color: var(--sv-fg-muted);
    margin: 0;
  }

  /* Outcome-class variants */
  .card.verified .status-title { color: var(--sv-verified); }
  .card.violation .status-title { color: var(--sv-violation); }
  .card.legacy .status-title { color: var(--sv-legacy); }
  .card.unsigned .status-title { color: var(--sv-unsigned); }
  .card.notfound .status-title { color: var(--sv-violation); }
  .card.error .status-title { color: var(--sv-fg-dim); }
  .card.loading .status-title { color: var(--sv-accent); }

  .details {
    padding: 0 18px 16px;
    border-top: 1px solid var(--sv-border);
    padding-top: 14px;
  }

  .details-row {
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 8px;
    font-size: 12px;
    margin-bottom: 6px;
    align-items: baseline;
  }

  .details-label {
    color: var(--sv-fg-dim);
    font-family: var(--sv-font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 10px;
  }

  .details-value {
    color: var(--sv-fg);
    font-family: var(--sv-font-mono);
    font-size: 12px;
    word-break: break-all;
  }

  .details-value.accent { color: var(--sv-accent); }
  .details-value.verified { color: var(--sv-verified); }
  .details-value.violation { color: var(--sv-violation); }

  .compliance {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    padding: 4px 8px;
    border-radius: 4px;
    font: 700 10px/1 var(--sv-font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .pill.ok {
    background: rgba(63,185,80,0.12);
    color: var(--sv-verified);
    border: 1px solid rgba(63,185,80,0.32);
  }

  .pill.no {
    background: rgba(248,81,73,0.08);
    color: var(--sv-violation);
    border: 1px solid rgba(248,81,73,0.24);
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 18px;
    border-top: 1px solid var(--sv-border);
    background: rgba(0,0,0,0.18);
    font-size: 11px;
    font-family: var(--sv-font-mono);
    color: var(--sv-fg-dim);
  }

  .footer a {
    color: var(--sv-accent);
    text-decoration: none;
  }

  .footer a:hover {
    text-decoration: underline;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--sv-fg-dim);
    border-top-color: var(--sv-accent);
    border-radius: 50%;
    animation: sv-spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }

  @keyframes sv-spin {
    to { transform: rotate(360deg); }
  }

  /* Compact mode — collapses details when 'compact' attribute is set */
  :host([compact]) .details,
  :host([compact]) .compliance {
    display: none;
  }

  :host([compact]) .card {
    max-width: 320px;
  }
`;

// Inline SVG logos — the cyan check-in-square verify-strix mark.
export const LOGO_SVG = /* html */ `
  <svg class="head-logo" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="1" y="1" width="30" height="30" rx="6" fill="#0C1425" stroke="#00BCD4" stroke-opacity="0.6"/>
    <circle cx="16" cy="16" r="9" fill="none" stroke="#00BCD4" stroke-width="1.5"/>
    <path d="M11 16 L15 20 L22 12" fill="none" stroke="#00BCD4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

// Per-outcome icons.
export const ICONS = {
  verified: /* html */ `<svg class="status-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="none" stroke="#3FB950" stroke-width="2"/><path d="M7 12.5 L11 16.5 L17 9.5" fill="none" stroke="#3FB950" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  violation: /* html */ `<svg class="status-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="none" stroke="#F85149" stroke-width="2"/><path d="M8 8 L16 16 M16 8 L8 16" fill="none" stroke="#F85149" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  legacy: /* html */ `<svg class="status-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="none" stroke="#D29922" stroke-width="2"/><path d="M12 7 L12 14 M12 16.5 L12 17.5" fill="none" stroke="#D29922" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  unsigned: /* html */ `<svg class="status-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="none" stroke="#7D8590" stroke-width="2"/><path d="M8 12 L16 12" fill="none" stroke="#7D8590" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  notfound: /* html */ `<svg class="status-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="none" stroke="#F85149" stroke-width="2"/><path d="M9 9.5 a3 3 0 0 1 6 0 c0 1.5 -1.5 2 -3 3 M12 17.5 L12 17.51" fill="none" stroke="#F85149" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  error: /* html */ `<svg class="status-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="none" stroke="#7D8590" stroke-width="2"/><path d="M12 7 L12 14 M12 16.5 L12 17.5" fill="none" stroke="#7D8590" stroke-width="2.4" stroke-linecap="round"/></svg>`,
};
