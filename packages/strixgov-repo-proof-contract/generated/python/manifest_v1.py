"""
GENERATED FILE — DO NOT EDIT.

Source of truth: schema/repo-proof-manifest-v1.schema.json
Schema sha256:   8aec4c612013700038543fc7dc5ea751e9746b0cdec9a5c675b3103bf75afe71
Regenerate:      node scripts/generate-bindings.mjs

Hand-editing this file is a contract violation (W0-0 Acceptance 1): the
bindings are generated, never independently maintained. CI runs
`--check`, which fails on any divergence in either direction.
"""

from typing import Final, Tuple

SCHEMA_VERSION: Final[str] = "repo-proof-manifest-v1"
SCHEMA_SHA256: Final[str] = "8aec4c612013700038543fc7dc5ea751e9746b0cdec9a5c675b3103bf75afe71"

REQUIRED_TOP_LEVEL: Final[Tuple[str, ...]] = (
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
)

CAPABILITY_RECONCILIATION_GOVERNED_EFFECT_NAMESPACE: Final[Tuple[str, ...]] = (
    "specimen-declared",
    "strix-effect",
)

CAPABILITY_RECONCILIATION_DISPOSITION: Final[Tuple[str, ...]] = (
    "exact",
    "broader",
    "narrower",
    "composite",
    "unresolved",
    "inapplicable",
)

CAPABILITY_RECONCILIATION_PROVENANCE: Final[Tuple[str, ...]] = (
    "derived",
    "manually-reviewed",
    "specimen-declared",
)

PATHS_UNGOVERNED_COMPLETENESS_STATE: Final[Tuple[str, ...]] = (
    "enumerated",
    "not-established",
)

ENFORCEMENT_BOUNDARY_KIND: Final[Tuple[str, ...]] = (
    "separate-process-broker",
    "in-process-hook",
    "host-pre-execution-hook",
    "network-proxy",
    "none",
)

ATTACK_APPLICABILITY_RESULT: Final[Tuple[str, ...]] = (
    "PASSED",
    "FAILED",
    "NOT_ESTABLISHED",
)

ATTACK_APPLICABILITY_SCOPE: Final[Tuple[str, ...]] = (
    "simulated",
    "live",
)
