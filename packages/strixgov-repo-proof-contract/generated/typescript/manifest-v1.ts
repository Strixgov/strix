/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: schema/repo-proof-manifest-v1.schema.json
 * Schema sha256:   8aec4c612013700038543fc7dc5ea751e9746b0cdec9a5c675b3103bf75afe71
 * Regenerate:      node scripts/generate-bindings.mjs
 *
 * Hand-editing this file is a contract violation (W0-0 Acceptance 1): the
 * bindings are generated, never independently maintained. CI runs
 * `--check`, which fails on any divergence in either direction.
 */

export const SCHEMA_VERSION = "repo-proof-manifest-v1" as const;
export const SCHEMA_SHA256 = "8aec4c612013700038543fc7dc5ea751e9746b0cdec9a5c675b3103bf75afe71" as const;

export const REQUIRED_TOP_LEVEL = [
  "schemaVersion",
  "subject",
  "selectedEffect",
  "capabilityReconciliation",
  "paths",
  "enforcementBoundary",
  "credentialHolders",
  "attackApplicability",
  "evidenceSources",
  "claimCeiling",
] as const;

export type CapabilityReconciliationGovernedEffectNamespace =
  | "specimen-declared"
  | "strix-effect";

export type CapabilityReconciliationDisposition =
  | "exact"
  | "broader"
  | "narrower"
  | "composite"
  | "unresolved"
  | "inapplicable";

export type CapabilityReconciliationProvenance =
  | "derived"
  | "manually-reviewed"
  | "specimen-declared";

export type PathsUngovernedCompletenessState =
  | "enumerated"
  | "not-established";

export type EnforcementBoundaryKind =
  | "separate-process-broker"
  | "in-process-hook"
  | "host-pre-execution-hook"
  | "network-proxy"
  | "none";

export type AttackApplicabilityResult =
  | "PASSED"
  | "FAILED"
  | "NOT_ESTABLISHED";

export type AttackApplicabilityScope =
  | "simulated"
  | "live";

