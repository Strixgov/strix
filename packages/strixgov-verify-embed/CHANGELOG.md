# Changelog

## 0.1.0 (2026-05-31)

Initial release.

- `<strix-verify>` custom element — drop-in verification card for any HTTPS page.
- Programmatic `verify()` API for direct calls without a DOM element.
- WebCrypto Ed25519 verification — runs entirely client-side.
- Byte-for-byte canonical-payload reconstruction mirroring `@strixgov/verifier`.
- EU AI Act compliance flag derivation (Article 12 / 14 / 28) following the CI-5 / SE-18 "derived not asserted" invariant.
- Shadow-DOM-scoped styles with CSS custom property overrides.
- Compact + auto-refresh attribute modes.
- Six verification outcomes: VERIFIED, COMPLIANCE_VIOLATION, UNSIGNED, LEGACY_UNSIGNED, NOT_FOUND, ERROR.
- Bundle size: 8.6 KB gzipped (under the 15 KB budget).
- Hosted at `https://verify.strixgov.com/embed.js`.
