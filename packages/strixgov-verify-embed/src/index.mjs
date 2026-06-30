// Public entry for @strixgov/verify-embed.
//
// Two consumption modes:
//
// 1. As a <script src="…/embed.js"> tag on any HTTPS page:
//      The element auto-registers under the tag name `strix-verify`.
//      Drop in `<strix-verify evidence-id="5686"></strix-verify>` anywhere.
//
// 2. As a module import (npm package consumers):
//      import { StrixVerifyElement, verify } from "@strixgov/verify-embed";
//      The element is auto-registered as a side-effect of importing.

export { StrixVerifyElement } from "./web-component.mjs";
export {
  verify,
  buildCanonicalPayload,
  deriveComplianceFlags,
  DEFAULT_PROOF_BASE,
  DEFAULT_JWKS_URL,
} from "./verifier-browser.mjs";
