// Shadow-DOM CSS for <strix-trust-mark>. Layout only; per-state colors are
// inlined by templates.mjs (and overridable by the host via the data-token attr).
export const STYLES = /* css */ `
  :host { display: inline-block; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .tm-card {
    display: inline-flex; flex-direction: column; gap: 6px;
    border: 1px solid; border-radius: 10px; padding: 10px 12px;
    background: #fff; max-width: 360px;
  }
  .tm-badge {
    display: inline-flex; align-items: center; gap: 7px;
    border-radius: 999px; padding: 4px 10px; font-weight: 600; font-size: 13px;
    width: fit-content;
  }
  .tm-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .tm-dot-loading { background: #94a3b8; animation: tm-pulse 1.1s ease-in-out infinite; }
  @keyframes tm-pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
  .tm-label { white-space: nowrap; }
  .tm-scope { font-size: 12px; color: #475569; }
  .tm-reason { font-size: 11px; color: #64748b; }
  .tm-proof { font-size: 12px; color: #2f81f7; text-decoration: none; width: fit-content; }
  .tm-proof:hover { text-decoration: underline; }
  .tm-verify { font-size: 10.5px; color: #94a3b8; }
  .tm-verify code { font-size: 10.5px; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; color: #334155; }
  .tm-link { text-decoration: none; }
`;
