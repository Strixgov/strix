// Public entry for @strixgov/trust-mark-embed.
//
// Two consumption modes:
//   1. <script src="…/trust-mark.js"> on any HTTPS page — auto-registers the
//      <strix-trust-mark> element.
//   2. import { StrixTrustMarkElement, fetchTrustMarkState } from
//      "@strixgov/trust-mark-embed";  (element registers as an import side-effect)

export { StrixTrustMarkElement } from "./web-component.mjs";
export {
  fetchTrustMarkState,
  reduceTrustMarkResponse,
  DEFAULT_PROOF_BASE,
} from "./badge.mjs";
export { render, renderLoading, badgeColors, badgeLabel } from "./templates.mjs";
