// <strix-trust-mark> custom element — the consumer one-click trust-mark badge.
//
// Usage on any HTTPS page:
//   <script src="https://verify.strixgov.com/trust-mark.js"></script>
//   <strix-trust-mark grant-id="tm-grant-0001"></strix-trust-mark>
//
// Attributes:
//   grant-id      (required) — the trust-mark grant to resolve
//   proof-base    (optional) — override the status API base URL (testing/forks)
//   compact       (optional, no value) — render a single inline pill
//   auto-refresh  (optional, ms ≥ 30000) — re-resolve every N ms (never-fake-GREEN:
//                 a stale GREEN cannot persist past the route's short cache window)
//
// Programmatic API:
//   const el = document.querySelector('strix-trust-mark');
//   const state = await el.refresh();
//   el.addEventListener('strix-trust-mark:state', (e) => console.log(e.detail));
//
// Render-only: the element renders the verdict the status route produced; it
// never determines one. Independent re-derivation is `npx @strixgov/verifier
// trustmark <grantId>`.

import { fetchTrustMarkState } from "./badge.mjs";
import { render, renderLoading } from "./templates.mjs";
import { STYLES } from "./styles.mjs";

const TAG = "strix-trust-mark";

class StrixTrustMarkElement extends HTMLElement {
  static get observedAttributes() {
    return ["grant-id", "proof-base", "compact", "auto-refresh"];
  }

  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: "open" });
    this._timer = null;
    this._last = null;
    this._busy = false;
  }

  connectedCallback() {
    this._paint(renderLoading());
    if (this.getAttribute("grant-id")) this.refresh();
    this._setupAutoRefresh();
  }

  disconnectedCallback() {
    this._clearAutoRefresh();
  }

  attributeChangedCallback(name, oldV, newV) {
    if (oldV === newV) return;
    if (name === "grant-id" && newV) this.refresh();
    else if (name === "auto-refresh") this._setupAutoRefresh();
    else if (name === "compact") this._renderCurrent();
  }

  async refresh() {
    const grantId = this.getAttribute("grant-id");
    if (!grantId) {
      this._paint(render({ badge: "SLATE", grantId: null, note: "no grant-id" }, this._opts()));
      return null;
    }
    if (this._busy) return this._last;
    this._busy = true;
    try {
      const state = await fetchTrustMarkState(grantId, this._opts());
      this._last = state;
      this._paint(render(state, this._opts()));
      this.dispatchEvent(
        new CustomEvent("strix-trust-mark:state", { detail: state, bubbles: true, composed: true }),
      );
      return state;
    } finally {
      this._busy = false;
    }
  }

  // ── private ──
  _opts() {
    return {
      proofBase: this.getAttribute("proof-base") ?? undefined,
      compact: this.hasAttribute("compact"),
    };
  }

  _renderCurrent() {
    if (this._last) this._paint(render(this._last, this._opts()));
    else this._paint(renderLoading());
  }

  _paint(html) {
    this._shadow.innerHTML = `<style>${STYLES}</style>${html}`;
  }

  _setupAutoRefresh() {
    this._clearAutoRefresh();
    const ms = parseInt(this.getAttribute("auto-refresh") || "0", 10);
    if (Number.isFinite(ms) && ms >= 30000) {
      this._timer = setInterval(() => {
        this.refresh().catch(() => {});
      }, ms);
    }
  }

  _clearAutoRefresh() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get(TAG)) {
  customElements.define(TAG, StrixTrustMarkElement);
}

export { StrixTrustMarkElement };
export default StrixTrustMarkElement;
