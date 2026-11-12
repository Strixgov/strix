# Changelog

## 0.2.0 (2026-11-11, unreleased)

Declaration refusals (issues #2835 / #2836; contract `docs/gates/SE-V1-ALGORITHM-METADATA.md`).

- A record declaring `signatureAlgorithm` other than exactly `"Ed25519"` is refused before the JWKS is fetched: `verificationStatus: "UNVERIFIABLE"`, `verificationReason: "UNSUPPORTED_ALGORITHM"`.
- A record declaring `declaredSchemaVersion` (or, without `signedPayload`, `schemaVersion`) other than `1` / `"1"` is refused before the JWKS is fetched: `verificationStatus: "COMPLIANCE_VIOLATION"`, `verificationReason: "UNSUPPORTED_SCHEMA_VERSION"`. Nothing is normalized into 1.
- Statuses mirror `@strixgov/verifier`; the schema-version reason is named `UNSUPPORTED_SCHEMA_VERSION` here where the Node verifier reports `SIGNED_PAYLOAD_INVALID`.
- A failed signature now carries `verificationReason: "SIGNATURE_INVALID"`.
- The cards for both refusals say the record was refused, not that its signature failed.
- New export: `declarationRefusal(record)`.

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
