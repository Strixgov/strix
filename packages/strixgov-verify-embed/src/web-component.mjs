// <strix-verify> custom element.
//
// Usage on any HTTPS page:
//   <script src="https://verify.strixgov.com/embed.js"></script>
//   <strix-verify evidence-id="5686"></strix-verify>
//
// Attributes:
//   evidence-id    (required) — the evidence record ID to verify
//   proof-base     (optional) — override proof API base URL (testing/forks)
//   jwks-url       (optional) — override JWKS URL (testing/forks)
//   compact        (optional, no value) — render in compact card mode
//   auto-refresh   (optional, milliseconds) — re-verify every N ms (≥30000)
//
// Programmatic API:
//   const el = document.querySelector('strix-verify');
//   const result = await el.verifyNow();
//   el.addEventListener('strix-verify:result', (e) => console.log(e.detail));

import { verify } from "./verifier-browser.mjs";
import { STYLES } from "./styles.mjs";
import { render, renderLoading } from "./templates.mjs";

const TAG = "strix-verify";

class StrixVerifyElement extends HTMLElement {
  static get observedAttributes() {
    return ["evidence-id", "proof-base", "jwks-url", "compact", "auto-refresh"];
  }

  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: "open" });
    this._refreshTimer = null;
    this._lastResult = null;
    this._verifying = false;
  }

  connectedCallback() {
    this._render(); // initial paint (loading state)
    if (this.getAttribute("evidence-id")) {
      this.verifyNow();
    }
    this._setupAutoRefresh();
  }

  disconnectedCallback() {
    this._clearAutoRefresh();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === "evidence-id" && newValue) {
      this.verifyNow();
    } else if (name === "auto-refresh") {
      this._setupAutoRefresh();
    } else if (name === "compact") {
      // Just trigger a re-render with current result.
      this._renderCurrent();
    }
  }

  /**
   * Public programmatic API. Returns the verification result.
   * Fires a `strix-verify:result` custom event with the result in `detail`.
   */
  async verifyNow() {
    const evidenceId = this.getAttribute("evidence-id");
    if (!evidenceId) {
      this._renderRaw(renderLoading("(no evidence-id)"));
      return null;
    }
    if (this._verifying) return this._lastResult;

    this._verifying = true;
    this._renderRaw(renderLoading(evidenceId));

    const proofBase = this.getAttribute("proof-base") ?? undefined;
    const jwksUrl = this.getAttribute("jwks-url") ?? undefined;

    try {
      const result = await verify(evidenceId, { proofBase, jwksUrl });
      this._lastResult = result;
      this._renderRaw(render(evidenceId, result));
      this.dispatchEvent(
        new CustomEvent("strix-verify:result", {
          detail: result,
          bubbles: true,
          composed: true,
        }),
      );
      return result;
    } catch (err) {
      // Catastrophic catch (shouldn't normally fire — verify() returns an
      // error-shaped result rather than throwing).
      const result = {
        evidenceId,
        verificationStatus: "ERROR",
        error: `Unhandled: ${err?.message ?? err}`,
        verifiedAt: new Date().toISOString(),
      };
      this._lastResult = result;
      this._renderRaw(render(evidenceId, result));
      return result;
    } finally {
      this._verifying = false;
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  _render() {
    const evidenceId = this.getAttribute("evidence-id") ?? "(loading)";
    this._renderRaw(renderLoading(evidenceId));
  }

  _renderCurrent() {
    if (this._lastResult) {
      const evidenceId = this.getAttribute("evidence-id");
      this._renderRaw(render(evidenceId, this._lastResult));
    } else {
      this._render();
    }
  }

  _renderRaw(html) {
    this._shadow.innerHTML = `<style>${STYLES}</style>${html}`;
  }

  _setupAutoRefresh() {
    this._clearAutoRefresh();
    const ms = parseInt(this.getAttribute("auto-refresh") || "0", 10);
    if (Number.isFinite(ms) && ms >= 30000) {
      this._refreshTimer = setInterval(() => {
        this.verifyNow().catch(() => {});
      }, ms);
    }
  }

  _clearAutoRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}

// Register once. Safe to load the script multiple times on the same page.
if (typeof customElements !== "undefined" && !customElements.get(TAG)) {
  customElements.define(TAG, StrixVerifyElement);
}

export { StrixVerifyElement };
export default StrixVerifyElement;
