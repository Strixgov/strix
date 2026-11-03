/**
 * @strixgov/governed-egress — Strix Governed AI Egress v0.1 (private pilot
 * package; see README.md for the architecture, claim ceilings, and the
 * Phase-B kernel-binding path).
 *
 * STRIX GOVERNS THE RELEASE, NOT THE DETECTION: detection and
 * transformation are replaceable inputs to the policy decision. The
 * property this package owns is that prohibited data cannot cross the
 * governed boundary, and that the exact artifact authorized is the exact
 * artifact released.
 */
export { sha256Hex, prefixedHash, isBareHash } from './artifact/hash.mjs';
export { ingestArtifact, SUPPORTED_MIME_TYPES, MAX_ARTIFACT_BYTES } from './artifact/ingest.mjs';
export {
  probePdfjsRuntimeReadiness,
  assertPdfjsRuntimeReady,
  REQUIRED_RUNTIME_ASSETS,
} from './artifact/pdfjs-runtime-readiness.mjs';
export {
  PDFJS_SUBSTRATE_STAGES,
  PDF_DOCUMENT_STAGES,
  PDF_EXTRACTION_STAGES,
  PDF_EXTRACTION_STAGE_MEANING,
  OCR_STAGES,
  isPdfExtractionStage,
} from './artifact/pdf-extraction-stages.mjs';
export {
  OCR_LOCALITY,
  OCR_WORD_CONFIDENCE_FLOOR,
  OCR_PAGE_MEAN_CONFIDENCE_FLOOR,
  OCR_MAX_PAGES,
  OCR_PROVES,
  OCR_REFUSAL_CODES,
  assertGovernedOcrEngine,
} from './artifact/governed-ocr.mjs';
export { DETECTION_CATEGORIES, TOKEN_PREFIX } from './detection/categories.mjs';
export { createPatternDetector, scanText, acceptSeed, SEEDABLE_CATEGORIES, DETECTOR_INFO } from './detection/pattern-detector.mjs';
export { SIGNAL_WORD_CEILING, DEFAULT_SIGNAL_TIMEOUT_MS, SIGNAL_DENY_CODES } from './detection/signals.mjs';
export { createHttpDetectionSignal } from './detection/http-signal.mjs';
export {
  createSyntheticTransformer,
  syntheticValueFor,
  SYNTHETIC_ENGINE,
  SYNTHETIC_CATEGORIES,
} from './transformation/synthetic-transformer.mjs';
export {
  createTokenizingTransformer,
  TransformationError,
  TRANSFORM_ENGINE,
} from './transformation/tokenizing-transformer.mjs';
export { verifySanitizedArtifact, containsResidual, maskSpans, VERIFICATION_PROVES, VERIFICATION_INFO } from './verification/verify.mjs';
export {
  validateEgressPolicy,
  categoryAction,
  CATEGORY_ACTIONS,
  replacementMode,
  REPLACEMENT_MODES,
  decideDestination,
  classificationToDataClass,
  PolicyValidationError,
} from './policy/policy.mjs';
export { HEALTHCARE_REFERENCE_POLICY } from './policy/healthcare-reference-policy.mjs';
export {
  mintEgressAuthorization,
  createInMemoryAuthorizationStore,
  bindingAddress,
  DEFAULT_AUTHORIZATION_TTL_MS,
} from './authorization/authorize.mjs';
export { createInMemoryEvidenceLog, verifyEvidenceChain } from './evidence/log.mjs';
export {
  createEvidenceSigner,
  generateEvidenceSigningKey,
  verifySignedEvidence,
  resumePointOf,
  evidenceKeyIdOf,
  evidenceSigningInput,
  EVIDENCE_SIGNATURE_SCHEME,
  SIGNED_EVIDENCE_PROVES,
} from './evidence/signing.mjs';
export { buildEgressReceipt, RECEIPT_PROVES } from './evidence/receipt.mjs';
export { buildRefusalReceipt, REFUSAL_RECEIPT_PROVES } from './evidence/refusal-receipt.mjs';
export {
  buildCovenantEvidenceRecord,
  verifyCovenantRecord,
  COVENANT_TERMS,
  COVENANT_STATUS,
  COVENANT_COVERAGE,
  COVENANT_RECORD_VERSION,
  COVENANT_RECORD_PROVES,
  NOT_ESTABLISHED_REASONS,
} from './evidence/covenant-record.mjs';
export {
  normalizePrincipal,
  PRINCIPAL_IDENTIFIES,
  PRINCIPAL_AUTHENTICATION_METHODS,
} from './evidence/principal.mjs';
export { releaseThroughGate, EGRESS_REFUSAL_CODES } from './egress/gate.mjs';

// ── Phase B: the kernel is the authority ────────────────────────────────
export {
  EGRESS_COMMITMENT_CANON,
  EGRESS_COMMITMENT_FIELDS,
  AUTHORITY_SOURCED_FIELDS,
  MATERIAL_DERIVED_FIELDS,
  canonicalizeEgressCommitment,
  computeEgressCommitment,
  assembleEgressCommitment,
} from './commitment/egress-commitment.mjs';
export { releaseUnderKernelAuthority, KERNEL_EGRESS_REFUSAL_CODES } from './egress/kernel-gate.mjs';
export {
  AUTHORIZED_DECISION_STATES,
  BINDING_REFUSAL_CODES,
  BindingRefusal,
  bindDecisionToEgressAuthority,
  egressCommitmentParamsFromPipeline,
  receiptResultForSignedEvidence,
} from './kernel/production-binding.mjs';
export { governDocumentEgress, PIPELINE_DENY_CODES } from './pipeline.mjs';
export { prepareDocumentForEgress } from './robust-prepare.mjs';
export {
  governedAnthropicDocumentRequest,
  EGRESS_CAPABILITY_ID,
  ANTHROPIC_DESTINATION,
} from './adapters/anthropic/index.mjs';
export {
  createAnthropicMessagesTransport,
  TransportError,
  DEFAULT_ANTHROPIC_MODEL,
  ANTHROPIC_API_VERSION,
} from './adapters/anthropic/transport.mjs';
export {
  governedOpenAiDocumentRequest,
  OPENAI_DESTINATION,
} from './adapters/openai/index.mjs';
export {
  createOpenAiChatTransport,
  TransportError as OpenAiTransportError,
  DEFAULT_OPENAI_MODEL,
} from './adapters/openai/transport.mjs';
export {
  buildReidentificationKey,
  reidentifyResponse,
  reidentificationEvidenceEntry,
  ReidentificationError,
  REIDENTIFICATION_KEY_VERSION,
  REIDENTIFICATION_KEY_VERSION_SYNTHETIC,
  syntheticSurfaces,
  REIDENTIFICATION_PROVES,
} from './reidentification/reidentify.mjs';
export {
  scanModelResponse,
  responseScanEvidenceEntry,
  responseScanMode,
  ResponseScanError,
  RESPONSE_SCAN_PROVES,
  RESPONSE_SCAN_MODES,
} from './response/scan-response.mjs';
export { createEgressProxy, parseChatRequest, ProxyRequestError, PROXY_INFO, MAX_PROXY_BODY_BYTES, MIN_TOKEN_LENGTH } from './proxy/server.mjs';
